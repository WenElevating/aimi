import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MetricRecorder, type MetricsProvider } from "../../observability/metrics.js";
import type { AgentModelOption, SessionSpec } from "@aimi/protocol";
import type { AdapterContext, AgentAdapter, AgentMeta, AgentSession, Emit } from "../types.js";
import type { Logger } from "../../logging/logger.js";
import { killTree } from "../killTree.js";
import { ZcodeSession } from "./zcodeSession.js";
import { ZCODE_PERMISSION_MODES } from "./zcodePermissions.js";

/** `--version` 探测超时：2s（与 claude 探测口径一致），超时树杀防挂死。 */
const VERSION_TIMEOUT_MS = 2000;

/**
 * zcode CLI 解析顺序（首个命中即用）：
 * 1. 配置覆盖 `agents.zcode.executable`（显式指定 node 脚本或 SEA 可执行）；
 * 2. 环境变量 `AIMI_ZCODE_CLI_PATH`（测试注入缝，对照 claude 的 AIMI_FAKE_CLI_PATH）；
 * 3. PATH 上的 `zcode.exe` / `zcode.cjs`（Windows 官方安装形态）；
 * 4. 桌面版捆绑 CLI 的常见安装根（`resources/glm/zcode.cjs`）。
 *
 * `.cjs` 一律经当前 Node 进程的可执行（process.execPath，需 ≥24，zcode 要求）拉起；
 * 其余（SEA exe）直接执行。找不到时返回 `undefined`，`isInstalled` 报 `{ok:false}`。
 */
function resolveZcodeCli(override: string | undefined): { file: string; args: string[] } | undefined {
  const candidates: string[] = [];
  if (override !== undefined && override !== "") candidates.push(override);
  const envCli = process.env.AIMI_ZCODE_CLI_PATH;
  if (envCli !== undefined && envCli !== "") candidates.push(envCli);
  // PATH 扫描（只认 exe/cjs；.cmd 需 shell 垫片，M1 不支持）。
  const pathDirs = (process.env.PATH ?? "").split(";").filter((dir) => dir !== "");
  for (const dir of pathDirs) {
    candidates.push(join(dir, "zcode.exe"));
    candidates.push(join(dir, "zcode.cjs"));
  }
  // 桌面版捆绑（官方默认安装根 + 常见自定义根）。
  const home = homedir();
  candidates.push(
    join(home, "AppData", "Local", "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
    join("C:", "Program Files", "ZCode", "resources", "glm", "zcode.cjs"),
    join("D:", "ZCode", "resources", "glm", "zcode.cjs"),
  );

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (candidate.toLowerCase().endsWith(".cjs") || candidate.toLowerCase().endsWith(".mjs")) {
      return { file: process.execPath, args: [candidate] };
    }
    return { file: candidate, args: [] };
  }
  return undefined;
}

/**
 * 从 zcode 全局 provider 配置提取当前模型（只读、尽力而为）。
 *
 * **只取模型 id，不读 `access` 段**——该文件含 API key，任何密钥内容不得进入日志/事件/测试。
 * 结构（v2）：`config.providerOrder[0]` → `config.providerConfigRules.providerRules` 同 id 项 →
 * `modelOrder[0]`（回退 `personalModelIds[0]`）。读不到/结构漂移一律返回 `[]`。
 */
function readActiveModels(): readonly AgentModelOption[] {
  try {
    const file = join(homedir(), ".zcode", "v2", "provider_config.json");
    if (!existsSync(file)) return [];
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const config = (parsed as { config?: unknown }).config;
    if (typeof config !== "object" || config === null) return [];
    const cfg = config as {
      providerOrder?: unknown;
      providerConfigRules?: { providerRules?: unknown };
    };
    if (!Array.isArray(cfg.providerOrder) || cfg.providerOrder.length === 0) return [];
    const activeId = cfg.providerOrder[0];
    const rules = cfg.providerConfigRules?.providerRules;
    if (!Array.isArray(rules)) return [];
    for (const rule of rules) {
      if (typeof rule !== "object" || rule === null) continue;
      const entry = rule as { providerId?: unknown; config?: { modelOrder?: unknown; personalModelIds?: unknown } };
      if (entry.providerId !== activeId) continue;
      const modelOrder = entry.config?.modelOrder;
      const personal = entry.config?.personalModelIds;
      const modelId =
        (Array.isArray(modelOrder) && typeof modelOrder[0] === "string" && modelOrder[0]) ||
        (Array.isArray(personal) && typeof personal[0] === "string" && personal[0]) ||
        undefined;
      if (modelId === undefined) return [];
      return [{ value: modelId, name: modelId, detail: "跟随 zcode 全局 provider 配置" }];
    }
    return [];
  } catch {
    return []; // 结构漂移/读文件失败都降级为空清单，不抛
  }
}

