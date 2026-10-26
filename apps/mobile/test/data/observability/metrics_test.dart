import 'dart:async';
import 'package:aimi/data/observability/metrics.dart';
import 'package:flutter_test/flutter_test.dart';

/// 验证统一接口的重读、容量和确认行为，与具体连接实现无关。
void main() {
  const descriptor = MetricDescriptor(
    name: 'client.test.duration',
    kind: 'histogram',
    unit: 'ms',
    description: '测试耗时',
    boundary: '测试开始到结束',
  );
  test('读取无破坏性、全局有界并明确报告丢样', () async {
    final budget = MetricsBufferBudget(capacity: 3);
    final a = MetricRecorder(
      sourceId: 'a',
      descriptors: const [descriptor],
      budget: budget,
    );
    final b = MetricRecorder(
      sourceId: 'b',
      descriptors: const [descriptor],
      budget: budget,
    );
    a.record(descriptor.name, 1);
    b.record(descriptor.name, 2);
    a.record(descriptor.name, 3);
    a.record(descriptor.name, 4);
    final first = await a.readMetrics(
      const MetricsReadRequest(afterSequence: 0, limit: 128),
    );
    final second = await a.readMetrics(
      const MetricsReadRequest(afterSequence: 0, limit: 128),
    );
    expect(budget.length, 3);
    expect(first.batch.records.map((r) => r.value), [3, 4]);
    expect(first.batch.dropped, 1);
    expect(second.batch.toJson(), first.batch.toJson());
  });
  test('上报失败不推进游标，重试批次一致，关闭后发送结束状态', () async {
    final recorder = MetricRecorder(
      sourceId: 'test',
      descriptors: const [descriptor],
    );
    final sent = <MetricBatch>[];
    var fail = true;
    final collector = MetricsCollector(
      upload: (batch) async {
        sent.add(batch);
        if (fail) throw StateError('offline');
      },
    );
    collector.register(recorder);
    recorder.record(descriptor.name, 2);
    await collector.collect();
    fail = false;
    await collector.collect();
    expect(sent, hasLength(2));
    expect(sent[0].toJson(), sent[1].toJson());
    expect(collector.failedUploads, 1);
    await collector.collect();
    expect(sent, hasLength(2));
    recorder.close();
    await collector.collect();
    expect(sent.last.closed, isTrue);
    expect(collector.providerCount, 0);
    collector.dispose();
  });
  test('超时提供者不阻止其他来源采集', () async {
    final recorder = MetricRecorder(
      sourceId: 'healthy',
      descriptors: const [descriptor],
    );
    recorder.record(descriptor.name, 1);
    final sent = <MetricBatch>[];
    final collector = MetricsCollector(
      upload: (batch) async {
        sent.add(batch);
      },
      readTimeout: const Duration(milliseconds: 5),
    );
    collector.register(_HungProvider());
    collector.register(recorder);
    await collector.collect();
    expect(sent.single.source.sourceId, 'healthy');
    collector.dispose();
  });
  test('负值、未知指标和正文维度不会进入采集数据', () {
    final recorder = MetricRecorder(
      sourceId: 'safe',
      descriptors: const [descriptor],
    );
    expect(() => recorder.record('unknown', 1), throwsArgumentError);
    expect(() => recorder.record(descriptor.name, -1), throwsArgumentError);
    expect(
      () => recorder.record(descriptor.name, 1, context: {'prompt': 'secret'}),
      throwsArgumentError,
    );
  });
}

/// 模拟组件失去响应，证明采集器只依赖接口且隔离故障。
class _HungProvider implements MetricsProvider {
  @override
  MetricSource get source => const MetricSource(
    instanceId: 'hung-instance',
    sourceId: 'hung',
    component: 'client',
  );
  @override
  List<MetricDescriptor> describeMetrics() => const [];
  @override
  Future<MetricsReadResult> readMetrics(MetricsReadRequest request) =>
      Completer<MetricsReadResult>().future;
}
