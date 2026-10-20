import 'dart:convert';

import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:flutter_test/flutter_test.dart';

import 'aimi_connection_test.dart' show StubWebSocketChannel;

/// 用一个 stub 通道跑配对握手，返回（已发出的帧订阅、结果 Future）。
({Future<PairingResult> result, List<Map<String, dynamic>> sent}) startPairing(
  StubWebSocketChannel stub, {
  String lanUrl = '192.168.1.10:8787',
  String code = '12345678',
  void Function(Uri uri)? onUri,
}) {
  final sent = <Map<String, dynamic>>[];
  // 消费手机发出的帧（配对握手只发一帧 hello）。
  stub.clientFrames.listen((raw) => sent.add(jsonDecode(raw as String) as Map<String, dynamic>));
  final result = pairWithCode(
    lanUrl: lanUrl,
    pairingCode: code,
    deviceName: 'aimi-android',
    channelFactory: (uri) {
      onUri?.call(uri);
      return stub;
    },
  );
  return (result: result, sent: sent);
}

void main() {
  test('pairWithCode：发 hello{pairingCode,deviceName}，收 paired{token,deviceId}', () async {
    final stub = StubWebSocketChannel();
    Uri? seen;
    final p = startPairing(stub, onUri: (uri) => seen = uri);

    await Future<void>.delayed(Duration.zero);
    // 裸 host:port 默认补 ws:// 与服务端 /ws 端点。
    expect(seen?.scheme, 'ws');
    expect(seen?.host, '192.168.1.10');
    expect(seen?.port, 8787);
    expect(seen?.path, '/ws');
    expect(p.sent, hasLength(1));
    expect(p.sent.single['type'], 'hello');
    expect(p.sent.single['pairingCode'], '12345678');
    expect(p.sent.single['deviceName'], 'aimi-android');
    // 配对变体不得携带 token（令牌由服务端在 paired 里下发一次）。
    expect(p.sent.single.containsKey('token'), isFalse);

    stub.serverSend(
      jsonEncode({'v': 1, 'type': 'paired', 'token': 'tok-abc', 'deviceId': 'dev-1'}),
    );
    final result = await p.result;
    expect(result.token, 'tok-abc');
    expect(result.deviceId, 'dev-1');
  });

  test('pairWithCode：error 帧转为可展示的 PairingException', () async {
    final stub = StubWebSocketChannel();
    final p = startPairing(stub);
    await Future<void>.delayed(Duration.zero);
    stub.serverSend(
      jsonEncode({
        'v': 1,
        'type': 'error',
        'code': 'auth.pairing_expired',
        'message': '配对码已过期',
      }),
    );
    await expectLater(
      p.result,
      throwsA(isA<PairingException>().having((e) => e.message, 'message', '配对码已过期')),
    );
  });

  test('pairWithCode：地址为空或配对码位数不对 → 建链前即拒', () async {
    var factoryCalled = false;

    await expectLater(
      pairWithCode(
        lanUrl: '   ',
        pairingCode: '12345678',
        deviceName: 'd',
        channelFactory: (_) {
          factoryCalled = true;
          return StubWebSocketChannel();
        },
      ),
      throwsA(isA<PairingException>().having((e) => e.code, 'code', 'invalid_address')),
    );
    await expectLater(
      pairWithCode(
        lanUrl: '192.168.1.10:8787',
        pairingCode: '123',
        deviceName: 'd',
        channelFactory: (_) {
          factoryCalled = true;
          return StubWebSocketChannel();
        },
      ),
      throwsA(isA<PairingException>().having((e) => e.message, 'message', '配对码是 8 位数字')),
    );
    expect(factoryCalled, isFalse);
  });

  test('pairWithCode：wss 地址保留 scheme（真机口径走 TLS）', () async {
    final stub = StubWebSocketChannel();
    Uri? seen;
    final p = startPairing(stub, lanUrl: 'wss://192.168.1.10:8787', onUri: (uri) => seen = uri);
    await Future<void>.delayed(Duration.zero);
    expect(seen?.scheme, 'wss');
    stub.serverSend(jsonEncode({'v': 1, 'type': 'paired', 'token': 't', 'deviceId': 'd'}));
    await p.result;
  });

  test('pairWithCode：连接在 paired 前关闭 → 以网络错误收口', () async {
    final stub = StubWebSocketChannel();
    final p = startPairing(stub);
    await Future<void>.delayed(Duration.zero);
    stub.serverClose();
    await expectLater(
      p.result,
      throwsA(isA<PairingException>().having((e) => e.code, 'code', 'network')),
    );
  });
}
