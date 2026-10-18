import { ClaudeAdapter } from "../agents/claude/claudeAdapter.js";
import { AgentRegistry, type AgentDetection } from "../agents/registry.js";
import type { ServerConfig } from "./config.js";
import { healthSnapshot } from "../ops/health.js";

/** `status` 输出的单行 agent 检测面：安装探测结果 + 本进程标灰原因合并（未标灰省略 `grayed`）。 */
export interface AgentDetectionView extends AgentDetection {
  /** 本进程内标灰原因（如协议探测未确认）；未标灰时省略 */
  readonly grayed?: string;
}

/** `status` 子命令的输出结构：库面只读快照（healthSnapshot）+ agent 检测面（detectAgentsSnapshot）。 */
export interface StatusSnapshot {
  /** 配置端口（非运行端口——`status` 不连进程） */
  readonly port: number;
  /** 库中会话总数 */
  readonly sessions: number;
  /** 库中设备总数 */
  readonly devices: number;
  /** 本机 agent 安装/灰态快照 */
  readonly agents: readonly AgentDetectionView[];
}

/**
 * 就地装配仅含检测面的 AgentRegistry（ClaudeAdapter 裸构造——探测不依赖 dataDir/logger）。
 * why 不拉全 Application：`status` 是快照命令，装配全套（WS 监听/定时器/启动恢复）只为探测
 * 既杀鸡用牛刀又带写库副作用——检测快照必须保持无痕。
 *
 * @returns 装好全部已知适配器的注册表（当前仅 claude）
 */
function detectionRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(new ClaudeAdapter());
  return registry;
}

/**
 * 探测本机 agent 安装情况并合并标灰态（`status` 的 `agents` 字段实现）。
 * **会拉起探测子进程**（`claude --version`，2s 超时视为未装）——`status` 因此不再瞬时返回，
 * 但不写库；标灰态是进程内内存（CLI 进程恒为空，注入注册表仅供测试），一并快照以面齐。
 *
 * @param registry - 探测注册表；缺省就地小装配（仅检测面）
 * @returns Promise，resolve 为检测行数组（注册序；灰态以 `grayed` 字段并入）
 */
export async function detectAgentsSnapshot(registry: AgentRegistry = detectionRegistry()): Promise<AgentDetectionView[]> {
  const detected = await registry.detectAll();
  const grayed = new Map(registry.grayedSnapshot().map((entry) => [entry.id, entry.reason]));
  return detected.map((row) => {
    const reason = grayed.get(row.id);
    return reason === undefined ? row : { ...row, grayed: reason };
  });
}

/**
 * `status` 子命令的完整快照：库面（会话/设备计数，只读）与 agent 检测面合并。
 * 两路独立无依赖，并发取数；库面保持 `healthSnapshot` 的只读口径不动。
 *
 * @param cfg - 已加载配置（库面用其 `dataDir`）
 * @returns Promise，resolve 为 `{ port, sessions, devices, agents }`
 * 副作用：打开并随即关闭数据目录下的数据库；拉起 `claude --version` 探测子进程（2s 超时）
 */
export async function statusSnapshot(cfg: ServerConfig): Promise<StatusSnapshot> {
  const [base, agents] = await Promise.all([healthSnapshot(cfg), detectAgentsSnapshot()]);
  return { port: base.port, sessions: base.sessions, devices: base.devices, agents };
}
