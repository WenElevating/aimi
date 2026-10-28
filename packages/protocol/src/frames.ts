import type { AgentCommand } from "./agentCommands.js";
import type { AgentEvent } from "./agentEvents.js";
import type { AgentCapability, SessionMeta, SessionSpec } from "./sessionSpec.js";
import type { PhonePermissionMode } from "./sessionSpec.js";

/** hello 能力声明；动态权限显式协商，缺省保留旧客户端投影。 */
export interface HelloCapabilities {
  readonly permissionModes?: readonly PhonePermissionMode[];
  readonly dynamicPermissions?: boolean;
}

/**
 * 重放光标：会话 id → 手机已见最大 seq；**缺会话 = 从 0 全量拉取**（core-loop §5.2 基线）。
 * 只读形态——手机端以此声明断线补齐起点，不得承载序号之外的语义。
 */
export type ReplayCursor = Readonly<Record<string, number>>;

/**
 * 链路层帧（连接与恢复）：token 鉴权变体。`resume` 携带重放光标；
 * **null 形态必须保留**——M0 客户端兼容硬约束（旧客户端只发 null，不接受续接请求）。
 */
export interface HelloFrame {
  readonly v: 1;
  readonly type: "hello";
  readonly token: string;
  readonly resume: ReplayCursor | null;
  /** 可选能力声明；缺省表示旧客户端，不发送 command.ack。 */
  readonly commandAck?: boolean;
  /** 可选能力声明；决定投影及独立推送能力，不代表当前会话请求。 */
  readonly capabilities?: HelloCapabilities;
}

/**
 * 链路层帧（连接与恢复）：配对变体——headless 设备首连用一次性配对码换 token
 * （core-loop §5.3，措辞即 `hello{pairingCode, deviceName}`）。
 * 与 token 变体同 `type:"hello"` 字面量、按字段区分：M0 中间件与回放工具无需特判新 type。
 */
export interface HelloPairFrame {
  readonly v: 1;
  readonly type: "hello";
  /** 一次性 8 位数字配对码，由 `aimi-server pair` 供给、服务端原子核销 */
  readonly pairingCode: string;
  /** 设备人类可读名（配对成功即入库 devices.name） */
  readonly deviceName: string;
  readonly commandAck?: boolean;
  /** 可选能力声明；决定投影及独立推送能力，不代表当前会话请求。 */
  readonly capabilities?: HelloCapabilities;
}
export interface WelcomeFrame {
  readonly v: 1;
  readonly type: "welcome";
  readonly serverVersion: string;
  readonly sessions: readonly SessionMeta[];
  /** agent 能力投影（模型清单 + 权限上限）；additive 可选——旧手机忽略 */
  readonly agents?: readonly AgentCapability[];
  readonly features?: { readonly directoryBrowsing?: boolean; readonly sessionFork?: boolean };
}
export interface PingFrame {
  readonly v: 1;
  readonly type: "ping";
  readonly nonce: number;
}
export interface PongFrame {
  readonly v: 1;
  readonly type: "pong";
  readonly nonce: number;
}
/**
 * server → 手机帧：配对成功应答。**明文 token 全程只出现这一次**（之后仅哈希入库，
 * 再也拿不回来）——手机端必须落盘保存，重连走 token 变体 hello。
 */
export interface PairedFrame {
  readonly v: 1;
  readonly type: "paired";
  /** LAN 接入 token（与 lan-token 同一校验路径），明文只此一次 */
  readonly token: string;
  /** 服务端生成的设备标识（devices 表主键） */
  readonly deviceId: string;
}

/**
 * server → 手机帧：断连理由。`reason` 保持 string 而非枚举——防协议死锁：
 * 未来新增理由（如 relay 相关）不破旧客户端解析；canonical 取值 = 常量单一源：
 * `BYE_TAKEN_OVER`（同 token 互踢接管）/ `BYE_REVOKED`（设备吊销）。
 */
export interface ByeFrame {
  readonly v: 1;
  readonly type: "bye";
  readonly reason: string;
}

/** bye.reason canonical 取值：旧连接被同 token 新连接接管（单设备锁，core-loop §5.4，后登者生效）。 */
export const BYE_TAKEN_OVER = "taken_over";
/** bye.reason canonical 取值：设备已被吊销，服务端即时踢线；其后旧 token 重连即被拒。 */
export const BYE_REVOKED = "revoked";

/** 手机发往 server 的领域帧。 */
export interface SessionCreateFrame {
  readonly v: 1;
  readonly type: "session.create";
  readonly spec: SessionSpec;
}
/**
 * 手机请求分叉会话：以源会话的 agent 侧续接线索新开一个 aimi 会话
 * （SDK `forkSession` 语义——源会话历史不动，新会话从分叉点继续）。
 * 成功回 `ack`（携带新 sessionId，与 session.create 同形）；失败回 `error`。
 */
