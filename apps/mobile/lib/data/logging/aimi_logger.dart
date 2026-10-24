import 'dart:async';
import 'dart:collection';
import 'dart:io';

import 'package:flutter/foundation.dart';

/// 日志级别。
enum AimiLogLevel { debug, info, warn, error }

/// 单条日志（内存环与文件行的统一形态）。
class AimiLogEntry {
  const AimiLogEntry({
    required this.ts,
    required this.level,
    required this.component,
    required this.message,
  });

  /// 毫秒时间戳。
  final int ts;
  final AimiLogLevel level;

  /// 组件名（conn/session/update/settings…），用于按域过滤阅读。
  final String component;
  final String message;

  /// 文件行格式：`2026-10-24T09:12:33.456 [warn] conn: 消息`。
  String formatLine() {
    final t = DateTime.fromMillisecondsSinceEpoch(ts);
    String two(int v) => v.toString().padLeft(2, '0');
    final stamp =
        '${t.year}-${two(t.month)}-${two(t.day)}T'
        '${two(t.hour)}:${two(t.minute)}:${two(t.second)}.${t.millisecond.toString().padLeft(3, '0')}';
    return '$stamp [${level.name}] $component: $message';
  }
}

/// 敏感值脱敏：凭证类值段一律掩码（业界铁律：日志面只留掩码，导出时补救太晚）。
/// 命中形态：`token=xxx` / `token: xxx` / `"token": "xxx"`（键名不区分大小写）。
final RegExp _secretPattern = RegExp(
  '((?:token|password|authorization)\\S*?["\']?\\s*[:=]\\s*["\']?)[^\\s"&\',}]+',
  caseSensitive: false,
);

/// 掩码一条消息里的敏感值段；正则自身不抛，异常路径整体退回原文兜底。
String redactSecrets(String message) {
  try {
    return message.replaceAllMapped(_secretPattern, (Match m) => '${m.group(1)}***');
  } on Object {
    return message;
  }
}

/// 可追溯日志器：内存环形缓冲（即时查看）+ 滚动文件（进程死日志仍在）+ debugPrint（logcat 不断）。
///
/// 健壮性铁律（观察者不能先死）：
/// - [log] 同步入口只做内存操作与排队，永不抛出、永不阻塞 UI；
/// - 文件写入批量异步执行，**任何 IO 失败静默降级**为仅内存环 + debugPrint，
///   进入 [ioRetryCooldown] 冷却期后自动重试文件层；
/// - 待写队列有界（[pendingCapacity]），IO 假死时丢最旧，绝不无限堆积；
/// - 文件为追加写，不存在读旧内容损坏问题；滚动改名失败同 IO 降级路径。
class AimiLogger {
  /// 公共构造：测试建独立实例；生产走 [instance] 单例。
  AimiLogger();

  /// 全局单例；未 [init] 时所有日志仅入内存环与 debugPrint，仍可用。
  static final AimiLogger instance = AimiLogger();

  /// 内存环容量：满了挤最旧。
  static const int ringCapacity = 800;

  /// 待写队列容量：IO 假死时丢最旧的上界。
  static const int pendingCapacity = 2000;

  /// 单文件字节上限（1MB），超过滚动到 aimi-{n+1}.log。
  static const int maxFileBytes = 1024 * 1024;

  /// 滚动文件保留个数（总量封顶 3MB）。
  static const int fileCount = 3;

  /// 攒批阈值：待写条数达到即立刻落盘（否则等 [flushInterval]）。
  static const int flushBatchSize = 16;

  /// 攒批兜底间隔。
  static const Duration flushInterval = Duration(seconds: 1);

  /// IO 失败后的重试冷却期。
  static const Duration ioRetryCooldown = Duration(seconds: 30);

  final Queue<AimiLogEntry> _ring = Queue<AimiLogEntry>();
  final Queue<AimiLogEntry> _pending = Queue<AimiLogEntry>();
  Timer? _flushTimer;
  bool _flushing = false;
  DateTime _ioDisabledUntil = DateTime.fromMillisecondsSinceEpoch(0);
  Directory? _logDir;
  bool _disposed = false;

  /// 日志目录是否可用（false = 已降级为仅内存环）。
  bool get fileLoggingActive => _logDir != null;

  /// 初始化文件层；[dir] 为日志目录（如 `<appSupport>/logs`）。
  /// 目录创建失败不抛出——静默降级为仅内存环，冷却后重试。
  Future<void> init(Directory dir) async {
    try {
      await dir.create(recursive: true);
      _logDir = dir;
      unawaited(_flush());
    } on Object {
      _logDir = null;
      _ioDisabledUntil = DateTime.now().add(ioRetryCooldown);
    }
  }

