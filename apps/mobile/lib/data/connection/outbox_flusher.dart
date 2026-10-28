import 'dart:async';

import '../cache/session_mirror.dart';
import '../protocol/frame_dto.dart';
import 'aimi_connection.dart';

/// 离线发送队列的补发服务：把 `OutgoingMessageStore` 里 `queued` 状态的消息
/// 在连接就绪后按发送顺序补发出去。
///
/// 职责与约束：
/// - **幂等安全**：补发沿用入队时的原 `clientId`，服务端按 clientId 去重
///   （协议 `agentCommands.ts` 契约），断线重试不会重复执行。
/// - **只补 send 文本**：interrupt/approve/answer/configure 是时敏或状态型
///   指令，离线期间由调用方直接失败提示，不进入本队列。
/// - **运行中暂缓**：目标会话处于 starting/running 时跳过（与 UI 待发胶囊
///   的语义一致——运行中的输入不该立即落 stdin），等该会话 state 事件
///   回到非运行态后再自动续排。
/// - **回执口径**：`delivered`/`duplicate` 都算成功（duplicate = 服务端已
///   处理过同 clientId）；`rejected` 为终态失败；等待回执超时按 retryable
///   回队，重试 [retryDelay] 后再试，超过队列状态机的 3 次上限落 failed。
///
/// 触发时机：连接进入在线态、目标会话 state 事件到达、以及超时重试定时器。
class OutboxFlusher {
  /// 构建补发服务；[retryDelay] 供测试注入短延迟，默认 3 秒退避。
  OutboxFlusher({
    required AimiConnection connection,
    required OutgoingMessageStore store,
    required SessionMirror cache,
    this.retryDelay = const Duration(seconds: 3),
  }) : _connection = connection,
       _store = store,
       _cache = cache;

  /// 被补发的连接（同时是状态源）。
  final AimiConnection _connection;

  /// 离线队列（状态唯一权威）。
  final OutgoingMessageStore _store;

  /// 会话镜像：读目标会话当前 state 以决定是否暂缓。
  final SessionMirror _cache;

  /// 补发失败后的重试退避。
  final Duration retryDelay;

  StreamSubscription<ConnState>? _stateSub;
  StreamSubscription<SessionEventFrameDto>? _eventsSub;
  Timer? _retryTimer;
  bool _draining = false;
  bool _disposed = false;

  /// 最近一次观测到的连接状态；StateNotifier 的 `state` getter 受测试域
  /// 限制，订阅方一律经 [AimiConnection.stream] 跟踪（订阅时同步补发当前值）。
  ConnState _lastState = ConnState.offline;

  /// 开始监听连接状态与会话事件；已在在线态时立即尝试一轮（覆盖进程
  /// 重启后队列里还有存留消息、而连接由其它入口拉起的场景）。
  void start() {
    _stateSub = _connection.stream.listen(_onConnectionState);
    _eventsSub = _connection.events
        .where((frame) => frame.agentEvent.type == 'state')
        .listen((_) => _kickDrain());
    if (_isOnline) unawaited(drain());
  }

  /// 释放订阅与重试定时器；之后的 drain 调用为空操作。
  void dispose() {
    _disposed = true;
    unawaited(_stateSub?.cancel());
    unawaited(_eventsSub?.cancel());
    _retryTimer?.cancel();
    _retryTimer = null;
  }

  bool get _isOnline =>
      _lastState == ConnState.onlineLan ||
      _lastState == ConnState.onlineRelay;

  void _onConnectionState(ConnState state) {
    _lastState = state;
    if (state == ConnState.onlineLan || state == ConnState.onlineRelay) {
      _kickDrain();
    }
  }

  /// 事件/状态触发的补发入口：队列无存货时是廉价空转。
  void _kickDrain() {
    if (_store.queuedInTsOrder().isEmpty) return;
    unawaited(drain());
  }

  /// 排空一轮队列。可重入安全：并发调用只执行一轮，其余直接返回。
  ///
  /// 返回条件（满足其一）：队列空、连接离线、所有存货的目标会话都在运行、
  /// 某条消息等待回执超时（转重试定时器）。
  Future<void> drain() async {
    if (_disposed || _draining) return;
    _draining = true;
    try {
      while (!_disposed && _isOnline) {
        final target = _nextSendable();
        if (target == null) return;
        // 命令生命周期节点①由连接层记录；这里沿用同一 clientId 补发。
        final ack = await _connection.sendCommand(
          target.sessionId,
          target.clientId,
          AgentCommandDto.send(target.text),
        );
        if (_disposed) return;
        if (ack == null) {
          // 超时或连接中断：退避重试，状态机 3 次上限后自动落 failed。
          _store.markFailed(target.clientId, '等待服务端回执超时', retryable: true);
          _scheduleRetry();
          return;
        }
        if (ack.status == 'rejected') {
          _store.markFailed(
            target.clientId,
            ack.code != null ? '服务端拒绝（${ack.code}）' : '服务端拒绝',
          );
          continue;
        }
        // delivered / duplicate 都视为已投递（duplicate = 服务端已处理过）。
        _store.markSent(target.clientId);
      }
    } finally {
      _draining = false;
    }
  }

  /// 取最早一条「目标会话不在运行态」的存货；全部暂缓时返回 null。
  OutgoingMessage? _nextSendable() {
    for (final message in _store.queuedInTsOrder()) {
      final state = _cache.session(message.sessionId)?.state;
      if (state == 'running' || state == 'starting') continue;
      return message;
    }
    return null;
  }

  /// 单次退避重试；多个触发源不会叠加多个定时器。
  void _scheduleRetry() {
    if (_disposed || _retryTimer != null) return;
    _retryTimer = Timer(retryDelay, () {
      _retryTimer = null;
      _kickDrain();
    });
  }
}
