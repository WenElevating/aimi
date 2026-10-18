import 'dart:collection';

import '../protocol/frame_dto.dart';

/// 手机端会话镜像：当前只保留在内存，应用退出即清空；后续版本将改为持久化存储，公开接口不变。
///
/// 职责边界：只做「按会话分组的元数据 + 事件序列 + 每会话光标」的记账，不含 IO、不含重连。
/// 事件写入前必须通过 seq 单调检查——这是多来源并发（人与 agent 同时发消息）以及断线窗口内
/// 「乱序/重复帧不得入镜像」的最内层保障。
class SessionCache {
  final Map<String, SessionMetaDto> _sessions = {};
  final Map<String, List<SessionEventFrameDto>> _events = {};

  /// 每会话最后一个已写入事件的 seq；未知会话为 -1，等价于「首帧必须 seq == 0」
  final Map<String, int> _lastSeq = {};

  /// 用 welcome 帧的会话元数据全量替换本地元数据，并把每会话的写入光标推进到服务端水位。
  ///
  /// 只替换元数据：已缓存的事件与光标**不**清空，历史仍然可读。
  /// 光标推进到服务端下发的 `lastSeq` 后，重连产生的缺口按「允许缺口」语义跳过，
  /// 冷启动或重连后事件流不会因为本地光标停旧而永久停滞
  /// ——否则本地光标停在旧值，服务端已推进的 seq 会被 seq 单调检查整体拒绝。
  void applyWelcome(List<SessionMetaDto> sessions) {
    _sessions
      ..clear()
      ..addEntries(sessions.map((s) => MapEntry(s.id, s)));
    for (final s in sessions) {
      _lastSeq[s.id] = s.lastSeq;
    }
  }

  /// 写入一条事件帧；seq 非 `lastSeq + 1`（乱序/重复/跳号）则丢弃并返回 false。
  ///
  /// 写入成功时同步把该会话元数据的 `lastSeq` 前移；若事件是 state 变体，元数据 `state`
  /// 一并跟随（看板/红点只读镜像即可反映状态色）。
  bool applyEvent(SessionEventFrameDto frame) {
    final last = _lastSeq[frame.sessionId] ?? -1;
    if (frame.seq != last + 1) return false;

    _lastSeq[frame.sessionId] = frame.seq;
    (_events[frame.sessionId] ??= <SessionEventFrameDto>[]).add(frame);

    final meta = _sessions[frame.sessionId];
    if (meta != null) {
      final state = frame.agentEvent.type == 'state' ? frame.agentEvent.state : null;
      _sessions[frame.sessionId] = meta.copyWith(
        lastSeq: frame.seq,
        state: state,
      );
    }
    return true;
  }

  /// 会话元数据快照，按 `updatedAt` 降序（同刻按 id 升序稳定），供看板列表直接消费。
  List<SessionMetaDto> sessionsSnapshot() {
    final sorted = _sessions.values.toList()
      ..sort((a, b) {
        final byUpdated = b.updatedAt.compareTo(a.updatedAt);
        return byUpdated != 0 ? byUpdated : a.id.compareTo(b.id);
      });
    return List.unmodifiable(sorted);
  }

  /// 单个会话的元数据；不存在返回 null。
  SessionMetaDto? session(String id) => _sessions[id];

  /// 某会话已入镜像的事件（seq 升序）；返回只读视图，避免 UI 侧误改镜像。
  List<SessionEventFrameDto> eventsFor(String sessionId) =>
      UnmodifiableListView(_events[sessionId] ?? const <SessionEventFrameDto>[]);

  /// 某会话最后写入的 seq；从未写入过（含未知会话）返回 -1。
  int lastSeq(String sessionId) => _lastSeq[sessionId] ?? -1;
}