export interface SessionForkFrame {
  readonly v: 1;
  readonly type: "session.fork";
  /** 源会话 id（aimi 侧） */
  readonly sourceId: string;
}
export interface SessionCommandFrame {
  readonly v: 1;
  readonly type: "session.command";
  readonly sessionId: string;
  readonly clientId: string;
  readonly cmd: AgentCommand;
}

/** server 发往手机的领域帧；ack 对应 session.create。 */
export interface SessionEventFrame {
  readonly v: 1;
  readonly type: "session.event";
  readonly sessionId: string;
  readonly seq: number;
  readonly ts: number;
  readonly agentEvent: AgentEvent;
}
export interface AckFrame {
  readonly v: 1;
  readonly type: "ack";
  readonly sessionId: string;
}
export type CommandAckStatus = "accepted" | "delivered" | "duplicate" | "rejected";
export interface CommandAckFrame {
  readonly v: 1;
  readonly type: "command.ack";
  readonly sessionId: string;
  readonly clientId: string;
  readonly status: CommandAckStatus;
  readonly code?: FrameErrorCode;
}
export interface ErrorFrame {
  readonly v: 1;
  readonly type: "error";
  readonly code: FrameErrorCode;
  readonly message: string;
}

/**
 * 已发布 APK 的元数据（update.info 帧 latest 字段结构，单一源）。
 * `downloadPath` 是相对路径（以 `/` 开头）——手机按自身 WS 连接的 host:port 拼 HTTP(S) URL，
 * 服务端不感知对外地址（adb reverse 与 LAN 直连两种场景由此自动正确）；
 * 不携带 token，下载鉴权由手机请求时附加自己的设备 token 完成。
 */
export interface AppUpdateManifest {
  /** 人类可读版本名（如 "1.0.1"），仅展示用 */
  readonly versionName: string;
  /** Android versionCode；手机以此为升级判据（严格大于自身才提示） */
  readonly versionCode: number;
  /** APK 字节数（下载进度与展示用） */
  readonly size: number;
  /** APK 文件 sha256 hex（64 位小写十六进制），手机下载后校验完整性 */
  readonly sha256: string;
  /** 下载相对路径，如 "/updates/app-2.apk" */
  readonly downloadPath: string;
  /** 可选发布说明，展示用 */
  readonly notes?: string;
}

/** server → 手机帧：当前最新发布版本；`latest` 为 null 表示服务端从未发布过 APK。 */
export interface UpdateInfoFrame {
  readonly v: 1;
  readonly type: "update.info";
  readonly latest: AppUpdateManifest | null;
}

/** 手机 → server 帧：手动触发更新检查；服务端应回一条当前缓存的 update.info。 */
export interface UpdateCheckFrame {
  readonly v: 1;
  readonly type: "update.check";
}

/** 手机请求浏览电脑目录；path 为空时由服务端返回可用根目录。 */
export interface DirectoryListFrame {
  readonly v: 1;
  readonly type: "directory.list";
  readonly requestId: string;
  readonly path: string;
}

/** 服务端返回目录列表；错误也使用同一 requestId 对账，不进入会话事件流。 */
export interface DirectoryListResultFrame {
  readonly v: 1;
  readonly type: "directory.result";
  readonly requestId: string;
  readonly path?: string;
  readonly parent?: string;
  readonly entries?: readonly { name: string; path: string }[];
  readonly error?: "invalid_path" | "not_found" | "permission_denied" | "not_directory" | "io_error";
}

/** 权限状态独立推送，仅发给声明 dynamicPermissions 的连接，不进入时间线。 */
export interface SessionPermissionsFrame {
  readonly v: 1;
  readonly type: "session.permissions";
  readonly sessionId: string;
  readonly currentMode: string;
  readonly modes: readonly import("./sessionSpec.js").PermissionModeDescriptor[];
}

/** error 帧的唯一错误码取值域；未知 code 视为非契约帧。 */
export type FrameErrorCode =
  | "auth.invalid_token"
  | "auth.pairing_expired"
  | "auth.pairing_failed"
  | "protocol.bad_frame"
  | "session.not_found"
  | "session.agent_missing"
  | "session.duplicate_command"
  | "server.busy"
  | "protocol.rate_limited";

/** 手机发给 server 的合法帧闭集，只含这六个；其余一律按非法帧丢弃。 */
export type ClientFrame =
  | HelloFrame
  | HelloPairFrame
  | PingFrame
  | SessionCreateFrame
  | SessionCommandFrame
  | UpdateCheckFrame
  | DirectoryListFrame
  | SessionForkFrame;
/** server 发给手机的合法帧闭集，只含这九个；其余一律按非法帧丢弃。 */
export type ServerFrame =
  | WelcomeFrame
  | PongFrame
  | ByeFrame
  | PairedFrame
  | SessionEventFrame
  | AckFrame
  | CommandAckFrame
  | ErrorFrame
  | UpdateInfoFrame
  | DirectoryListResultFrame
  | SessionPermissionsFrame;
