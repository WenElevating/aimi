import 'dart:collection';

import '../protocol/frame_dto.dart';

/// 会话本地镜像的持久化无关核心。
///
/// 生产装配可以把这些变更映射到 Drift；该类本身只定义确定性的合并规则，
/// 便于在 Flutter 单测和后台 isolate 中复用，且不会把本地推断当成服务端真相。
class SessionMirror {
  SessionMirror({this.strictSeq = false, this.alignWelcomeCursor = false});

  /// M0 兼容模式：要求每帧恰为上一帧之后的 seq。
  final bool strictSeq;

  /// M0 兼容模式：welcome 的 lastSeq 作为旧连接起点。
  final bool alignWelcomeCursor;

  final Map<String, SessionMetaDto> _sessions = <String, SessionMetaDto>{};
  final Map<String, List<SessionEventFrameDto>> _events =
      <String, List<SessionEventFrameDto>>{};
  final Map<String, int> _lastSeq = <String, int>{};
  final Map<String, int> _stateSeq = <String, int>{};
  final Set<String> _archived = <String>{};

  /// 全量合并 welcome 元数据，不移动事件光标；远端消失的会话保留为归档。
  void upsertWelcome(Iterable<SessionMetaDto> sessions) {
    final incoming = <String>{};
    for (final session in sessions) {
      incoming.add(session.id);
      final existing = _sessions[session.id];
      _sessions[session.id] = session.copyWith(
        lastSeq: existing?.lastSeq ?? session.lastSeq,
      );
      if (alignWelcomeCursor) {
        _lastSeq[session.id] = session.lastSeq;
      }
      _archived.remove(session.id);
    }
    for (final id in _sessions.keys.toList()) {
      if (!incoming.contains(id)) _archived.add(id);
    }
  }

  /// 写入事件并更新投影；重复 seq 幂等，乱序/缺洞按真实 seq 接收。
  bool applyEvent(SessionEventFrameDto frame) {
    final previousSeq = _lastSeq[frame.sessionId] ?? -1;
    if (strictSeq && frame.seq != previousSeq + 1) return false;
    final rows = _events.putIfAbsent(
      frame.sessionId,
      () => <SessionEventFrameDto>[],
    );
    if (rows.any((event) => event.seq == frame.seq)) return false;
    rows.add(frame);
    rows.sort((a, b) => a.seq.compareTo(b.seq));

    if (frame.seq > previousSeq) _lastSeq[frame.sessionId] = frame.seq;

    final meta = _sessions[frame.sessionId];
    if (meta != null && frame.agentEvent.type == 'state') {
      final previousStateSeq = _stateSeq[frame.sessionId] ?? -1;
      if (frame.seq >= previousStateSeq) {
        _stateSeq[frame.sessionId] = frame.seq;
        _sessions[frame.sessionId] = meta.copyWith(
          state: frame.agentEvent.state,
          lastSeq: _lastSeq[frame.sessionId],
        );
      }
    } else if (meta != null) {
      _sessions[frame.sessionId] = meta.copyWith(
        lastSeq: _lastSeq[frame.sessionId],
      );
    }
    return true;
  }

  /// 返回会话事件快照，按真实 seq 升序。
  List<SessionEventFrameDto> eventsFor(String sessionId) =>
      UnmodifiableListView<SessionEventFrameDto>(
        List<SessionEventFrameDto>.from(
          _events[sessionId] ?? const <SessionEventFrameDto>[],
        ),
      );

  /// 只为存在本地事件的会话生成 resume cursor；零事件会话被省略。
  Map<String, int> resumeCursors() => <String, int>{
    for (final entry in _events.entries)
      if (entry.value.isNotEmpty) entry.key: _lastSeq[entry.key] ?? -1,
  };

  /// 将服务端 welcome 中缺失的会话标记为只读归档。
  void archiveMissingSessions(Iterable<String> remoteIds) {
    final remote = remoteIds.toSet();
    for (final id in _sessions.keys) {
      if (!remote.contains(id)) _archived.add(id);
    }
  }

