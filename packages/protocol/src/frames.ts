import type { AgentCommand } from "./agentCommands.js";
import type { AgentEvent, NotificationKind } from "./agentEvents.js";
import type { SessionMeta, SessionSpec } from "./sessionSpec.js";

/** 链路层（连接与恢复）。resume 为 M1 预留：本阶段恒 null。 */
export interface HelloFrame { readonly v: 1; readonly type: "hello"; readonly token: string; readonly resume: null }
export interface WelcomeFrame { readonly v: 1; readonly type: "welcome"; readonly serverVersion: string; readonly sessions: readonly SessionMeta[] }
export interface PingFrame { readonly v: 1; readonly type: "ping"; readonly nonce: number }
export interface PongFrame { readonly v: 1; readonly type: "pong"; readonly nonce: number }
export interface ByeFrame { readonly v: 1; readonly type: "bye"; readonly reason: string }

/** 手机→server 领域帧。 */
export interface SessionCreateFrame { readonly v: 1; readonly type: "session.create"; readonly spec: SessionSpec }
export interface SessionCommandFrame {
  readonly v: 1; readonly type: "session.command";
  readonly sessionId: string; readonly clientId: string; readonly cmd: AgentCommand;
}

/** server→手机 领域帧；ack 对应 session.create。 */
export interface SessionEventFrame {
  readonly v: 1; readonly type: "session.event";
  readonly sessionId: string; readonly seq: number; readonly ts: number; readonly agentEvent: AgentEvent;
}
export interface AckFrame { readonly v: 1; readonly type: "ack"; readonly sessionId: string }
export interface ErrorFrame { readonly v: 1; readonly type: "error"; readonly code: FrameErrorCode; readonly message: string }

export type FrameErrorCode =
  | "auth.invalid_token" | "auth.pairing_expired" | "protocol.bad_frame"
  | "session.not_found" | "session.agent_missing" | "session.duplicate_command"
  | "server.busy";

export type ClientFrame = HelloFrame | PingFrame | SessionCreateFrame | SessionCommandFrame;
export type ServerFrame = WelcomeFrame | PongFrame | ByeFrame | SessionEventFrame | AckFrame | ErrorFrame;

/** M1：通知分类帧（前台服务长连接承载）的占位由 NotificationKind 表达于事件域，不需要独立帧。 */
export type NotificationKindUnused = NotificationKind;
