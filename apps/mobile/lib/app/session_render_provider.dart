import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/cache/session_mirror.dart';
import '../data/protocol/frame_dto.dart';
import 'providers.dart';

/// 会话渲染窗口：镜像已实时接收事件，界面只在窗口边界提交最新的完整前缀。
class SessionRenderEventsController extends StateNotifier<List<AgentEventDto>> {
  /// 初次读取离线历史；后续只消费本会话的连接事件。
  SessionRenderEventsController(this._cache, this._sessionId)
    : super(_cache?.agentEventsFor(_sessionId) ?? const []);

  final SessionMirror? _cache;
  final String _sessionId;
  Timer? _window;

  /// 文本/思考合并到 16ms 窗口，工具及终态等边界立即冲刷，尾部文本不会丢失。
  void onFrame(SessionEventFrameDto frame) {
    if (frame.sessionId != _sessionId || _cache == null) return;
    if (frame.agentEvent.type == 'text_delta' ||
        frame.agentEvent.type == 'thinking') {
      _window ??= Timer(const Duration(milliseconds: 16), _flush);
    } else {
      _flush();
    }
  }

  /// 发布固定长度的只读前缀；不会复制或映射整个历史列表。
  void _flush() {
    _window?.cancel();
    _window = null;
    final next = _cache?.agentEventsFor(_sessionId);
    if (mounted && next != null && next.length != state.length) {
      state = next;
    }
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
      final controller = SessionRenderEventsController(cache, sessionId);
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