  /// 看板排序快照。
  List<SessionMetaDto> sessionsSnapshot() {
    final values = _sessions.values.toList()
      ..sort((a, b) {
        final updated = b.updatedAt.compareTo(a.updatedAt);
        return updated == 0 ? a.id.compareTo(b.id) : updated;
      });
    return List<SessionMetaDto>.unmodifiable(values);
  }

  SessionMetaDto? session(String id) => _sessions[id];

  bool isArchived(String id) => _archived.contains(id);

  int lastSeq(String sessionId) => _lastSeq[sessionId] ?? -1;
}

/// 离线发送队列的状态。
enum OutgoingMessageStatus { queued, sent, failed, cancelled }

/// 一条待发送文本；只有 send 文本进入该队列。
class OutgoingMessage {
  const OutgoingMessage({
    required this.clientId,
    required this.sessionId,
    required this.text,
    required this.ts,
    this.status = OutgoingMessageStatus.queued,
    this.attempts = 0,
    this.lastError,
  });

  final String clientId;
  final String sessionId;
  final String text;
  final int ts;
  final OutgoingMessageStatus status;
  final int attempts;
  final String? lastError;

  OutgoingMessage copyWith({
    OutgoingMessageStatus? status,
    int? attempts,
    String? lastError,
  }) => OutgoingMessage(
    clientId: clientId,
    sessionId: sessionId,
    text: text,
    ts: ts,
    status: status ?? this.status,
    attempts: attempts ?? this.attempts,
    lastError: lastError ?? this.lastError,
  );
}

/// 离线队列状态机；可由 Drift 表实现持久化，接口语义与存储无关。
class OutgoingMessageStore {
  final Map<String, OutgoingMessage> _messages = <String, OutgoingMessage>{};

  OutgoingMessage enqueue({
    required String clientId,
    required String sessionId,
    required String text,
    required int ts,
  }) {
    final message = OutgoingMessage(
      clientId: clientId,
      sessionId: sessionId,
      text: text,
      ts: ts,
    );
    _messages[clientId] = message;
    return message;
  }

  void markSent(String clientId) {
    final message = _messages[clientId];
    if (message == null) return;
    _messages[clientId] = message.copyWith(status: OutgoingMessageStatus.sent);
  }

  void markFailed(String clientId, String error, {bool retryable = false}) {
    final message = _messages[clientId];
    if (message == null) return;
    final attempts = message.attempts + 1;
    _messages[clientId] = message.copyWith(
      status: retryable && attempts < 3
          ? OutgoingMessageStatus.queued
          : OutgoingMessageStatus.failed,
      attempts: attempts,
      lastError: error,
    );
  }

  bool cancelQueued(String clientId) {
    final message = _messages[clientId];
    if (message == null || message.status != OutgoingMessageStatus.queued) {
      return false;
    }
    _messages[clientId] = message.copyWith(
      status: OutgoingMessageStatus.cancelled,
    );
    return true;
  }

  /// 崩溃恢复：所有非终态发送记录重新进入 queued。
  void recoverInFlight() {
    for (final entry in _messages.entries.toList()) {
      if (entry.value.status == OutgoingMessageStatus.queued) {
        continue;
      }
      if (entry.value.status == OutgoingMessageStatus.sent ||
          entry.value.status == OutgoingMessageStatus.cancelled) {
        continue;
      }
      _messages[entry.key] = entry.value.copyWith(
        status: OutgoingMessageStatus.queued,
      );
    }
  }

  List<OutgoingMessage> queuedInTsOrder() =>
      _messages.values
          .where((message) => message.status == OutgoingMessageStatus.queued)
          .toList()
        ..sort((a, b) => a.ts.compareTo(b.ts));

  OutgoingMessage? get(String clientId) => _messages[clientId];
}
