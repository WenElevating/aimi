import 'dart:io';

import 'package:aimi/data/logging/aimi_logger.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory tempDir;

  /// 等待条件成立（真实时钟轮询）；文件写入是异步批量，exists ≠ 已刷完。
  Future<void> waitFor(bool Function() condition, {int tries = 200}) async {
    for (var i = 0; i < tries && !condition(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    expect(condition(), isTrue);
  }

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('aimi-logger-test-');
  });

  tearDown(() async {
    AimiLogger.instance.dispose();
    // Windows：flush 的文件句柄可能尚未完全释放，重试删除。
    for (var i = 0; i < 20; i++) {
      try {
        tempDir.deleteSync(recursive: true);
        return;
      } on Object {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    }
  });

  /// 独立实例（不走全局单例，测试间互不污染）。
  AimiLogger fresh() => AimiLogger();

  test('环形缓冲：容量 800 满后挤最旧，快照保序', () {
    final logger = fresh();
    for (var i = 0; i < 810; i++) {
      logger.log(AimiLogLevel.info, 'test', 'line-$i');
    }
    final entries = logger.snapshot();
    expect(entries.length, AimiLogger.ringCapacity);
    expect(entries.first.message, 'line-10', reason: '最旧 10 条被挤出');
    expect(entries.last.message, 'line-809');
  });

  test('脱敏：token/password/authorization 值段掩码，普通文本不动', () {
    final logger = fresh();
    logger.log(AimiLogLevel.info, 'test', '连接 token=abc123&port=8787');
    logger.log(AimiLogLevel.info, 'test', r'"token": "sk-abcdef" 已掩码');
    logger.log(AimiLogLevel.info, 'test', 'authorization: Bearer xyz 值');
    logger.log(AimiLogLevel.info, 'test', '普通消息含 port=8787 不动');
    final texts = logger.snapshot().map((e) => e.message).toList();
    expect(texts[0], contains('token=***'));
    expect(texts[0], isNot(contains('abc123')));
    expect(texts[0], contains('&port=8787'));
    expect(texts[1], contains('"token": "***'));
    expect(texts[1], isNot(contains('sk-abcdef')));
    expect(texts[2], contains('authorization: ***'));
    expect(texts[2], isNot(contains('Bearer')));
    expect(texts[3], '普通消息含 port=8787 不动');
  });

  test('批量落盘：攒批阈值触发即写文件，行格式含时间戳/级别/组件', () async {
    final logger = fresh();
    await logger.init(Directory('${tempDir.path}${Platform.pathSeparator}logs'));
    for (var i = 0; i < AimiLogger.flushBatchSize; i++) {
      logger.log(AimiLogLevel.info, 'test', 'm-$i');
    }
    final file = File('${tempDir.path}${Platform.pathSeparator}logs${Platform.pathSeparator}aimi-0.log');
    await waitFor(() {
      if (!file.existsSync()) return false;
      return file.readAsLinesSync().length >= AimiLogger.flushBatchSize;
    });
    final lines = file.readAsLinesSync();
    expect(lines.length, AimiLogger.flushBatchSize);
    expect(lines.first, matches(RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3} \[info\] test: m-0$')));
    expect(lines.last, endsWith('m-${AimiLogger.flushBatchSize - 1}'));
  });

  test('滚动：写满单文件上限后滚动到 aimi-1.log，最旧被淘汰', () async {
    final logger = fresh();
    final logDir = Directory('${tempDir.path}${Platform.pathSeparator}logs');
    await logger.init(logDir);
    // 直接往文件写超限内容，模拟已写满 aimi-0.log。
    final file = File('${logDir.path}${Platform.pathSeparator}aimi-0.log');
    file.writeAsStringSync('x' * AimiLogger.maxFileBytes);
    logger.log(AimiLogLevel.info, 'test', 'trigger-roll');
    for (var i = 0; i < AimiLogger.flushBatchSize; i++) {
      logger.log(AimiLogLevel.info, 'test', 'after-roll-$i');
    }
    final rolled = File('${logDir.path}${Platform.pathSeparator}aimi-1.log');
    await waitFor(() => rolled.existsSync());
    await waitFor(() => file.existsSync() && file.lengthSync() < AimiLogger.maxFileBytes);
    expect(rolled.lengthSync(), AimiLogger.maxFileBytes, reason: '旧内容整体滚入 aimi-1');
  });

  test('IO 失败降级：目录被删后写日志不抛，进入冷却期后可恢复', () async {
    final logger = fresh();
    final logDir = Directory('${tempDir.path}${Platform.pathSeparator}logs');
    await logger.init(logDir);
    for (var i = 0; i < AimiLogger.flushBatchSize; i++) {
      logger.log(AimiLogLevel.info, 'test', 'before-fail-$i');
    }
    await Future<void>.delayed(const Duration(milliseconds: 100));
    // 删掉目录模拟磁盘故障。
    logDir.deleteSync(recursive: true);
    expect(() => logger.log(AimiLogLevel.warn, 'test', 'during-fail'), returnsNormally);
    for (var i = 0; i < AimiLogger.flushBatchSize; i++) {
      logger.log(AimiLogLevel.info, 'test', 'after-fail-$i');
    }
    await Future<void>.delayed(const Duration(milliseconds: 100));
    // 降级生效：内存环仍在，不抛错。
    expect(logger.snapshot().last.message, 'after-fail-${AimiLogger.flushBatchSize - 1}');
  });

  test('导出截尾：超过 maxChars 保留最新尾部', () {
    final logger = fresh();
    for (var i = 0; i < 100; i++) {
      logger.log(AimiLogLevel.info, 'test', 'content-$i');
    }
    final text = logger.exportRecentText(maxChars: 200);
    expect(text.length, lessThanOrEqualTo(200));
    expect(text, contains('content-99'), reason: '尾部（最新）保留');
  });

  test('初始化失败不抛出：目录不可创建时静默降级', () async {
    final logger = fresh();
    // 把「目录路径」指向一个已存在的文件，create(recursive) 必失败。
    final filePath = File('${tempDir.path}${Platform.pathSeparator}blocker');
    filePath.writeAsStringSync('not-a-dir');
    await logger.init(Directory(filePath.path));
    expect(() => logger.log(AimiLogLevel.error, 'test', 'still-alive'), returnsNormally);
    expect(logger.snapshot().last.message, 'still-alive');
  });
}
