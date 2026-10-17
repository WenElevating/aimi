import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseClientFrame,
  type ErrorFrame,
  type FrameErrorCode,
  type HelloFrame,
  type SessionCommandFrame,
  type SessionCreateFrame,
} from "@aimi/protocol";
import { AgentRegistry } from "../agents/registry.js";
import { ClaudeAdapter } from "../agents/claude/claudeAdapter.js";
import { AuditWriter } from "../audit/auditWriter.js";
import { DefaultAuthenticator, type DeviceIdentity } from "../auth/authenticator.js";
import { ConfigProvisioner } from "../auth/configProvisioner.js";
import { EventBus } from "../events/eventBus.js";
import { UiFanout } from "../events/uiFanout.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { openMigrated } from "../persistence/sqlite/migrate.js";
import { SqliteConversationRepository } from "../persistence/sqlite/sqliteConversationRepository.js";
import {
  SqliteAuditRepository,
  SqliteCommandDedupRepository,
  SqliteDeviceRepository,
} from "../persistence/sqlite/sqliteRepositories.js";
import { PhoneCommandPipe } from "../session/commands.js";
import { SessionManager } from "../session/sessionManager.js";
import type { Conveyor } from "../transport/conveyor.js";
import { LanWsServer } from "../transport/ws/lanServer.js";
import type { ServerConfig } from "./config.js";

/**
 * `session.command` mid-dispatch 失败后的 at-most-once 提示（评审必办）：
 * `PhoneCommandPipe` 在分发**之前**就已记 `clientId`，故失败后同 `clientId` 重发会被去重吞掉、
 * 不会补执行——error 帧必须把这一点告诉手机，否则它会以为「重试即补救」。
 */
const AT_MOST_ONCE_NOTE = "；（同 clientId 重发会被幂等去重吞掉，不会补执行——at-most-once）";

/** 构造一条 error 帧（唯一形态，避免各处手写字段漂移）。 */
function errorFrame(code: FrameErrorCode, message: string): ErrorFrame {
  return { v: 1, type: "error", code, message };
}

/** 把异常收敛为可读消息（不抛）。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 单条连接的装配期状态：hello 前把抢跑帧暂存，鉴权完成后再按序放行。
 * `identity === null` 表示尚未鉴权（hello 未完成）；`helloSeen` 防重复触发鉴权。
 */
interface ConnectionState {
  identity: DeviceIdentity | null;
  helloSeen: boolean;
  buffered: unknown[];
}

/**
 * 应用装配根（§5.2）：`start()` 依「依赖方向」自底向上接线并监听 LAN；
 * `close()` 逆序优雅关停。本类是**唯一**知道全部模块如何拼装的人，
 * 也是 WS 会话生命周期（hello→welcome→create→事件流→command）的唯一编排处。
 *
 * 接线顺序（即依赖方向，§5.2，冻结）：
 * logger → Sqlite 四仓储 → AuditWriter → ConfigProvisioner → DefaultAuthenticator →
 * AgentRegistry(+ClaudeAdapter) → EventBus(subscribe persist) → UiFanout →
 * SessionManager → 启动恢复（listSessions → adopt + seed seq）→ LanWsServer.listen。
 *
 * 传输层不做业务：`onConnection` 只把原始帧交给本类的 parse/分支，业务全在下游模块。
 * **token 吊销（M0）**：仅对**新连接**生效（hello 时校验一次）；活连接即时断开属 M1 逐帧校验范畴。
 */
export class Application {
  readonly #cfg: ServerConfig;

  #logger!: Logger;
  #db!: ReturnType<typeof openMigrated>;
  #conversations!: SqliteConversationRepository;
  #devices!: SqliteDeviceRepository;
  #dedup!: SqliteCommandDedupRepository;
  #audit!: AuditWriter;
  #auth!: DefaultAuthenticator;
  #registry!: AgentRegistry;
  #bus!: EventBus;
  #fanout!: UiFanout;
  #sessions!: SessionManager;
  #pipe!: PhoneCommandPipe;
  #server!: LanWsServer;

  #assembled = false;
  #closing: Promise<void> | null = null;

  /**
   * @param cfg 已加载配置（`app/config.ts` 的产物；测试可直构 —— 端口 `0` 走随机分配）。
   */
  constructor(cfg: ServerConfig) {
    this.#cfg = cfg;
  }

