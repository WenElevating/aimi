import 'dart:async';
import 'dart:collection';

import 'package:uuid/uuid.dart';

/// 与服务端共享契约对应的指标定义，不允许任意正文标签。
class MetricDescriptor {
  /// 定义单位和真实观测边界，不把不可用的指标伪装为零值。
  const MetricDescriptor({
    required this.name,
    required this.kind,
    required this.unit,
    required this.description,
    required this.boundary,
    this.availability = 'available',
    this.reason,
  });
  final String name;
  final String kind;
  final String unit;
  final String description;
  final String boundary;
  final String availability;
  final String? reason;

  /// 按服务端严格契约序列化目录。
  Map<String, Object> toJson() => {
    'name': name,
    'kind': kind,
    'unit': unit,
    'description': description,
    'boundary': boundary,
    'availability': availability,
    if (reason != null) 'reason': reason as Object,
  };
}

/// 一次组件生命周期的来源，重启后使用新的实例标识。
class MetricSource {
  /// 创建与服务端协议一致的来源描述。
  const MetricSource({
    required this.instanceId,
    required this.sourceId,
    required this.component,
  });
  final String instanceId;
  final String sourceId;
  final String component;

  /// 保留组件抽象，采集器不识别具体实现。
  Map<String, Object> toJson() => {
    'instanceId': instanceId,
    'sourceId': sourceId,
    'component': component,
  };
}

/// 单个有限数值观测，时间分别用于查询及进程内耗时。
class MetricRecord {
  /// 冻结入缓冲时的上下文，后续回合切换不会改写历史样本。
  MetricRecord({
    required this.sequence,
    required this.name,
    required this.value,
    required this.ts,
    required this.monoMs,
    required Map<String, Object> context,
    this.detail,
  }) : context = Map.unmodifiable(context);
  final int sequence;
  final String name;
  final double value;
  final int ts;
  final double monoMs;
  final Map<String, Object> context;
  final String? detail;

  /// 仅发送声明过的技术字段。
  Map<String, Object> toJson() => {
    'sequence': sequence,
    'name': name,
    'value': value,
    'ts': ts,
    'monoMs': monoMs,
    'context': context,
    if (detail != null) 'detail': detail as Object,
  };
}

/// 一次来源的有界增量上报，包含目录和数据完整性。
class MetricBatch {
  /// 创建不可变记录列表，供未确认的上传安全重试。
  MetricBatch({
    required this.source,
    required Iterable<MetricDescriptor> descriptors,
    required Iterable<MetricRecord> records,
    required this.dropped,
    required this.closed,
  }) : descriptors = List.unmodifiable(descriptors),
       records = List.unmodifiable(records);
  final MetricSource source;
  final List<MetricDescriptor> descriptors;
  final List<MetricRecord> records;
  final int dropped;
  final bool closed;

  /// HTTP 正文直接采用该结构，与 TypeScript MetricBatch 对齐。
  Map<String, Object> toJson() => {
    'source': source.toJson(),
    'descriptors': descriptors.map((d) => d.toJson()).toList(),
    'records': records.map((r) => r.toJson()).toList(),
    'dropped': dropped,
    'closed': closed,
  };
}

/// 读取不移除数据，只有服务端持久化确认后才推进采集游标。
class MetricsReadRequest {
  /// limit 不得超过 HTTP 每批 128 条的约束。
  const MetricsReadRequest({required this.afterSequence, required this.limit});
  final int afterSequence;
  final int limit;
}

/// 即使空批也能报告目录、关闭及丢样状态。
class MetricsReadResult {
  /// nextSequence 只覆盖当前已读取的范围。
  const MetricsReadResult({required this.batch, required this.nextSequence});
  final MetricBatch batch;
  final int nextSequence;
}

/// 客户端组件统一实现的观测接口，采集器不访问内部状态。
abstract interface class MetricsProvider {
  MetricSource get source;
  List<MetricDescriptor> describeMetrics();
  Future<MetricsReadResult> readMetrics(MetricsReadRequest request);
}

/// 共享所有组件的全局容量，而非对每个会话各分配一份无限队列。
class MetricsBufferBudget {
  /// 默认限制客户端总共保留 2048 条记录。
  MetricsBufferBudget({this.capacity = 2048}) {
    if (capacity < 1) throw ArgumentError.value(capacity, 'capacity');
  }
  final int capacity;
  final LinkedHashMap<(MetricRecorder, int), MetricRecord> _entries =
      LinkedHashMap();
  int get length => _entries.length;

