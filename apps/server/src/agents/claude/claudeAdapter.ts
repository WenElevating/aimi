import { MetricRecorder, type MetricsProvider } from "../../observability/metrics.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentModelOption, SessionSpec } from "@aimi/protocol";
import type { AdapterContext, AgentAdapter, AgentMeta, AgentSession, Emit } from "../types.js";
import type { Logger } from "../../logging/logger.js";
import { ClaudeSession } from "./claudeSession.js";
import { killTree } from "../killTree.js";
import { CLAUDE_PERMISSION_MODES } from "./claudePermissions.js";

/** `claude --version` 探测超时：2s 未响应视为不可用。 */
const VERSION_TIMEOUT_MS = 2000;

/** SDK 平台包名（Windows x64）：CLI 二进制的随包位置（SDK 依赖树内解析）。 */
const WIN_PLATFORM_PACKAGE = "@anthropic-ai/claude-agent-sdk-win32-x64";

/**
 * 内置回退模型清单（探测不可用/未就绪时下发；与旧手机硬编码三条逐字一致——存量部署零行为变化）。
 * 真实清单来自 `refreshModels()` 的 SDK 实测（`supportedModels`——中转站实际配置的别名映射）。
 */
const FALLBACK_MODELS: readonly AgentModelOption[] = [
  { value: "opus", name: "Opus 4.6", detail: "最强推理，适合复杂重构" },
  { value: "sonnet", name: "Sonnet 4.6", detail: "均衡，适合多数任务" },
  { value: "haiku", name: "Haiku 4.5", detail: "最快，适合小改动" },
];

/** 模型探测超时：`supportedModels` 拿不到即放弃（welcome 组装不等探测，下次刷新再试）。 */
const MODELS_PROBE_TIMEOUT_MS = 10_000;

/**
 * 解析 SDK 随包携带的 claude CLI 可执行文件路径（Windows）。
 * why 随包而非全局：SDK 拉起的就是这颗二进制，探测面与运行面同源（全局 CLI 版本不再代表会话行为）。
 * 解析路径：SDK 包的 `exports` 不暴露 `./package.json` 子路径——包根须从裸入口（`.`）反推
 * （入口 `sdk.mjs` 在包根）；平台包无 `exports` 限制，`package.json` 子路径直取即得包根。
 * 两级都从各自包域内解析（pnpm 虚拟 store 下 optional dep 与 SDK 同域）。
 *
 * @returns 可执行文件绝对路径；解析失败（非 Windows/包缺失）为 `undefined`
 */
export function bundledCliPath(): string | undefined {
  try {
    const requireFromHere = createRequire(import.meta.url);
    const sdkEntry = requireFromHere.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkRoot = dirname(sdkEntry);
    const requireFromSdk = createRequire(pathToFileURL(join(sdkRoot, "package.json")));
    const platformPackageJson = requireFromSdk.resolve(`${WIN_PLATFORM_PACKAGE}/package.json`);
    return join(dirname(platformPackageJson), "claude.exe");
  } catch {
    return undefined;
  }
}

