import '../protocol/frame_dto.dart';
import 'session_mirror.dart';

/// 连接层兼容的会话镜像门面。
///
/// 旧连接代码继续调用 `applyWelcome`；实际合并规则由 [SessionMirror] 提供，
/// 后续 Drift 装配只需替换 provider 实例。
class SessionCache extends SessionMirror {
  SessionCache() : super(strictSeq: true, alignWelcomeCursor: true);

  /// 兼容 M0 命名；welcome 不会推进本地事件 cursor。
  void applyWelcome(List<SessionMetaDto> sessions) => upsertWelcome(sessions);
}
