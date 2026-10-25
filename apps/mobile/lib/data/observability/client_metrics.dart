import 'dart:ui';

import '../protocol/frame_dto.dart';
import 'metrics.dart';

/// 组件目录统一使用稳定名称，查询可跨客户端版本复用。
const clientConnectionMetrics = [
  MetricDescriptor(
    name: 'client.connection.receive_gap',
    kind: 'histogram',
    unit: 'ms',
    description: '会话事件接收间隔',
    boundary: '同会话前后两次 WebSocket 事件回调',
  ),
  MetricDescriptor(
    name: 'client.connection.parse',
    kind: 'histogram',
    unit: 'ms',
    description: '入帧解析耗时',
    boundary: 'WebSocket 回调开始到 DTO 解析完成',
  ),
  MetricDescriptor(
    name: 'client.connection.apply',
    kind: 'histogram',
    unit: 'ms',
    description: '镜像写入耗时',
    boundary: '连接调用镜像到同步合并完成，不含异步持久化',
  ),
  MetricDescriptor(
    name: 'client.connection.text_length',
    kind: 'counter',
    unit: 'utf16',
    description: '收到的正文长度',
    boundary: '已解析正文增量 UTF-16 码元数',
  ),
];
const clientMirrorMetrics = [
  MetricDescriptor(
    name: 'client.mirror.apply',
    kind: 'histogram',
    unit: 'ms',
    description: '镜像合并耗时',
    boundary: '去重、合并和投影，持久化仅排队',
  ),
  MetricDescriptor(
    name: 'client.mirror.duplicate',
    kind: 'counter',
    unit: 'count',
    description: '重复或不满足序号约束的事件',
    boundary: '镜像拒绝的事件数量',
  ),
];
const clientPersistenceMetrics = [
  MetricDescriptor(
    name: 'client.persistence.pending',
    kind: 'gauge',
    unit: 'count',
    description: '本地写库积压',
    boundary: '排队但尚未完成的 Drift 操作数',
  ),
  MetricDescriptor(
    name: 'client.persistence.queue_wait',
    kind: 'histogram',
    unit: 'ms',
    description: '本地写库等待',
    boundary: '操作入队到事务开始',
  ),
  MetricDescriptor(
    name: 'client.persistence.commit',
    kind: 'histogram',
    unit: 'ms',
    description: '本地写库耗时',
    boundary: '事务开始到 Future 完成',
  ),
];
const clientRenderMetrics = [
  MetricDescriptor(
    name: 'client.render.notify_delay',
    kind: 'histogram',
    unit: 'ms',
    description: '渲染通知等待',
    boundary: '渲染控制器收到该窗口首事件到发布新状态，不代表屏幕显示',
  ),
  MetricDescriptor(
    name: 'client.render.pending_events',
    kind: 'gauge',
    unit: 'count',
    description: '待通知事件数',
    boundary: '已收到但尚未提交给页面的事件数',
  ),
  MetricDescriptor(
    name: 'client.render.pending_text',
    kind: 'gauge',
    unit: 'utf16',
    description: '待通知正文长度',
    boundary: '当前渲染窗口尚未提交的 UTF-16 码元数',
  ),
];
const clientPageMetrics = [
  MetricDescriptor(
    name: 'client.page.projection',
    kind: 'histogram',
    unit: 'ms',
    description: '时间线投影耗时',
    boundary: 'ConversationProjection.update 调用范围',
  ),
  MetricDescriptor(
    name: 'client.page.build',
    kind: 'histogram',
    unit: 'ms',
    description: '会话页面构建耗时',
    boundary: 'SessionScreen.build 同步执行，不含子节点布局',
  ),
  MetricDescriptor(
    name: 'client.frame.build',
    kind: 'histogram',
    unit: 'ms',
    description: '框架帧构建耗时',
    boundary: 'Flutter FrameTiming.buildDuration，页面可见期间的全局帧',
  ),
  MetricDescriptor(
    name: 'client.frame.raster',
    kind: 'histogram',
    unit: 'ms',
    description: '帧光栅化耗时',
    boundary: 'Flutter FrameTiming.rasterDuration，页面可见期间的全局帧',
  ),
  MetricDescriptor(
    name: 'client.frame.over_budget',
    kind: 'histogram',
    unit: 'count',
    description: '超过设备刷新预算的帧',
    boundary: 'build 或 raster 任一超过 1000/refreshRate 毫秒时为 1',
  ),
  MetricDescriptor(
    name: 'client.scroll.offset_change',
    kind: 'histogram',
    unit: 'px',
    description: '滚动位置变化的绝对距离',
    boundary: '相邻 ScrollController 回调的逻辑像素差',
  ),
  MetricDescriptor(
    name: 'client.scroll.jump',
    kind: 'counter',
    unit: 'count',
    description: '底部对齐调用次数',
    boundary: '现有 jumpTo 调用次数，不改变滚动算法',
  ),
  MetricDescriptor(
    name: 'client.scroll.follow',
    kind: 'gauge',
    unit: 'count',
    description: '跟随输出状态',
    boundary: '自动跟随启用为 1，用户暂停为 0',
  ),
  MetricDescriptor(
    name: 'client.scroll.distance_to_bottom',
    kind: 'gauge',
    unit: 'px',
    description: '距底部的距离',
    boundary: 'maxScrollExtent-pixels 的绝对逻辑像素值',
  ),
  MetricDescriptor(
    name: 'client.scroll.content_growth',
    kind: 'histogram',
    unit: 'px',
    description: '内容高度增长',
    boundary: '相邻 scroll metrics 最大范围增长的逻辑像素值',
  ),
];

