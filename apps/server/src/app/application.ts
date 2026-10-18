import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseClientFrame,
  type ErrorFrame,
  type FrameErrorCode,
  type HelloFrame,
  type ReplayCursor,
  type SessionCommandFrame,
  type SessionCreateFrame,
} from "@aimi/protocol";
import { AgentRegistry } from "../agents/registry.js";
import { ClaudeAdapter } from "../agents/claude/claudeAdapter.js";
import { AuditWriter } from "../audit/auditWriter.js";
import { DefaultAuthenticator, type DeviceIdentity } from "../auth/authenticator.js";
import { ConfigProvisioner } from "../auth/configProvisioner.js";
import { EventBus } from "../events/eventBus.js";
import { ReplayGate, UiFanout } from "../events/uiFanout.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { openMigrated } from "../persistence/sqlite/migrate.js";
import { SqliteConversationRepository } from "../persistence/sqlite/sqliteConversationRepository.js";
import {
  SqliteAuditRepository,
  SqliteCommandDedupRepository,
  SqliteDeviceRepository,
  SqliteMetaRepository,
  SqliteProcessLedgerRepository,
} from "../persistence/sqlite/sqliteRepositories.js";
import type { MetaRepository } from "../persistence/types.js";
import { PhoneCommandPipe } from "../session/commands.js";
import { reapOrphans } from "../session/processReaper.js";
import { SessionManager } from "../session/sessionManager.js";
import type { Conveyor } from "../transport/conveyor.js";
import { LanWsServer } from "../transport/ws/lanServer.js";
import type { ServerConfig } from "./config.js";

/**
 * `session.command` 分发失败后的 at-most-once 提示：
 * `PhoneCommandPipe` 在分发**之前**就已记 `clientId`，故失败后同 `clientId` 重发会被去重吞掉、
 * 不会补执行——error 帧必须把这一点告诉手机，否则它会以为「重试即补救」。
 */
const AT_MOST_ONCE_NOTE = "；（同 clientId 重发会被幂等去重吞掉，不会补执行——at-most-once）";

/**
 * 单会话单连接的缺口重放硬上限（条，per-session 口径）：超过则放弃逐帧、降级为一条超限
 * notice（§5.3 第 3 步）。why 10_000：一次断线补齐的量级护栏（≈数小时高强度回合的事件量），
 * 防异常堆积把单条连接的 hello→重放窗口拖成分钟级阻塞并挤占广播路；常量导出供测试与
 * S3 手机端按同一契约值对齐，禁裸魔数散落。
 */
export const REPLAY_HARD_CAP = 10_000;

/** 重放分页页长（条）：分页点查循环取完，避免单次大查询的长尾与内存尖峰。 */
const REPLAY_PAGE_SIZE = 500;

/**
 * 构造一条 error 帧（唯一形态，避免各处手写字段漂移）。
 *
 * @param code - 协议已定义的错误码取值之一，不得使用枚举之外的自造值
 * @param message - 展示给手机的错误说明
 * @returns 可直接发送的 error 帧
 */
function errorFrame(code: FrameErrorCode, message: string): ErrorFrame {
  return { v: 1, type: "error", code, message };
}

/**
 * 把任意抛出物收敛为可读消息，自身绝不抛出。
 *
 * @param err - 捕获到的异常
 * @returns Error 取其 message，其余取字符串化结果
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 单条连接的装配期状态：hello 前把抢跑帧暂存，鉴权完成后再按序放行。
 * `identity === null` 表示尚未鉴权（hello 未完成）；`helloSeen` 防重复触发鉴权。
 */
interface ConnectionState {
  /** 已鉴权设备；null 表示 hello 尚未完成 */
  identity: DeviceIdentity | null;
  /** hello 已受理标记：置位后到达的帧进入暂存，防止重复触发鉴权 */
  helloSeen: boolean;
  /** 鉴权在途时抢跑到达的原始帧，welcome 后按序放行 */
  buffered: unknown[];
}