/**
 * claude code 适配器：传输与进程由官方 Agent SDK 承担（内置 CLI 子进程 + stream-json 协议），
 * 本适配器只做安装探测与会话工厂。
 *
 * 安装探测：直接运行随包 CLI `--version`（原生 exe，无需 shell 垫片），2s 未回或非零退出即
 * `{ok:false}`——**不抛**（契约要求以返回值表达失败）；超时路径按进程树强杀（防探测进程挂死）。
 *
 * 会话构造依赖全量透传（logger/initTimeoutMs/onProtocolFailure——协议探测标灰在装配层收口）。
 * `context`（aimi 会话上下文）在 SDK 路径下不再消费（审批走 canUseTool 进程内回调，
 * 无闸目录派生），仅为兼容 `AgentAdapter` 契约签名保留。
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly #metrics = new MetricRecorder({
    sourceId: "claude.adapter",
    component: "agent",
    context: { agentId: "claude" },
  });
  /** 适配器身份：`id` 即 `SessionSpec.agentId` 的取值域（装配时以此注册） */
  readonly meta: AgentMeta = { id: "claude", label: "Claude Code" };
  /** 分叉能力：SDK `forkSession` 产出新 claude 会话 id，源会话线索不动——真实分叉语义。 */
  readonly forkCapable = true;

  /** 可选日志门面：透传给会话，用于 dispose 超时等告警；缺省时不产生日志 */
  readonly #logger: Logger | undefined;
  /** init 看门狗上限透传（可选；缺省由 ClaudeSession 内部取 30s）。 */
  readonly #initTimeoutMs: number | undefined;
  /** 协议未确认回调透传：装配层注入标灰收口。 */
  readonly #onProtocolFailure: (() => void) | undefined;
  /** 模型清单缓存（`refreshModels` 探测成功后填充；缺省回退 `FALLBACK_MODELS`）。 */
  #models: readonly AgentModelOption[] | undefined;

  /**
   * @param deps.logger - 可选日志门面（装配时注入；缺省无日志）
   * @param deps.initTimeoutMs - init 看门狗上限（缺省 30s；注入点仅为测试可缩短等待）
   * @param deps.onProtocolFailure - 看门狗判定协议未确认时的回调（装配层标灰用；缺省不做）
   */
  constructor(
    deps: { logger?: Logger; initTimeoutMs?: number; onProtocolFailure?: () => void; dataDir?: string } = {},
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
  }

  /**
   * 探测随包 CLI 是否可用。
   *
   * @returns Promise，resolve 为探测结果：进程正常退出时 `{ok:true, version}`（`version` 取 stdout 首个非空行）；
   *          否则 `{ok:false}`（二进制缺失/无权限/超时/非零退出，一律收敛为同一结果，不抛）
   */
  isInstalled(): Promise<{ ok: boolean; version?: string }> {
    return new Promise((resolve) => {
      const exe = bundledCliPath();
      if (exe === undefined) {
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
        child = spawn(exe, ["--version"], { windowsHide: true });
      } catch {
        finish({ ok: false });
        return;
      }

      timer = setTimeout(() => {
        killTree(child.pid, "SIGKILL"); // 树杀：探测进程卡死时不能只杀直接子进程
        finish({ ok: false });
      }, VERSION_TIMEOUT_MS);

      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", () => {
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

  /**
   * 拉起一条 claude 侧会话（CLI 子进程的创建与读流由 SDK 在 `start()` 时承担）。
   *
   * @param spec - 会话描述（`cwd`/`permissionMode`/可选 `initialPrompt`）
   * @param emit - 归一化事件出口
   * @param resume - 续接线索（存在时经 SDK `options.resume` 续接）
   * @param context - aimi 会话上下文（SDK 路径不消费；契约保留）
   * @returns 惰性句柄——`start()` 前可先 `send`（指令排队）
   */
  create(
    spec: SessionSpec,
    emit: Emit,
    resume?: { hint: string; fork?: boolean },
    context?: AdapterContext,
  ): AgentSession {
    void context;
    this.#metrics.record("agent.sessions.created", 1);
    return new ClaudeSession(spec, emit, resume, {
      logger: this.#logger,
      initTimeoutMs: this.#initTimeoutMs,
      onProtocolFailure: this.#onProtocolFailure,
      allowDangerouslySkipPermissions: context?.allowDangerouslySkipPermissions,
      onRuntimeChanged: context?.onRuntimeChanged,
      metricsContext: context?.metricsContext,
      aimiSessionId: context?.sessionId,
    });
  }

  /** 返回缓存中的适配器指标，不执行 CLI 或 SDK 操作。 */
  metrics(): MetricsProvider {
    return this.#metrics;
  }

  /** 返回 SDK 公开模式目录，运行时限制由具体会话进一步收紧。 */
  permissionModes() {
    return CLAUDE_PERMISSION_MODES;
  }

  /**
   * 当前模型清单（`AgentAdapter.currentModels` 契约实现）：同步返回缓存值，
   * 探测未完成/失败时回退内置三条（welcome 组装不等待探测）。
   */
  currentModels(): readonly AgentModelOption[] {
    return this.#models ?? FALLBACK_MODELS;
  }

  /**
   * 刷新模型清单（`AgentAdapter.refreshModels` 契约实现）：起一条不发消息的探测查询
   * （懒 init 事实不影响 `supportedModels`——控制通道独立于回合），限时取实测清单后即刻收口；
   * 探测 cwd 取系统临时目录（规避工程目录 hooks 的额外耗时）。失败/空清单保持原值不抛。
   * 副作用：成功且非空时更新 `#models` 缓存；起/收一个短命 CLI 子进程
   */
  async refreshModels(): Promise<void> {
    const fakeCli = process.env.AIMI_FAKE_CLI_PATH;
    // 探测进程不写 args 日志（env 整体替换子进程环境——复制后剔除观测变量，其余原样透传；
    // 否则 e2e 的"进程数即冷启动数"断言会被预热查询污染）。
    const env = { ...process.env };
    delete env.AIMI_ARGS_LOG;
    const q = query({
      // 永不产出消息的输入流：探测查询只走控制通道，不需要任何回合输入。
      prompt: (async function* () {
        await new Promise<void>(() => {});
      })(),
      options: {
        cwd: tmpdir(),
        permissionMode: "default",
        env,
        ...(fakeCli !== undefined && fakeCli !== ""
          ? { pathToClaudeCodeExecutable: fakeCli, executable: "node" as const }
          : {}),
      },
    });
    // 消费循环必须启动（SDK 惰性拉起 CLI）；探测查询不产消息，循环只为流收尾兜底。
    void (async () => {
      for await (const _message of q) {
        void _message;
      }
    })().catch(() => {
      /* 探测失败不外抛 */
    });
    try {
      const models = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("supportedModels timeout"));
          }, MODELS_PROBE_TIMEOUT_MS);
        }),
      ]);
      if (models.length > 0) {
        this.#models = models.map((m) => ({
          value: m.value,
          name: m.displayName,
          ...(m.description === undefined || m.description === "" ? {} : { detail: m.description.slice(0, 80) }),
        }));
        this.#logger?.info("agent models refreshed", { count: models.length });
      }
    } catch (err) {
      this.#logger?.warn("agent models refresh failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      q.close();
    }
  }
}