  /// 优先移除详细轨迹；基础指标仍必须有界并报告损失。
  void _add(MetricRecorder owner, MetricRecord record) {
    if (_entries.length >= capacity) {
      final key = _entries.keys.firstWhere(
        (key) => _entries[key]!.detail != null,
        orElse: () => _entries.keys.first,
      );
      _entries.remove(key);
      key.$1._dropped++;
    }
    _entries[(owner, record.sequence)] = record;
  }

  /// 按来源和游标读取，结果顺序与来源单调序号相同。
  Iterable<MetricRecord> _read(MetricRecorder owner, int afterSequence) sync* {
    for (final entry in _entries.entries) {
      if (identical(entry.key.$1, owner) && entry.key.$2 > afterSequence) {
        yield entry.value;
      }
    }
  }
}

/// 组件本地记录器，也是统一 MetricsProvider 的一个实现。
class MetricRecorder implements MetricsProvider {
  /// 外部可注入时钟和共享容量，以便确定性测试和全局开销限制。
  MetricRecorder({
    required String sourceId,
    required Iterable<MetricDescriptor> descriptors,
    MetricsBufferBudget? budget,
    String? instanceId,
    double Function()? monotonicMs,
    DateTime Function()? now,
    Map<String, Object> Function()? baseContext,
    bool Function(Map<String, Object>)? detailedSample,
    this.enabled = true,
  }) : source = MetricSource(
         instanceId: instanceId ?? Uuid().v4(),
         sourceId: sourceId,
         component: 'client',
       ),
       _descriptors = List.unmodifiable(descriptors),
       _budget = budget ?? MetricsBufferBudget(capacity: 64),
       _monotonicMs = monotonicMs ?? _clockMs,
       _now = now ?? DateTime.now,
       _baseContext = baseContext,
       _detailedSample = detailedSample {
    _names = _descriptors
        .where((d) => d.availability == 'available')
        .map((d) => d.name)
        .toSet();
  }
  static final Stopwatch _clock = Stopwatch()..start();

  /// 所有本进程来源使用同一单调时钟，允许本机各阶段关联。
  static double _clockMs() => _clock.elapsedMicroseconds / 1000;
  static const Set<String> _contexts = {
    'sessionId',
    'turnStartSeq',
    'seq',
    'seqEnd',
    'agentId',
    'model',
    'appVersion',
    'buildMode',
    'deviceModel',
    'refreshRate',
    'renderer',
    'scenario',
  };
  static const Set<String> _details = {
    'ok',
    'error',
    'cancelled',
    'timeout',
    'interrupted',
    'completed',
    'replay',
    'background',
    'foreground',
  };
  @override
  final MetricSource source;
  final List<MetricDescriptor> _descriptors;
  late final Set<String> _names;
  final MetricsBufferBudget _budget;
  final double Function() _monotonicMs;
  final DateTime Function() _now;
  final Map<String, Object> Function()? _baseContext;
  final bool Function(Map<String, Object>)? _detailedSample;
  final bool enabled;
  int _sequence = 0;
  int _dropped = 0;
  bool _closed = false;
  void Function()? onRecord;
  double get monotonicMs => _monotonicMs();
  bool get isClosed => _closed;
  @override
  /// 目录在来源生命周期内稳定。
  List<MetricDescriptor> describeMetrics() => _descriptors;

  /// 只接受声明的有限非负数和白名单维度；不记录任何业务正文。
  void record(
    String name,
    num value, {
    Map<String, Object> context = const {},
    String? detail,
  }) {
    if (_closed || !enabled) return;
    if (!_names.contains(name) || !value.isFinite || value < 0) {
      throw ArgumentError('Invalid metric name/value');
    }
    final dimensions = {...?_baseContext?.call(), ...context};
    if (dimensions.keys.any((key) => !_contexts.contains(key)) ||
        (detail != null && !_details.contains(detail))) {
      throw ArgumentError('Invalid metric context/detail');
    }
    if (_detailedSample != null && !_detailedSample(dimensions)) {
      dimensions.remove('seq');
      dimensions.remove('seqEnd');
    }
    _budget._add(
      this,
      MetricRecord(
        sequence: ++_sequence,
        name: name,
        value: value.toDouble(),
        ts: _now().millisecondsSinceEpoch,
        monoMs: monotonicMs,
        context: dimensions,
        detail: detail,
      ),
    );
    onRecord?.call();
  }