/**
 * 应用装配根：`start()` 依「依赖方向」自底向上接线并监听 LAN；
 * `close()` 逆序优雅关停。本类是**唯一**知道全部模块如何拼装的人，
 * 也是 WS 会话生命周期（hello、welcome、create、事件流、command）的唯一编排处。
 *
 * 接线顺序（即依赖方向）：
 * logger、Sqlite 仓储组（含共享连接上的进程台账与 meta_kv 键值）、AuditWriter、ConfigProvisioner、
 * DefaultAuthenticator、AgentRegistry(+ClaudeAdapter，协议失败标灰回调)、
 * EventBus（订阅 persist）、UiFanout、SessionManager（注入台账）、启动孤儿清点（reapOrphans）、
 * 启动恢复（listSessions 后 adopt 并播种 seq）、LanWsServer.listen。
 *
 * 传输层不做业务：`onConnection` 只把原始帧交给本类的 parse/分支，业务全在下游模块。
 * **token 吊销**：仅对**新连接**生效（握手时校验一次）；已建立的连接不会因吊销而立即断开。
 * **断连缺口重放**：`hello.resume` 非 null 的连接在 welcome 后按光标补齐历史
 * （快照切点 settle → 逐会话 count+分页直发 → 超限降级 notice → 开闸放行排队帧），
 * 详见 `#replayGap`。
 */
export class Application {
  readonly #cfg: ServerConfig;

  #logger!: Logger;
  #db!: ReturnType<typeof openMigrated>;
  #conversations!: SqliteConversationRepository;
  #ledger!: SqliteProcessLedgerRepository;
  #devices!: SqliteDeviceRepository;
  #dedup!: SqliteCommandDedupRepository;
  #meta!: MetaRepository;
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
   * @param cfg - 已加载配置；测试可直构 —— 端口 `0` 走随机分配
   */
  constructor(cfg: ServerConfig) {
    this.#cfg = cfg;
  }

  /**
   * 装配全部模块并开始 LAN 监听。
   *
   * @returns Promise，resolve 为 `{ port }`——实际监听端口（配置 `0` 时为 OS 分配值）
   * @throws 重复调用（`application already started`）；或任意装配步骤的原始异常
   * 副作用：创建数据/日志目录、打开数据库、生成或复用 LAN 令牌、注册全部路由与适配器、绑定监听端口；
   * 中途失败时已取得的资源需由 `close()` 释放
   */
  async start(): Promise<{ port: number }> {
    if (this.#assembled) throw new Error("application already started");
    this.#logger = createLogger("aimi-server", this.#cfg.logDir, this.#cfg.logLevel);

    // 基础层：Sqlite 仓储共享同一已迁移连接（连接生命周期由本类持有）。
    mkdirSync(this.#cfg.dataDir, { recursive: true });
    this.#db = openMigrated(join(this.#cfg.dataDir, "aimi.db"));
    this.#conversations = new SqliteConversationRepository(this.#db);
    this.#ledger = new SqliteProcessLedgerRepository(this.#db);
    this.#devices = new SqliteDeviceRepository(this.#db);
    this.#dedup = new SqliteCommandDedupRepository(this.#db);
    this.#meta = new SqliteMetaRepository(this.#db);
    const auditRepo = new SqliteAuditRepository(this.#db);
    this.#audit = new AuditWriter(auditRepo);

    // 鉴权：先供凭证，再拿校验器。
    const provisioner = new ConfigProvisioner(this.#devices, join(this.#cfg.dataDir, "lan-token.txt"));
    await provisioner.ensureLanToken();
    this.#auth = new DefaultAuthenticator(this.#devices, this.#audit);

    // agents：注册 claude；协议探测失败经回调标灰（进程内内存态，重启即清空）。
    this.#registry = new AgentRegistry({ logger: this.#logger });
    this.#registry.register(new ClaudeAdapter({
      logger: this.#logger,
      onProtocolFailure: () => this.#registry.gray("claude", "适配器协议未确认（30s 内未收到 initialize 应答）"),
    }));

    // 事件总线：持久化路接 Conversations.appendEvent（seq 唯一权威在总线）；ui 路由由 UiFanout 独占。
    this.#bus = new EventBus({ logger: this.#logger });
    this.#bus.subscribe({
      persist: (rec) => this.#conversations.appendEvent(rec.sessionId, rec.seq, rec.agentEvent, rec.ts),
    });
    this.#fanout = new UiFanout(this.#bus);