/**
 * zcode 适配器：以「每回合一个 CLI 子进程」驱动 zcode 非交互模式（`--prompt` +
 * `--output-format stream-json`，官方文档化契约），会话编排在 [ZcodeSession]。
 *
 * 安装探测：解析 CLI（见 `resolveZcodeCli`）后运行 `--version`，2s 未回或非零退出即
 * `{ok:false}`——**不抛**；`.cjs` 经当前 Node 拉起（zcode 要求 Node ≥24，部署文档注明）。
 */
export class ZcodeAdapter implements AgentAdapter {
  readonly #metrics = new MetricRecorder({
    sourceId: "zcode.adapter",
    component: "agent",
    context: { agentId: "zcode" },
  });
  /** 适配器身份：`id` 即 `SessionSpec.agentId` 的取值域（装配时以此注册） */
  readonly meta: AgentMeta = { id: "zcode", label: "ZCode" };
  /** 不支持分叉：zcode 的 `--resume-from` 未文档化，伪分叉会让两条 aimi 会话争写同一续接线索。 */
  readonly forkCapable = false;

  readonly #logger: Logger | undefined;
  readonly #initTimeoutMs: number | undefined;
  readonly #onProtocolFailure: (() => void) | undefined;
  readonly #executableOverride: string | undefined;

  /**
   * @param deps.logger - 可选日志门面（缺省无日志）
   * @param deps.initTimeoutMs - 回合看门狗上限（缺省 30s；注入点仅为测试可缩短等待）
   * @param deps.onProtocolFailure - 看门狗判定协议未确认时的回调（装配层标灰用）
   * @param deps.executable - CLI 路径覆盖（config `agents.zcode.executable`；缺省按解析顺序）
   */
  constructor(
    deps: { logger?: Logger; initTimeoutMs?: number; onProtocolFailure?: () => void; executable?: string } = {},
  ) {
    this.#metrics.define({
      name: "agent.sessions.created",
      kind: "counter",
      unit: "count",
      description: "适配器创建的会话句柄数",
      boundary: "adapter.create",
      availability: "available",
    });
    this.#logger = deps.logger;
    this.#initTimeoutMs = deps.initTimeoutMs;
    this.#onProtocolFailure = deps.onProtocolFailure;
    this.#executableOverride = deps.executable;
  }

  /** 探测 zcode CLI 是否可用（`--version`，2s 超时树杀；失败一律 `{ok:false}` 不抛）。 */
  isInstalled(): Promise<{ ok: boolean; version?: string }> {
    return new Promise((resolve) => {
      const cli = resolveZcodeCli(this.#executableOverride);
      if (cli === undefined) {
        resolve({ ok: false });
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | undefined = undefined;
      const finish = (result: { ok: boolean; version?: string }): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };

      let child;
      try {
        child = spawn(cli.file, [...cli.args, "--version"], { windowsHide: true });
      } catch {
        finish({ ok: false });
        return;
      }

      timer = setTimeout(() => {
        killTree(child.pid, "SIGKILL"); // 树杀：探测进程卡死时不能只杀直接子进程
        finish({ ok: false });
      }, VERSION_TIMEOUT_MS);

      let stdout = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", () => {
        /* 排空防背压；版本探测不消费 stderr */
      });
      child.on("error", () => {
        finish({ ok: false });
      });
      child.on("close", (code: number | null) => {
        if (code !== 0) {
          finish({ ok: false });
          return;
        }
        const version = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line !== "");
        finish(version === undefined ? { ok: true } : { ok: true, version });
      });
    });
  }

  /** 拉起一条 zcode 侧会话（回合进程的 spawn 与读流在 `ZcodeSession.start()` 起）。 */
  create(
    spec: SessionSpec,
    emit: Emit,
    resume?: { hint: string; fork?: boolean },
    context?: AdapterContext,
  ): AgentSession {
    const cli = resolveZcodeCli(this.#executableOverride);
    if (cli === undefined) throw new Error("zcode CLI not found"); // create 前 isInstalled 已把门，此为防御
    this.#metrics.record("agent.sessions.created", 1);
    return new ZcodeSession(spec, emit, resume, {
      cli,
      logger: this.#logger,
      initTimeoutMs: this.#initTimeoutMs,
      onProtocolFailure: this.#onProtocolFailure,
      onRuntimeChanged: context?.onRuntimeChanged,
      metricsContext: context?.metricsContext,
      aimiSessionId: context?.sessionId,
    });
  }

  /** 返回适配器指标，不执行 CLI 操作。 */
  metrics(): MetricsProvider {
    return this.#metrics;
  }

  /** zcode 原生五档目录（plan/build/edit/yolo/guarded；headless 的 ask 语义限制见目录描述）。 */
  permissionModes() {
    return ZCODE_PERMISSION_MODES;
  }

  /** 当前模型清单：读全局 provider 配置的活动模型（单条；读不到为空——welcome 回退）。 */
  currentModels(): readonly AgentModelOption[] {
    return readActiveModels();
  }
}
