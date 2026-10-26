import 'dart:async';

import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/cache/session_mirror.dart';
import '../data/observability/client_metrics.dart';
import '../data/observability/metrics.dart';
import '../data/protocol/frame_dto.dart';
import 'providers.dart';

/// 会话渲染窗口：镜像已实时接收事件，界面只在窗口边界提交最新的完整前缀。
class SessionRenderEventsController extends StateNotifier<List<AgentEventDto>> {
  /// 初次读取离线历史；后续只消费本会话的连接事件。
  SessionRenderEventsController(this._cache, this._sessionId, [this._metrics])
    : super(_cache?.agentEventsFor(_sessionId) ?? const []);

  final SessionMirror? _cache;
  final String _sessionId;
  final MetricRecorder? _metrics;
  Timer? _window;
  bool _frameFlushScheduled = false;
  double? _windowStartedAt;
  int _pendingText = 0;

  /// 文本/思考合并到 16ms 窗口，工具及终态等边界立即冲刷，尾部文本不会丢失。
  void onFrame(SessionEventFrameDto frame) {
    if (frame.sessionId != _sessionId || _cache == null) return;
    if (frame.agentEvent.type == 'text_delta' ||
        frame.agentEvent.type == 'thinking') {
      _windowStartedAt ??= _metrics?.monotonicMs;
      _pendingText += frame.agentEvent.text?.length ?? 0;
      _metrics?.record(
        'client.render.pending_events',
        1,
        context: {'sessionId': _sessionId},
      );
      _metrics?.record(
        'client.render.pending_text',
        _pendingText,
        context: {'sessionId': _sessionId},
      );
      _scheduleFrameFlush();
    } else {
      _flush();
    }
  }

  /// 在下一帧提交正文，后台或没有可见帧时以 32ms 兜底，避免事件回调自行触发布局。
  void _scheduleFrameFlush() {
    if (_frameFlushScheduled) return;
    _frameFlushScheduled = true;
    SchedulerBinding.instance.scheduleFrame();
    SchedulerBinding.instance.addPostFrameCallback((_) {
      _frameFlushScheduled = false;
      _flush();
    });
    _window = Timer(const Duration(milliseconds: 32), () {
      _frameFlushScheduled = false;
      _flush();
    });
  }

  /// 发布固定长度的只读前缀；不会复制或映射整个历史列表。
  void _flush() {
    _window?.cancel();
    _window = null;
    final next = _cache?.agentEventsFor(_sessionId);
    if (mounted && next != null && next.length != state.length) {
      final started = _windowStartedAt;
      if (started != null) {
        _metrics?.record(
          'client.render.notify_delay',
          _metrics.monotonicMs - started,
          context: {'sessionId': _sessionId},
        );
      }
      state = next;
    }
    _windowStartedAt = null;
    _pendingText = 0;
  }

  @override
  void dispose() {
    _window?.cancel();
    super.dispose();
  }
}

/// 仅订阅当前会话；其他会话的 token 不触发当前页历史读取或界面更新。
final _sessionRenderControllerProvider = StateNotifierProvider.autoDispose
    .family<SessionRenderEventsController, List<AgentEventDto>, String>((
      ref,
      sessionId,
    ) {
      final cache = ref.watch(cacheProvider).value;
      final connection = ref.watch(connectionProvider);
      final controller = SessionRenderEventsController(
        cache,
        sessionId,
        ref
            .read(metricsRuntimeProvider)
            .create('client.render', clientRenderMetrics),
      );
      final subscription = connection?.events.listen(controller.onFrame);
      ref.onDispose(() {
        if (subscription != null) unawaited(subscription.cancel());
      });
      return controller;
    });

/// 页面只依赖事件快照；测试可直接覆盖列表，无需创建连接或定时器。
final sessionRenderEventsProvider = Provider.autoDispose
    .family<List<AgentEventDto>, String>(
      (ref, sessionId) =>
          ref.watch(_sessionRenderControllerProvider(sessionId)),
    );