    // 会话编排：装配层传入查找面与台账；随后孤儿清点、逐会话启动恢复（认领并播种 seq）。
    this.#sessions = new SessionManager({
      conversations: this.#conversations,
      bus: this.#bus,
      agents: this.#registry.lookup(),
      ledger: this.#ledger,
      logger: this.#logger,
    });

    // 启动孤儿清点（F5 防线）：台账 pid 身份不匹配即杀、滞留行一律清；清点失败不拦启动
    // （台账故障不应放大为整窗不可用——会话收尾另有 dispose-清台账的主防线）。
    try {
      const reaped = await reapOrphans({ ledger: this.#ledger, log: this.#logger, audit: this.#audit });
      this.#logger.info("orphan reaper done", { reaped });
    } catch (err) {
      this.#logger.warn("orphan reaper failed", { error: errorMessage(err) });
    }

    for (const meta of await this.#conversations.listSessions()) {
      // 认领带续接线索：hint 有 → resumable（可续跑），无 → archived（历史可查不可续跑）。
      await this.#sessions.adopt(meta, await this.#conversations.getSessionHint(meta.id));
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
   * 优雅关停（幂等）：先收口 WS，再停会话（释放 agent 子进程），接着冲刷聚合，最后关库。
   * 追加「停会话」一步（除网络收口之外）：终态句柄若残留，不主动停会遗留孤儿子进程。
   * **资源粒度收尾**：判据是「已取得的资源」而非 `#assembled`——DB 在 `listen()`
   * 之前就已打开，部分启动失败（如 `EADDRINUSE`）后 `close()` 仍须释放已开资源。
   * **logger 兜底**：收尾路径的日志一律经 `#safeLog`，日志写失败不得中断
   * `bus.flush`/`db.close`（日志门面的契约已声明写失败由装配层兜住）。
   *
   * @returns Promise，resolve 表示全部收口完成；重复调用返回同一 Promise
   */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    const server = this.#server;
    const db = this.#db;
    // 两个「资源存在即需关」的核心句柄都没有，说明从未装配成功过，空转返回。
    if (server === undefined && db === undefined) return;

    // 关停入口留痕（经 #safeLog：日志出口不可用也不得中断收尾）。
    this.#safeLog("info", "aimi-server shutting down", { dataDir: this.#cfg.dataDir });

    if (server !== undefined) {
      // listen 失败后 wss 未必处于 running：close 可能以错误回调拒绝——吞掉，DB 仍需关闭。
      try {
        await server.close();
      } catch (err) {
        this.#safeLog("warn", "server close failed", { error: errorMessage(err) });
      }
    }

    // 停会话：非终态会话 dispose（子进程回收）；已终态为 no-op。整段兜底，保证后续 flush/close 必达。
    const sessions = this.#sessions;
    const conversations = this.#conversations;
    if (sessions !== undefined && conversations !== undefined) {
      try {
        for (const meta of await conversations.listSessions()) {
          try {
            await sessions.stop(meta.id);
          } catch (err) {
            this.#safeLog("warn", "session stop on shutdown failed", { sessionId: meta.id, error: errorMessage(err) });
          }
        }
      } catch (err) {
        this.#safeLog("warn", "session teardown on shutdown failed", { error: errorMessage(err) });
      }
    }

    const bus = this.#bus;
    if (bus !== undefined) {
      try {
        await bus.flush();
      } catch (err) {
        this.#safeLog("warn", "event bus flush on shutdown failed", { error: errorMessage(err) });
      }
    }
    // 台账收口在关库前：收尸已清过的台账（stop/dispose 路径）与不再需要共享连接的儿子资源，
    // 都不能抢在 db.close 之后（注入模式下 close 为 no-op，保持调用次序的可读性即可）。
    const ledger = this.#ledger;
    if (ledger !== undefined) {
      try {
        await ledger.close();
      } catch (err) {
        this.#safeLog("warn", "process ledger close on shutdown failed", { error: errorMessage(err) });
      }
    }
    if (db !== undefined) db.close();
  }

  /**
   * 关停路径专用日志出口：日志门面的契约声明「写日志失败由装配层保证不向调用方抛出」，
   * 故此处吞掉写失败——收尾绝不能因日志出口不可用（磁盘满/权限等）而中断（`bus.flush`/`db.close` 必达）。
   *
   * @param level - 日志级别
   * @param msg - 人类可读摘要
   * @param fields - 结构化附加键
   */
  #safeLog(level: "debug" | "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void {
    try {
      this.#logger[level](msg, fields);
    } catch {
      // 日志出口不可用不得反向中断收尾流程。
    }
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
    // 配对变体 hello{pairingCode} 属 Task 6 接线，本阶段按坏帧拒绝——与 M0 行为等价（彼时过不了解析）。
    if (frame === null || frame.type !== "hello" || !("token" in frame)) {
      conveyor.send(errorFrame("protocol.bad_frame", "首帧必须是 hello"));
      void conveyor.close("protocol.bad_frame");
      return;
    }
    state.helloSeen = true;
    void this.#completeHello(conveyor, remote, state, frame);
  }

  /**
   * 完成握手：校验 hello 令牌，失败回 `auth.invalid_token` 并关闭连接；成功则把该连接挂上广播
   * （`hello.resume` 非 null 时同时挂**重放闸**）、回 `welcome`（直发，不受闸约束）、按序完成
   * 断连缺口重放（`#replayGap`），最后放行暂存帧。
   *
   * `hello.resume === null`：整段重放跳过——M0 行为原样保留（旧客户端零感知，协议兼容硬约束）。
   *
   * @param conveyor - 该连接对应的通道
   * @param remote - 远端地址（记入鉴权审计）
   * @param state - 该连接的握手期状态，成功后写入身份
   * @param hello - 已通过结构校验的 hello 帧
   * @returns Promise，resolve 表示握手处理结束（成功与拒绝均 resolve）
   * 副作用：写入连接身份、可能挂载广播与重放闸、发送 welcome/error 帧、重放缺口、关闭通道
   */
  async #completeHello(conveyor: Conveyor, remote: string, state: ConnectionState, hello: HelloFrame): Promise<void> {
    const identity = await this.#auth.verifyToken(hello.token, remote);
    if (identity === null) {
      conveyor.send(errorFrame("auth.invalid_token", "token 校验失败"));
      await conveyor.close("auth.invalid_token");
      return;
    }
    if (conveyor.state !== "open") return; // 鉴权期间连接已断：不挂广播、不废话。
    state.identity = identity;
    // 重放闸只在 resume 非 null 时介入；不提供闸的通道零行为变化（M0 广播直发）。
    const cursor = hello.resume;
    const gate = cursor === null ? undefined : new ReplayGate();
    this.#fanout.attach(conveyor, gate);
    const sessions = await this.#conversations.listSessions();
    conveyor.send({ v: 1, type: "welcome", serverVersion: this.#cfg.serverVersion, sessions }); // 直发：闸只拦 session.event 广播
    if (gate !== undefined && cursor !== null) {
      try {
        await this.#replayGap(conveyor, cursor, gate, identity.deviceId);
      } catch (err) {
        // 重放失败不悬闸：降级放行（缺口留给下次重连补齐），错误经日志可见，不产生未处理拒绝。
        this.#safeLog("warn", "replay gap failed", { error: errorMessage(err) });
        this.#fanout.release(conveyor, gate);
      }
    }
    // 暂存帧放行放在重放完成后：语义"历史先于你的命令生效"（§5.3 顺序固定第 6 步）。
    for (const raw of state.buffered.splice(0)) this.#dispatch(conveyor, identity, raw);
  }

  /**
   * 断连缺口重放（core-loop §5.2）：把手机光标（已见最大 seq）之后的历史直发给这一条连接。
   * 顺序固定（§5.3）：快照切点 → 逐会话（超限降级 / 分页直发）→ 开闸放行排队帧。
   *
   * @param conveyor - 目标连接（welcome 已发、广播与重放闸已挂）
   * @param cursor - 手机声明的重放光标：会话 id → 已见最大 seq；缺会话 = 从 0 全量拉
   * @param gate - 本连接的重放闸；重放期间 live 广播在其 FIFO 排队，release 后按入队序补发
   * @param deviceId - 本连接设备身份（超限标记按设备记账）
   * @returns Promise，resolve 表示重放完成、闸已开（live 直发恢复）
   * 副作用：直发 session.event 帧（不经 fanout）、推进 `gate.replayedMax`、可能经 bus 发布超限 notice
   */
  async #replayGap(conveyor: Conveyor, cursor: ReplayCursor, gate: ReplayGate, deviceId: string): Promise<void> {
    // 快照切点：重放读库前把"已发布"与"已落库"对齐（聚合窗冲出 + 每会话发布链排干）——
    // 此后读到的历史 = 发布全序的前缀，重放起点不漏帧（review 重点 1）。
    await this.#bus.settle();
    for (const meta of await this.#conversations.listSessions()) {
      // 光标缺该会话 = 一条没见过：-1 使首事件（seq 0）也落在重放窗口内（getEvents 缺省口径）。
      const seen = cursor[meta.id] ?? -1;
      const count = await this.#conversations.countEvents(meta.id, seen);
      if (count > REPLAY_HARD_CAP) {
        await this.#replayTooLarge(meta.id, count, deviceId);
        continue; // 超限：跳过逐帧（live 照常经闸入队，开闸后随 FIFO 送达）
      }
      let sinceSeq = seen;
      for (;;) {
        const rows = await this.#conversations.getEvents(meta.id, { sinceSeq, limit: REPLAY_PAGE_SIZE });
        if (rows.length === 0) break;
        for (const row of rows) {
          // 直发不经 fanout：重放帧与 live 广播的去重叠由闸承担（入队口 + 冲刷终判两道判定）。
          conveyor.send({
            v: 1, type: "session.event", sessionId: meta.id, seq: row.seq, ts: row.ts, agentEvent: row.agentEvent,
          });
          gate.replayedMax.set(meta.id, row.seq);
        }
        sinceSeq = rows[rows.length - 1]!.seq;
      }
    }
    // 开闸：live 直发恢复；attach 以来排队的帧按入队序冲刷（入队口 + 冲刷终判两道去重）。
    this.#fanout.release(conveyor, gate);
  }

  /**
   * 重放超限降级：不逐帧，改发一条 warn notice 入流（经 bus：持久化 + 广播——手机端 S3 负责时间线
   * 标注"该段不可读"）。**按设备记账恰一次**（meta_kv `replay_capped:<sid>:<deviceId>`，值=时刻）：
   * 该设备首次重连见 warn，此后重连**静默**——why：warn 已随首次连接实时送达该设备；重复提示
   * 每连一条既无限堆积历史、又永不重放（超限会话逐帧跳过），直发又没有不与后续真事件冲突的
   * seq 可用，故静默是唯一不产生垃圾的口径（评审 S2 采纳）。
   *
   * @param sessionId - 超限会话
   * @param count - 待重放条数（进文案）
   * @param deviceId - 本连接设备身份（标记记账粒度）
   * @returns Promise，resolve 表示通知/标记已处理完毕
   * 副作用：首次经 bus 发布一条 warn notice（消耗该会话下一 seq）并写 meta_kv 标记；重复调用无副作用
   */
  async #replayTooLarge(sessionId: string, count: number, deviceId: string): Promise<void> {
    const key = `replay_capped:${sessionId}:${deviceId}`;
    if (await this.#meta.get(key) !== null) return; // 该设备已提示过：静默（防提醒风暴与历史堆积）
    await this.#bus.publish(sessionId, { type: "notice", severity: "warn", text: `重放过大（${count} 条），该段历史不可读` });
    await this.#meta.set(key, String(Date.now()));
  }

  /**
   * 分发一条已鉴权帧：心跳回 pong，建会话与指令分别交给对应处理，无法识别或解析失败时回 `protocol.bad_frame`。
   *
   * @param conveyor - 来源通道
   * @param identity - 来源连接的已鉴权身份
   * @param raw - 原始帧负载
   * 副作用：按帧类型发送应答帧，或转交建会话/指令处理
   */
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
        void this.#handleCreate(conveyor, identity, frame);
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

  /**
   * 处理 `session.create`：建会话成功后回 ack；适配器缺失时回 `session.agent_missing`，
   * 其余失败回 `server.busy` 并原样带上错误文案。成功与失败均落 `command.session_create` 审计
   * （成功 detail 为 spec JSON、失败 detail 含错误摘要）。
   *
   * @param conveyor - 来源通道
   * @param identity - 请求方身份（审计归属）
   * @param frame - 已解析的建会话帧
   * @returns Promise，resolve 表示应答已发送（成功与失败均 resolve，不 reject）
   * 副作用：创建会话并落库、写审计、发送 ack 或 error 帧
   */
  async #handleCreate(conveyor: Conveyor, identity: DeviceIdentity, frame: SessionCreateFrame): Promise<void> {
    const spec = frame.spec;
    try {
      const meta = await this.#sessions.create(spec, "new");
      await this.#audit.sessionCreate(identity, meta.id, JSON.stringify(spec));
      conveyor.send({ v: 1, type: "ack", sessionId: meta.id });
    } catch (err) {
      const message = errorMessage(err);
      const code: FrameErrorCode = /agent_missing/.test(message) ? "session.agent_missing" : "server.busy";
      await this.#audit.sessionCreate(identity, null, "error: " + message);
      conveyor.send(errorFrame(code, message));
    }
  }

  /**
   * 处理 `session.command`：交给命令管道完成幂等、审计与分发。
   * 命令管道抛错时按文案映射错误码：会话找不到或不可续接回 `session.not_found`；
   * 「not active」静默（该情况管道已把提示以 notice 入流）；其余回 `server.busy`，
   * 且 error 帧 message 附 at-most-once 提示。
   *
   * @param conveyor - 来源通道
   * @param identity - 请求方身份（审计归属）
   * @param frame - 已解析的命令帧
   * @returns Promise，resolve 表示处理结束（成功、静默或已回应答，不 reject）
   * 副作用：写审计、分发指令、可能发送 notice/error 帧
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
