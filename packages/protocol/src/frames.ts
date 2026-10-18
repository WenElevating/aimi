import type { AgentCommand } from "./agentCommands.js";
import type { AgentEvent } from "./agentEvents.js";
import type { SessionMeta, SessionSpec } from "./sessionSpec.js";

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
}
export interface WelcomeFrame { readonly v: 1; readonly type: "welcome"; readonly serverVersion: string; readonly sessions: readonly SessionMeta[] }
export interface PingFrame { readonly v: 1; readonly type: "ping"; readonly nonce: number }
export interface PongFrame { readonly v: 1; readonly type: "pong"; readonly nonce: number }
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
export interface ByeFrame { readonly v: 1; readonly type: "bye"; readonly reason: string }

/** bye.reason canonical 取值：旧连接被同 token 新连接接管（单设备锁，core-loop §5.4，后登者生效）。 */
export const BYE_TAKEN_OVER = "taken_over";
/** bye.reason canonical 取值：设备已被吊销，服务端即时踢线；其后旧 token 重连即被拒。 */
export const BYE_REVOKED = "revoked";

/** 手机发往 server 的领域帧。 */
export interface SessionCreateFrame { readonly v: 1; readonly type: "session.create"; readonly spec: SessionSpec }
export interface SessionCommandFrame {
  readonly v: 1; readonly type: "session.command";
  readonly sessionId: string; readonly clientId: string; readonly cmd: AgentCommand;
}

/** server 发往手机的领域帧；ack 对应 session.create。 */
export interface SessionEventFrame {
  readonly v: 1; readonly type: "session.event";
  readonly sessionId: string; readonly seq: number; readonly ts: number; readonly agentEvent: AgentEvent;
}
export interface AckFrame { readonly v: 1; readonly type: "ack"; readonly sessionId: string }
export type CommandAckStatus = "accepted" | "delivered" | "duplicate" | "rejected";
export interface CommandAckFrame {
  readonly v: 1;
  readonly type: "command.ack";
  readonly sessionId: string;
  readonly clientId: string;
  readonly status: CommandAckStatus;
  readonly code?: FrameErrorCode;
}
export interface ErrorFrame { readonly v: 1; readonly type: "error"; readonly code: FrameErrorCode; readonly message: string }

/** error 帧的唯一错误码取值域；未知 code 视为非契约帧。 */
export type FrameErrorCode =
  | "auth.invalid_token" | "auth.pairing_expired" | "auth.pairing_failed" | "protocol.bad_frame"
  | "session.not_found" | "session.agent_missing" | "session.duplicate_command"
  | "server.busy" | "protocol.rate_limited";

/** 手机发给 server 的合法帧闭集，只含这五个；其余一律按非法帧丢弃。 */
export type ClientFrame = HelloFrame | HelloPairFrame | PingFrame | SessionCreateFrame | SessionCommandFrame;
/** server 发给手机的合法帧闭集，只含这七个；其余一律按非法帧丢弃。 */
export type ServerFrame = WelcomeFrame | PongFrame | ByeFrame | PairedFrame | SessionEventFrame | AckFrame | CommandAckFrame | ErrorFrame;
