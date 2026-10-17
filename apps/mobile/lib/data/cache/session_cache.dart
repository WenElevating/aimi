import 'dart:collection';

import '../protocol/frame_dto.dart';

/// 手机端内存镜像（M1 换 Drift 持久化，接口不变）。
///
/// 职责边界：只做「按会话分组的元数据 + 事件序列 + 每会话光标」的记账，不含 IO、不含重连。
/// 事件写入前必须通过 seq 单调检查——这是异常 #12（人/agent 同时发消息）与断线补齐窗口内
/// 「乱序/重复帧不得入镜像」的最内层保障。
class SessionCache {
  final Map<String, SessionMetaDto> _sessions = {};
  final Map<String, List<SessionEventFrameDto>> _events = {};

  /// 每会话最后一个已写入事件的 seq；未知会话为 -1（等价「首帧必须 seq == 0」）。
  final Map<String, int> _lastSeq = {};

  /// welcome 帧的全量替换会话元数据。
  ///
  /// 只替换元数据：事件与光标**不**清空——M1 断线重放要靠本地光标算缺口，welcome 带回的
  /// `lastSeq` 是 server 侧水位，二者不能互相覆盖。
  void applyWelcome(List<SessionMetaDto> sessions) {
    _sessions
      ..clear()
      ..addEntries(sessions.map((s) => MapEntry(s.id, s)));
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
