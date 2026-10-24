import 'dart:io';

import 'package:aimi/data/logging/aimi_logger.dart';
import 'package:aimi/data/logging/log_export.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory tempDir;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('aimi-log-export-test-');
  });

  tearDown(() async {
    for (var i = 0; i < 20; i++) {
      try {
        tempDir.deleteSync(recursive: true);
        return;
      } on Object {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    }
  });

  test('导出 zip：含 recent.log 与滚动文件，时间戳命名', () async {
    final logger = AimiLogger();
    final logDir = Directory('${tempDir.path}${Platform.pathSeparator}logs');
    await logger.init(logDir);
    logger.log(AimiLogLevel.info, 'test', '内存环内容');
    // 手工造一个滚动文件（模拟已落盘历史）。
    File('${logDir.path}${Platform.pathSeparator}aimi-0.log').writeAsStringSync(
      '2026-10-24T09:00:00.000 [info] conn: 已连接\n',
    );

    final exporter = LogExporter(logger);
    final zip = await exporter.exportZip(now: DateTime(2026, 10, 24, 9, 0, 1));

    expect(zip.path, endsWith('aimi-logs-20261024-090001.zip'));
    expect(zip.existsSync(), isTrue);
    final bytes = zip.readAsBytesSync();
    expect(bytes.length, greaterThan(100));
    // zip 魔法字节。
    expect(bytes.sublist(0, 2), [0x50, 0x4B]);
  });

  test('导出 zip：日志目录不可用（未 init）时仍能产出 recent.log 包', () async {
    final logger = AimiLogger(); // 未 init：仅内存环
    logger.log(AimiLogLevel.warn, 'test', '只有内存内容');
    final exporter = LogExporter(logger);
    final zip = await exporter.exportZip();
    expect(zip.existsSync(), isTrue);
    expect(zip.lengthSync(), greaterThan(100));
  });

  test('logFiles 未 init 时为空列表', () {
    final logger = AimiLogger();
    expect(logger.logFiles(), isEmpty);
  });
}
