import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:share_plus/share_plus.dart';

import 'aimi_logger.dart';

/// 日志导出：内存环 + 全部滚动文件打包为 zip，经系统分享面板发出
/// （微信/文件管理器/邮件均可作为去处；后续反馈功能直接取该 zip 上传）。
class LogExporter {
  LogExporter(this._logger);

  final AimiLogger _logger;

  /// 打包日志为 zip 并返回文件；[now] 注入时间戳便于测试。
  ///
  /// zip 内结构：`recent.log`（环形缓冲文本，含未落盘的最新若干条）+ 各滚动
  /// 文件原名（aimi-0.log 最新）。写入 `<tmp>/aimi-logs-{ts}.zip`。
  /// 任何失败抛出由调用方呈现（导出是用户主动动作，失败要可见）。
  Future<File> exportZip({DateTime? now}) async {
    final stamp = _stamp(now ?? DateTime.now());
    final dir = await _tempDir();
    final zipFile = File('${dir.path}${Platform.pathSeparator}aimi-logs-$stamp.zip');

    final archive = Archive();
    // 环形缓冲：可能含尚未批量落盘的最新日志，作为独立文件入包。
    final recent = _logger.exportRecentText();
    // 必须显式按 UTF-8 编码后入包：ArchiveFile 直接收 String 会按码元截断成
    // 单字节，中文全部损坏（真实反馈中 recent.log 曾因此整包乱码）。
    final recentBytes = utf8.encode(recent);
    archive.addFile(
      ArchiveFile('recent.log', recentBytes.length, recentBytes),
    );
    // 滚动文件：原名入包，读取失败跳过单文件不放弃整包。
    for (final file in _logger.logFiles()) {
      try {
        if (!await file.exists()) continue;
        final bytes = await file.readAsBytes();
        archive.addFile(
          ArchiveFile('logs/${file.uri.pathSegments.last}', bytes.length, bytes),
        );
      } on Object {
        // 单文件读取失败（占用/权限）：跳过，包内还有 recent.log 兜底。
      }
    }
    final encoded = ZipEncoder().encode(archive);
    await zipFile.writeAsBytes(encoded, flush: true);
    return zipFile;
  }

  /// 调起系统分享面板；[subject] 为分享标题。
  Future<void> share(File zip, {String subject = 'aimi 运行日志'}) async {
    await SharePlus.instance.share(
      ShareParams(files: [XFile(zip.path)], subject: subject),
    );
  }

  /// 时间戳：`20261024-091233`。
  String _stamp(DateTime t) {
    String two(int v) => v.toString().padLeft(2, '0');
    return '${t.year}${two(t.month)}${two(t.day)}-${two(t.hour)}${two(t.minute)}${two(t.second)}';
  }

  Future<Directory> _tempDir() async {
    final base = await Directory.systemTemp.createTemp('aimi-export');
    return base;
  }
}