  /**
   * 装配全部模块并开始 LAN 监听。
   * @returns `{ port }`：实际监听端口（配置 `0` 时为 OS 分配值）。
   * @throws 重复调用（`application already started`）；或任意装配步骤的原始异常（此时需 `close()` 收尾）。
   */
  async start(): Promise<{ port: number }> {
    if (this.#assembled) throw new Error("application already started");
    this.#logger = createLogger("aimi-server", this.#cfg.logDir, this.#cfg.logLevel);

    // 基础层：Sqlite 四仓储共享同一已迁移连接（连接生命周期由本类持有）。
    mkdirSync(this.#cfg.dataDir, { recursive: true });
    this.#db = openMigrated(join(this.#cfg.dataDir, "aimi.db"));
    this.#conversations = new SqliteConversationRepository(this.#db);
    this.#devices = new SqliteDeviceRepository(this.#db);
    this.#dedup = new SqliteCommandDedupRepository(this.#db);
    const auditRepo = new SqliteAuditRepository(this.#db);
    this.#audit = new AuditWriter(auditRepo);

    // 鉴权：先供凭证（M0 配对替代），再拿校验器。
    const provisioner = new ConfigProvisioner(this.#devices, join(this.#cfg.dataDir, "lan-token.txt"));
    await provisioner.ensureLanToken();
    this.#auth = new DefaultAuthenticator(this.#devices, this.#audit);

    // agents：注册 claude；logger 注入让 dispose 超时 WARN 有出口（T10 评审必办）。
    this.#registry = new AgentRegistry({ logger: this.#logger });
    this.#registry.register(new ClaudeAdapter({ logger: this.#logger }));

    // 事件总线：持久化路接 Conversations.appendEvent（seq 唯一权威在总线）；ui 路由由 UiFanout 独占。
    this.#bus = new EventBus({ logger: this.#logger });
    this.#bus.subscribe({
      persist: (rec) => this.#conversations.appendEvent(rec.sessionId, rec.seq, rec.agentEvent, rec.ts),
    });
    this.#fanout = new UiFanout(this.#bus);

    // 会话编排：装配层传入查找面；随后逐会话启动恢复（登记 archived + 播种 seq）。
    this.#sessions = new SessionManager({
      conversations: this.#conversations,
      bus: this.#bus,
      agents: this.#registry.lookup(),
      logger: this.#logger,
    });
    for (const meta of await this.#conversations.listSessions()) {
      await this.#sessions.adopt(meta);
    }
    this.#pipe = new PhoneCommandPipe({
      sessions: this.#sessions,
      bus: this.#bus,
      dedup: this.#dedup,
      audit: this.#audit,
    });

    // 接入层：LAN WS 监听 + 会话生命周期编排。
    this.#server = new LanWsServer({ port: this.#cfg.port });
    this.#server.onConnection((conveyor, remote) => { this.#handleConnection(conveyor, remote); });
    const port = await this.#server.listen();

    this.#assembled = true;
    this.#logger.info("aimi-server listening", { port, dataDir: this.#cfg.dataDir });
    return { port };
  }

  /**
   * 优雅关停（幂等）：WS 收口 → 停会话（释放 agent 子进程）→ 冲刷聚合 → 关库。
   * 追加「停会话」一步（超出简报列出的三步）：终态句柄残留（T9 备案），不主动停会遗留孤儿子进程。
   * @returns 全部收口完成；重复调用返回同一 Promise。
   */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    if (!this.#assembled) return;
    await this.#server.close();
    // 停会话：非终态会话 dispose（子进程回收）；已终态为 no-op。失败不阻断收尾。
    for (const meta of await this.#conversations.listSessions()) {
      try {
        await this.#sessions.stop(meta.id);
      } catch (err) {
        this.#logger.warn("session stop on shutdown failed", { sessionId: meta.id, error: errorMessage(err) });
      }
    }
    await this.#bus.flush();
    this.#db.close();
  }

  /** 接纳一条入站连接：登记关闭回调（摘除广播）+ 挂帧回调（hello 门 + 后续分发）。 */
  #handleConnection(conveyor: Conveyor, remote: string): void {
    const state: ConnectionState = { identity: null, helloSeen: false, buffered: [] };
    conveyor.onClose(() => { this.#fanout.detach(conveyor); });
    conveyor.onFrame((raw) => { this.#onFrame(conveyor, remote, state, raw); });
  }

  /**
   * 逐帧入口：鉴权前只认 hello（其余一律 `protocol.bad_frame` + close）；
   * 鉴权后交给 `#dispatch`。鉴权在途时到达的帧暂存，`welcome` 后按序放行。
   */
  #onFrame(conveyor: Conveyor, remote: string, state: ConnectionState, raw: unknown): void {
    if (state.identity !== null) {
      this.#dispatch(conveyor, state.identity, raw);
      return;
    }
    if (state.helloSeen) {
      state.buffered.push(raw);
      return;
    }
    const frame = parseClientFrame(raw);
    if (frame === null || frame.type !== "hello") {
      conveyor.send(errorFrame("protocol.bad_frame", "首帧必须是 hello"));
      void conveyor.close("protocol.bad_frame");
      return;
    }
    state.helloSeen = true;
    void this.#completeHello(conveyor, remote, state, frame);
  }

  /** hello 校验 → 失败发 `auth.invalid_token` + close；成功挂广播 + 回 `welcome` + 放行暂存帧。 */
  async #completeHello(conveyor: Conveyor, remote: string, state: ConnectionState, hello: HelloFrame): Promise<void> {
    const identity = await this.#auth.verifyToken(hello.token, remote);
    if (identity === null) {
      conveyor.send(errorFrame("auth.invalid_token", "token 校验失败"));
      await conveyor.close("auth.invalid_token");
      return;
    }
    if (conveyor.state !== "open") return; // 鉴权期间连接已断：不挂广播、不废话。
    state.identity = identity;
    this.#fanout.attach(conveyor);
    const sessions = await this.#conversations.listSessions();
    conveyor.send({ v: 1, type: "welcome", serverVersion: this.#cfg.serverVersion, sessions });
    for (const raw of state.buffered.splice(0)) this.#dispatch(conveyor, identity, raw);
  }

  /** 已鉴权帧分发：ping→pong；create→建会话+ack；command→命令管道；其余/解析失败→`protocol.bad_frame`。 */
  #dispatch(conveyor: Conveyor, identity: DeviceIdentity, raw: unknown): void {
    const frame = parseClientFrame(raw);
    if (frame === null) {
      conveyor.send(errorFrame("protocol.bad_frame", "帧解析失败"));
      return;
    }
    switch (frame.type) {
      case "ping":
        conveyor.send({ v: 1, type: "pong", nonce: frame.nonce });
        return;
      case "session.create":
        void this.#handleCreate(conveyor, frame);
        return;
      case "session.command":
        void this.#handleCommand(conveyor, identity, frame);
        return;
      case "hello":
        // 已鉴权后重复 hello：非契约时序，按坏帧处理。
        conveyor.send(errorFrame("protocol.bad_frame", "重复 hello"));
        return;
    }
  }

  /** `session.create`：成功回 ack；`agent_missing`→`session.agent_missing`；其余→`server.busy`（message 原文）。 */
  async #handleCreate(conveyor: Conveyor, frame: SessionCreateFrame): Promise<void> {
    try {
      const meta = await this.#sessions.create(frame.spec, "new");
      conveyor.send({ v: 1, type: "ack", sessionId: meta.id });
    } catch (err) {
      const message = errorMessage(err);
      const code: FrameErrorCode = /agent_missing/.test(message) ? "session.agent_missing" : "server.busy";
      conveyor.send(errorFrame(code, message));
    }
  }

  /**
   * `session.command`：交给命令管道（幂等+审计+分发）。
   * 异常映射（冻结）：`/session not found|not resumable/`→`session.not_found`；`/not active/`→静默
   * （notice 已入事件流）；其余→`server.busy`。error 帧 message 附 at-most-once 提示。
   */
  async #handleCommand(conveyor: Conveyor, identity: DeviceIdentity, frame: SessionCommandFrame): Promise<void> {
    try {
      await this.#pipe.handle(frame, identity);
    } catch (err) {
      const message = errorMessage(err);
      // "not active" 由 PhoneCommandPipe 以 notice 入流（不抛）——此处仅防御性静默。
      if (/not active/.test(message)) return;
      const code: FrameErrorCode = /session not found|not resumable/.test(message)
        ? "session.not_found"
        : "server.busy";
      conveyor.send(errorFrame(code, message + AT_MOST_ONCE_NOTE));
    }
  }
}