  @override
  /// 非破坏性读取保留重试能力；缺失样本由 dropped 显式反映。
  Future<MetricsReadResult> readMetrics(MetricsReadRequest request) async {
    if (request.limit < 1 || request.limit > 128 || request.afterSequence < 0) {
      throw ArgumentError('Invalid metric cursor');
    }
    final records = _budget
        ._read(this, request.afterSequence)
        .take(request.limit)
        .toList();
    final next = records.isEmpty ? _sequence : records.last.sequence;
    return MetricsReadResult(
      batch: MetricBatch(
        source: source,
        descriptors: _descriptors,
        records: records,
        dropped: _dropped,
        closed: _closed && next >= _sequence,
      ),
      nextSequence: next,
    );
  }

  /// 关闭后仍允许采集尾部，来源由采集器在确认后移除。
  void close() {
    _closed = true;
    onRecord?.call();
  }
}

/// 保存每个来源的已持久化边界及在途批次。
class _ProviderCursor {
  /// 游标只能由对应来源的成功确认推进。
  _ProviderCursor(this.provider);
  final MetricsProvider provider;
  int sequence = 0;
  int dropped = -1;
  MetricsReadResult? pending;
}

/// 采集器只读取统一接口，任一来源或上传故障不会进入业务路径。
class MetricsCollector {
  /// upload 成功必须表示服务端已经持久化，失败保留原批次用于幂等重试。
  MetricsCollector({
    required this.upload,
    this.readTimeout = const Duration(seconds: 1),
    this.uploadTimeout = const Duration(seconds: 5),
    this.pendingCapacity = 1024,
  });
  final Future<void> Function(MetricBatch) upload;
  final Duration readTimeout;
  final Duration uploadTimeout;
  final int pendingCapacity;
  final Map<String, _ProviderCursor> _providers = {};
  Timer? _timer;
  bool _collecting = false;
  bool _disposed = false;
  int _sinceCollection = 0;
  int failedUploads = 0;
  int failedReads = 0;
  int get providerCount => _providers.length;

  /// 来源以实例去重；组件内部类型对采集器不可见。
  void register(MetricsProvider provider) {
    if (_disposed) return;
    _providers.putIfAbsent(
      provider.source.instanceId,
      () => _ProviderCursor(provider),
    );
  }

  /// 组合根调用，业务组件不持有采集定时器。
  void start() {
    _timer ??= Timer.periodic(
      const Duration(seconds: 2),
      (_) => unawaited(collect()),
    );
  }

  /// 达到批量阈值仅调度异步采集，不阻塞正文处理。
  void notifyRecord() {
    if (++_sinceCollection >= 128 && !_collecting && !_disposed) {
      _sinceCollection = 0;
      scheduleMicrotask(() => unawaited(collect()));
    }
  }

  /// 每次各来源最多一批，避免高频来源饿死其他来源或无限冲刷。
  Future<void> collect() async {
    if (_collecting || _disposed) return;
    _collecting = true;
    _sinceCollection = 0;
    try {
      for (final entry in _providers.entries.toList()) {
        if (_disposed) break;
        final cursor = entry.value;
        final pendingCount = _providers.values.fold<int>(
          0,
          (sum, item) => sum + (item.pending?.batch.records.length ?? 0),
        );
        if (cursor.pending == null && pendingCount >= pendingCapacity) continue;
        try {
          cursor.pending ??= await cursor.provider
              .readMetrics(
                MetricsReadRequest(
                  afterSequence: cursor.sequence,
                  limit: (pendingCapacity - pendingCount).clamp(1, 128),
                ),
              )
              .timeout(readTimeout);
        } on Object {
          failedReads++;
          continue;
        }
        final result = cursor.pending!;
        if (result.batch.records.isEmpty &&
            !result.batch.closed &&
            result.batch.dropped == cursor.dropped) {
          cursor.pending = null;
          continue;
        }
        try {
          await upload(result.batch).timeout(uploadTimeout);
        } on Object {
          failedUploads++;
          continue;
        }
        cursor.sequence = result.nextSequence;
        cursor.dropped = result.batch.dropped;
        cursor.pending = null;
        if (result.batch.closed) _providers.remove(entry.key);
      }
    } finally {
      _collecting = false;
    }
  }

  /// 取消后续调度，已经发出的 HTTP 请求仍由共享 HTTP client 管理。
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _providers.clear();
  }
}