/// 跟踪当前会话回合，避免逐 token 扫描完整历史。
class MetricsEventContext {
  /// 来源记录器由组合根注入，内部仅保留有限会话状态。
  MetricsEventContext(this.recorder);
  final MetricRecorder recorder;
  final Map<String, int> _turns = {};
  final Map<String, int> _latest = {};
  final Map<String, double> _received = {};

  /// 保存事件序号及服务端 starting 事件对应的回合锚点。
  Map<String, Object> frameContext(SessionEventFrameDto frame) {
    if (_latest.length >= 128 && !_latest.containsKey(frame.sessionId)) {
      final oldest = _latest.keys.first;
      _latest.remove(oldest);
      _turns.remove(oldest);
      _received.remove(oldest);
    }
    final previous = _latest[frame.sessionId];
    if (previous == null || frame.seq > previous) {
      _latest[frame.sessionId] = frame.seq;
      if (frame.agentEvent.type == 'state' &&
          frame.agentEvent.state == 'starting') {
        _turns[frame.sessionId] = frame.seq;
      }
    }
    return {
      'sessionId': frame.sessionId,
      'seq': frame.seq,
      if (_turns[frame.sessionId] != null)
        'turnStartSeq': _turns[frame.sessionId]!,
    };
  }

  /// 只比较同一来源、同一会话的单调时钟。
  void receive(SessionEventFrameDto frame, double parsedMs) {
    final context = frameContext(frame);
    final now = recorder.monotonicMs;
    final previous = _received[frame.sessionId];
    if (previous != null) {
      recorder.record(
        'client.connection.receive_gap',
        now - previous,
        context: context,
      );
    }
    _received[frame.sessionId] = now;
    recorder.record('client.connection.parse', parsedMs, context: context);
    if (frame.agentEvent.type == 'text_delta') {
      recorder.record(
        'client.connection.text_length',
        frame.agentEvent.text?.length ?? 0,
        context: context,
      );
    }
  }

  /// 用最近事件关联页面和帧指标，未观察到回合时不编造回合号。
  Map<String, Object> forSession(String sessionId) => {
    'sessionId': sessionId,
    if (_latest[sessionId] != null) 'seq': _latest[sessionId]!,
    if (_turns[sessionId] != null) 'turnStartSeq': _turns[sessionId]!,
  };
}

/// 页面观测单独封装，SessionScreen 只在真实边界报告。
class SessionPageMetrics {
  /// 不注册 Flutter 全局回调，页面负责注册和注销生命周期。
  SessionPageMetrics(
    this.recorder, {
    required this.sessionId,
    required this.eventContext,
  });
  final MetricRecorder recorder;
  final String sessionId;
  final MetricsEventContext? eventContext;
  double refreshRate = 60;
  double? _lastOffset;
  double? _lastExtent;
  int _timingSample = 0;

  /// 本页面无法测量屏幕呈现，只记录 Flutter 给出的 build/raster。
  void timings(List<FrameTiming> timings) {
    final context = {
      ...?eventContext?.forSession(sessionId),
      'sessionId': sessionId,
      'refreshRate': refreshRate,
    };
    for (final timing in timings) {
      final sample = _timingSample++ % 4 == 0;
      final build = timing.buildDuration.inMicroseconds / 1000;
      final raster = timing.rasterDuration.inMicroseconds / 1000;
      if (sample) {
        recorder.record('client.frame.build', build, context: context);
        recorder.record('client.frame.raster', raster, context: context);
      }
      recorder.record(
        'client.frame.over_budget',
        build > 1000 / refreshRate || raster > 1000 / refreshRate ? 1 : 0,
        context: context,
      );
    }
  }

  /// 使用已有滚动通知，不修改位置和跟随行为。
  void scroll({
    required double offset,
    required double extent,
    required bool follow,
    bool jump = false,
  }) {
    final context = {
      ...?eventContext?.forSession(sessionId),
      'sessionId': sessionId,
    };
    if (_lastOffset != offset) {
      if (_lastOffset != null) {
        recorder.record(
          'client.scroll.offset_change',
          (offset - _lastOffset!).abs(),
          context: context,
        );
      }
      recorder.record(
        'client.scroll.distance_to_bottom',
        (extent - offset).abs(),
        context: context,
      );
      _lastOffset = offset;
    }
    if (_lastExtent != null && extent > _lastExtent!) {
      recorder.record(
        'client.scroll.content_growth',
        extent - _lastExtent!,
        context: context,
      );
    }
    _lastExtent = extent;
    recorder.record('client.scroll.follow', follow ? 1 : 0, context: context);
    if (jump) {
      recorder.record('client.scroll.jump', 1, context: context);
    }
  }
}
