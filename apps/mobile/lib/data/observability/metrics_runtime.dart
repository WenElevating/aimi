import 'dart:async';

import 'metrics.dart';

/// 组合根拥有的观测生命周期，提供者只依赖本地记录器。
class MetricsRuntime {
  /// upload 可替换为测试服务器；默认生产总容量分为环形缓冲与待确认批次各 1024 条。
  MetricsRuntime({
    required Future<void> Function(MetricBatch) upload,
    this.enabled = true,
    Map<String, Object> metadata = const {},
  }) : metadata = Map.of(metadata),
       collector = MetricsCollector(upload: upload);
  final bool enabled;
  final Map<String, Object> metadata;
  final MetricsCollector collector;
  final MetricsBufferBudget budget = MetricsBufferBudget(capacity: 1024);
  final Set<String> diagnosticSessions = {};
  final Set<MetricRecorder> _recorders = {};

  /// 一次组件实例对应一个来源，通过统一接口注册，采集器不知具体组件类型。
  MetricRecorder create(String sourceId, List<MetricDescriptor> descriptors) {
    final recorder = MetricRecorder(
      sourceId: sourceId,
      descriptors: descriptors,
      budget: budget,
      baseContext: () => metadata,
      detailedSample: (context) {
        final session = context['sessionId'];
        if (session is String && diagnosticSessions.contains(session)) {
          return true;
        }
        final key = '$session:${context['turnStartSeq']}';
        var hash = 0;
        for (final code in key.codeUnits) {
          hash = (hash * 31 + code) & 0x7fffffff;
        }
        return hash % 10 == 0;
      },
      enabled: enabled,
    );
    if (enabled) {
      recorder.onRecord = collector.notifyRecord;
      collector.register(recorder);
      _recorders.add(recorder);
    }
    return recorder;
  }

  /// 仅应用根启动常态采集；离线测试可手动 collect，不产生遗留定时器。
  void start() {
    if (enabled) collector.start();
  }

  /// 主动诊断将指定会话的详细事件采样提升至 100%。
  void diagnoseSession(String sessionId, {bool enabled = true}) {
    if (enabled) {
      diagnosticSessions.add(sessionId);
    } else {
      diagnosticSessions.remove(sessionId);
    }
  }

  /// 关闭组件记录器；允许调用方在 dispose 前显式 collect 收尾。
  Future<void> flush() => collector.collect();

  /// 停止定时器与所有记录器，调用方不等待网络即可释放应用。
  void dispose() {
    for (final recorder in _recorders) {
      recorder.onRecord = null;
      recorder.close();
    }
    _recorders.clear();
    collector.dispose();
  }
}