  /// 测试与关停用：停掉 flush 定时器；内存内容保留。
  void dispose() {
    _disposed = true;
    _flushTimer?.cancel();
    _flushTimer = null;
  }

  /// 记一条日志：脱敏 → 入环 → 入待写队列 → debugPrint。
  /// 任何异常都被吞掉（日志器自身故障不得影响业务）。
  void log(AimiLogLevel level, String component, String message) {
    try {
      final entry = AimiLogEntry(
        ts: DateTime.now().millisecondsSinceEpoch,
        level: level,
        component: component,
        message: redactSecrets(message),
      );
      _ring.addLast(entry);
      while (_ring.length > ringCapacity) {
        _ring.removeFirst();
      }
      _pending.addLast(entry);
      while (_pending.length > pendingCapacity) {
        _pending.removeFirst();
      }
      debugPrint('[${level.name}] $component: ${entry.message}');
      _scheduleFlush();
    } on Object {
      // 日志器自身的任何意外都不得外溢。
    }
  }

  /// 内存环快照（旧→新）。
  List<AimiLogEntry> snapshot() => List<AimiLogEntry>.unmodifiable(_ring);

  /// 最近日志文本（旧→新）；[maxChars] 尾部截断（保留最新的）。
  String exportRecentText({int maxChars = 512 * 1024}) {
    final buffer = StringBuffer();
    for (final entry in _ring) {
      buffer.writeln(entry.formatLine());
    }
    final text = buffer.toString();
    if (text.length <= maxChars) return text;
    return text.substring(text.length - maxChars);
  }

  /// 滚动文件路径（aimi-0.log 最新，aimi-{fileCount-1}.log 最旧）。
  List<File> logFiles() {
    final dir = _logDir;
    if (dir == null) return const [];
    return [
      for (var i = 0; i < fileCount; i++) File('${dir.path}${Platform.pathSeparator}aimi-$i.log'),
    ];
  }

  /// 排队 flush：达到攒批阈值立刻，否则挂 [flushInterval] 定时器（只挂一个）。
  void _scheduleFlush() {
    if (_disposed || _logDir == null) return;
    if (_pending.length >= flushBatchSize) {
      unawaited(_flush());
      return;
    }
    _flushTimer ??= Timer(flushInterval, () {
      _flushTimer = null;
      unawaited(_flush());
    });
  }

  /// 批量落盘：IO 失败降级 + 冷却重试；滚动在写入前按当前文件大小判定。
  Future<void> _flush() async {
    if (_flushing || _disposed) return;
    final dir = _logDir;
    if (dir == null) return;
    if (_pending.isEmpty) return;
    if (DateTime.now().isBefore(_ioDisabledUntil)) return;
    _flushing = true;
    try {
      final target = File('${dir.path}${Platform.pathSeparator}aimi-0.log');
      var size = 0;
      try {
        size = await target.length();
      } on Object {
        size = 0; // 文件尚不存在
      }
      if (size >= maxFileBytes) await _roll(dir);
      final sink = target.openWrite(mode: FileMode.append);
      try {
        while (_pending.isNotEmpty) {
          final entry = _pending.removeFirst();
          sink.write('${entry.formatLine()}\n');
        }
      } finally {
        await sink.flush();
        await sink.close();
      }
    } on Object {
      // IO 故障（磁盘满/权限/目录被删）：降级为仅内存环，冷却后重试文件层。
      _ioDisabledUntil = DateTime.now().add(ioRetryCooldown);
      _pending.clear();
    } finally {
      _flushing = false;
    }
  }

  /// 滚动：aimi-{n}.log → aimi-{n+1}.log，最旧删除；单步失败即放弃本轮滚动
  /// （本轮写入继续追加到超限文件，下轮再滚——追加写不会因超限损坏）。
  Future<void> _roll(Directory dir) async {
    try {
      final oldest = File('${dir.path}${Platform.pathSeparator}aimi-${fileCount - 1}.log');
      if (await oldest.exists()) await oldest.delete();
      for (var i = fileCount - 2; i >= 0; i--) {
        final f = File('${dir.path}${Platform.pathSeparator}aimi-$i.log');
        if (await f.exists()) {
          await f.rename('${dir.path}${Platform.pathSeparator}aimi-${i + 1}.log');
        }
      }
    } on Object {
      // 滚动失败不视为致命：本轮继续写入原文件。
    }
  }
}

/// 全局日志入口；组件名用短横线小写（conn/session/update…）。
void aimiLog(AimiLogLevel level, String component, String message) {
  AimiLogger.instance.log(level, component, message);
}
