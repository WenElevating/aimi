import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../connection/aimi_connection.dart';
import '../logging/aimi_logger.dart';
import '../logging/log_export.dart';

/// 一次反馈提交的图片（已选文件路径）。
class FeedbackImage {
  const FeedbackImage({required this.path, required this.name});

  /// 本地文件路径（image_picker 产物）。
  final String path;

  /// 原始文件名（服务端 meta 留痕，落盘文件用随机编号）。
  final String name;
}

/// 反馈附带的 app 信息（版本三元组；来自 PackageInfo 与 Platform）。
class FeedbackAppInfo {
  const FeedbackAppInfo({
    required this.version,
    required this.build,
    required this.platform,
  });

  /// versionName（如 1.0.8）。
  final String version;

  /// versionCode（如 9）。
  final String build;

  /// 平台与系统版本（如 "Android 16"）。
  final String platform;
}

/// 反馈上传结果。
class FeedbackSubmitResult {
  const FeedbackSubmitResult({required this.id});

  /// 服务端生成的反馈 id（与 `{dataDir}/feedback/{id}/` 目录一致）。
  final String id;
}

/// 问题反馈上传器：描述 + 图片 + 运行日志 zip 打包 POST 到服务端 `/feedback`。
///
/// - URL 按当前 [AimiEndpoints] 拼 `http(s)://host:port/feedback`（ws→http /
///   wss→https，与更新下载同法）；header `x-aimi-token` 携带设备令牌；
/// - HTTP client 由调用方注入（生产为 apkHttpClientProvider——自带自签 TLS 指纹放行）；
/// - 运行日志 zip 由 [LogExporter] 现场打包（环形缓冲 + 滚动文件）；打包失败
///   **不阻断提交**——反馈无日志也比发不出去强，只记一条日志留痕。
class FeedbackUploader {
  FeedbackUploader({
    required this.endpoints,
    required FeedbackAppInfo appInfo,
    required http.Client client,
    LogExporter? exporter,
  }) : _appInfo = appInfo,
       _client = client,
       _exporter = exporter ?? LogExporter(AimiLogger.instance);

  final AimiEndpoints endpoints;
  final FeedbackAppInfo _appInfo;
  final http.Client _client;
  final LogExporter _exporter;

  /// 提交反馈；成功返回反馈 id，失败抛 [FeedbackException]。
  ///
  /// [desc] 已由表单校验非空；[images] 为用户挑选的截图；运行日志自动附带。
  Future<FeedbackSubmitResult> submit({
    required String desc,
    required List<FeedbackImage> images,
  }) async {
    final zipBase64 = await _attachLogZip();
    final body = <String, dynamic>{
      'desc': desc,
      'app': {'version': _appInfo.version, 'build': _appInfo.build, 'platform': _appInfo.platform},
      'logZipB64': ?zipBase64,
      if (images.isNotEmpty)
        'images': [
          for (final image in images)
            {'name': image.name, 'b64': base64Encode(await File(image.path).readAsBytes())},
        ],
    };
    final response = await _client.post(
      _endpointUri('/feedback'),
      headers: {'x-aimi-token': endpoints.token, 'content-type': 'application/json'},
      body: jsonEncode(body),
    );
    if (response.statusCode == 201) {
      final decoded = jsonDecode(response.body) as Map<String, dynamic>;
      final id = decoded['id'];
      if (id is! String || id.isEmpty) {
        throw FeedbackException('服务端应答异常');
      }
      aimiLog(AimiLogLevel.info, 'feedback', '反馈已提交 id=$id（${images.length} 图, 带日志=${zipBase64 != null}）');
      return FeedbackSubmitResult(id: id);
    }
    final detail = switch (response.statusCode) {
      401 => '令牌已失效，请重新配对',
      413 => '附件过大（图片或日志超出上限）',
      429 => '提交过于频繁，请稍后再试',
      _ => '服务端返回 ${response.statusCode}',
    };
    aimiLog(AimiLogLevel.warn, 'feedback', '反馈提交失败：$detail');
    throw FeedbackException(detail);
  }

  /// 现场打包运行日志 zip 并转 base64；失败返回 null（提交继续，无日志附带）。
  Future<String?> _attachLogZip() async {
    try {
      final zip = await _exporter.exportZip();
      return base64Encode(await File(zip.path).readAsBytes());
    } on Object catch (error) {
      aimiLog(AimiLogLevel.warn, 'feedback', '日志打包失败（不带日志提交）：$error');
      return null;
    }
  }

  /// 反馈端点地址（ws→http / wss→https，与更新下载同法）。
  Uri _endpointUri(String path) {
    return Uri(
      scheme: endpoints.scheme == 'wss' ? 'https' : 'http',
      host: endpoints.host,
      port: endpoints.port,
      path: path,
    );
  }
}

/// 反馈提交失败（携带可直接展示的中文说明）。
class FeedbackException implements Exception {
  FeedbackException(this.message);

  final String message;

  @override
  String toString() => message;
}
