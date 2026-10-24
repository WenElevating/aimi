import 'dart:convert';
import 'dart:io';

import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/logging/log_export.dart';
import 'package:aimi/data/feedback/feedback_uploader.dart';
import 'package:aimi/data/logging/aimi_logger.dart';
import 'package:http/http.dart' as http;
import 'package:flutter_test/flutter_test.dart';

/// 记录请求并按脚本应答的 client 假体。
class FakeClient extends http.BaseClient {
  FakeClient(this.handler);

  final Future<http.Response> Function(http.Request request) handler;
  final List<http.Request> requests = <http.Request>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final typed = request as http.Request;
    requests.add(typed);
    return handler(typed).then(
      (response) => http.StreamedResponse(
        Stream.value(response.bodyBytes),
        response.statusCode,
        headers: response.headers,
      ),
    );
  }
}

const endpoints = AimiEndpoints(host: '192.168.1.10', port: 8787, token: 'token-12345678', scheme: 'wss');
const appInfo = FeedbackAppInfo(version: '1.0.8', build: '9', platform: 'Android 16');

void main() {
  test('提交：URL 按 wss→https 拼、token 在 header、body 含 desc/app/日志 zip/图片', () async {
    final requests = <http.Request>[];
    final client = FakeClient((request) async {
      requests.add(request);
      return http.Response('{"id":"20261024-120000-abc123"}', 201);
    });
    final logger = AimiLogger();
    final uploader = FeedbackUploader(
      endpoints: endpoints,
      appInfo: appInfo,
      client: client,
      exporter: LogExporter(logger),
    );

    final result = await uploader.submit(desc: '卡住了', images: const []);

    expect(result.id, '20261024-120000-abc123');
    expect(requests.single.method, 'POST');
    expect(requests.single.url.toString(), 'https://192.168.1.10:8787/feedback');
    expect(requests.single.headers['x-aimi-token'], 'token-12345678');
    final body = jsonDecode(requests.single.body) as Map<String, dynamic>;
    expect(body['desc'], '卡住了');
    expect((body['app'] as Map)['version'], '1.0.8');
    expect((body['app'] as Map)['build'], '9');
    expect(body.containsKey('logZipB64'), isTrue, reason: '日志 zip 自动附带');
    expect(body.containsKey('images'), isFalse, reason: '无图时不带 images 键');
  });

  test('带图提交：图片 base64 内嵌', () async {
    final tmp = File('${Directory.systemTemp.path}/aimi-fb-${DateTime.now().millisecondsSinceEpoch}.jpg');
    tmp.writeAsBytesSync(List<int>.generate(16, (i) => i));
    addTearDown(() => tmp.deleteSync());
    var bodySeen = <String, dynamic>{};
    final client = FakeClient((request) async {
      bodySeen = jsonDecode(request.body) as Map<String, dynamic>;
      return http.Response('{"id":"fb-1"}', 201);
    });
    final uploader = FeedbackUploader(
      endpoints: endpoints,
      appInfo: appInfo,
      client: client,
      exporter: LogExporter(AimiLogger()),
    );

    await uploader.submit(
      desc: '带截图',
      images: [FeedbackImage(path: tmp.path, name: 'screenshot.jpg')],
    );

    final images = bodySeen['images'] as List;
    expect(images.single['name'], 'screenshot.jpg');
    expect(
      base64Decode(images.single['b64'] as String),
      tmp.readAsBytesSync(),
      reason: '图片按字节原样 base64',
    );
  });

  test('失败路径：401/429/网络错误转可读 FeedbackException', () async {
    Future<FeedbackSubmitResult> submitWith(int status) async {
      final uploader = FeedbackUploader(
        endpoints: endpoints,
        appInfo: appInfo,
        client: FakeClient((_) async => http.Response('denied', status)),
        exporter: LogExporter(AimiLogger()),
      );
      return uploader.submit(desc: 'x', images: const []);
    }

    expect(() => submitWith(401), throwsA(isA<FeedbackException>().having((e) => e.message, 'msg', contains('配对'))));
    expect(() => submitWith(429), throwsA(isA<FeedbackException>().having((e) => e.message, 'msg', contains('频繁'))));
    expect(() => submitWith(500), throwsA(isA<FeedbackException>().having((e) => e.message, 'msg', contains('500'))));
  });

  test('未配对场景由 UI 判定（endpoints 为 null 时不构造 uploader）——此处验证 URL 的 http 回退', () async {
    final requests = <http.Request>[];
    final client = FakeClient((request) async {
      requests.add(request);
      return http.Response('{"id":"fb-2"}', 201);
    });
    final uploader = FeedbackUploader(
      endpoints: const AimiEndpoints(host: '127.0.0.1', port: 8787, token: 't-abcdefgh'),
      appInfo: appInfo,
      client: client,
      exporter: LogExporter(AimiLogger()),
    );
    await uploader.submit(desc: 'x', images: const []);
    expect(requests.single.url.scheme, 'http', reason: 'ws 端点走明文 HTTP');
  });
}
