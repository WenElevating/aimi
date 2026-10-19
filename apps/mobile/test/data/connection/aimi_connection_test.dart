import 'dart:async';
import 'dart:convert';

import 'package:aimi/data/cache/session_cache.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// `WebSocketChannel` 的手写流对桩：双向通道由 [StreamChannelController] 承载，
/// 帧以 JSON 字符串走真实编解码，测试内**不触及任何真实 socket**。
///
/// 约定：`clientFrames`（local 方向）是手机发出的帧，[serverSend]（local→foreign）
/// 是 server 下发的帧——与 [AdapterWebSocketChannel] 的 local/foreign 语义一致。
class StubWebSocketChannel extends StreamChannelMixin
    implements WebSocketChannel {
  final StreamChannelController<Object?> _controller =
      StreamChannelController<Object?>(sync: true, allowForeignErrors: false);

  /// 手机→server 的原始帧（连接层序列化后的 JSON 文本）
  Stream<Object?> get clientFrames => _controller.local.stream;

  /// 模拟 server 下发一条帧。
  void serverSend(String json) => _controller.local.sink.add(json);

  /// 模拟服务端关闭连接，触发客户端的统一断线处理。
  void serverClose() => _controller.local.sink.close();

  @override
  Stream get stream => _controller.foreign.stream;

  @override
  late final WebSocketSink sink = _StubSink(_controller.foreign.sink);

  @override
  Future<void> get ready => Future<void>.value();

  @override
  String? get protocol => null;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;
}

/// 只实现连接层实际用到的 5 个成员；`close([code, reason])` 的 code/reason 被忽略。
class _StubSink implements WebSocketSink {
  _StubSink(this._inner);

  final StreamSink<Object?> _inner;

  @override
  void add(dynamic event) => _inner.add(event);

  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      _inner.addError(error, stackTrace);

  @override
  Future<void> addStream(Stream<dynamic> stream) => _inner.addStream(stream);

  @override
  Future<void> close([int? closeCode, String? closeReason]) => _inner.close();

  @override
  Future<dynamic> get done => _inner.done;
}

/// 服务端 welcome 帧携带的会话元数据（字段名与电脑端协议逐字一致）。
Map<String, dynamic> metaJson({
  String id = 'sess-1',
  String agentId = 'claude',
  String cwd = r'D:\proj',
  String permissionMode = 'default',
  String state = 'running',
  int lastSeq = 0,
  int createdAt = 1700000000000,
  int updatedAt = 1700000000000,
}) => {
  'id': id,
  'agentId': agentId,
  'cwd': cwd,
  'permissionMode': permissionMode,
  'state': state,
  'lastSeq': lastSeq,
  'createdAt': createdAt,
  'updatedAt': updatedAt,
};

/// server 侧 session.event 帧（`agentEvent` 由调用方给出归一化事件 JSON）。
Map<String, dynamic> eventJson({
  required int seq,
  Map<String, dynamic> agentEvent = const {'type': 'text_delta', 'text': 'hi'},
  String sessionId = 'sess-1',
  int ts = 1700000000000,
}) => {
  'v': 1,
  'type': 'session.event',
  'sessionId': sessionId,
  'seq': seq,
  'ts': ts,
  'agentEvent': agentEvent,
};

/// 走真实 JSON 编解码 + 契约解析构造领域帧（不使用 DTO 的 toJson 构造，避免自证）。
SessionEventFrameDto eventFrame({
  required int seq,
  Map<String, dynamic> agentEvent = const {'type': 'text_delta', 'text': 'hi'},
}) {
  final parsed = ServerFrameParser.parse(
    jsonDecode(jsonEncode(eventJson(seq: seq, agentEvent: agentEvent)))
        as Map<String, dynamic>,
  );
  return parsed! as SessionEventFrameDto;
}

/// 极简 server 桩：收到 hello 回 welcome，收到 ping 按开关回 pong，收到 session.create 回 ack 或 error。
class StubServer {
  StubServer(this.channel, {this.replyPong = false, this.createdSessionId});

  final StubWebSocketChannel channel;

  /// 是否回 pong；false 表示模拟「两拍未回」
  final bool replyPong;

  /// 非 null 时 `session.create` 回 ack（带该 id）；null 时回 error 帧
  final String? createdSessionId;

  /// 手机→server 的全部帧，已解码
  final List<Map<String, dynamic>> received = [];

  void start() {
    channel.clientFrames.listen((raw) {
      final frame = jsonDecode(raw as String) as Map<String, dynamic>;
      received.add(frame);
      switch (frame['type']) {
        case 'hello':
          channel.serverSend(
            jsonEncode({
              'v': 1,
              'type': 'welcome',
              'serverVersion': '0.1.0',
              'sessions': [metaJson()],
            }),
          );
        case 'ping':
          if (replyPong) {
            channel.serverSend(
              jsonEncode({'v': 1, 'type': 'pong', 'nonce': frame['nonce']}),
            );
          }
        case 'session.create':
          final sessionId = createdSessionId;
          channel.serverSend(
            jsonEncode(
              sessionId == null
                  ? {
                      'v': 1,
                      'type': 'error',
                      'code': 'server.busy',
                      'message': '会话创建失败',
                    }
                  : {'v': 1, 'type': 'ack', 'sessionId': sessionId},
            ),
          );
        case 'session.command':
          channel.serverSend(
            jsonEncode({
              'v': 1,
              'type': 'command.ack',
              'sessionId': frame['sessionId'],
              'clientId': frame['clientId'],
              'status': 'delivered',
            }),
          );
      }
    });
  }
}

/// 让出事件循环若干拍，用于观察异步投递（无需 fakeAsync）。
Future<void> settle() => Future<void>.delayed(Duration.zero);

/// 轮询等待 [condition] 成立（真实时钟推进，供真实 Timer 场景使用）；
/// 最多等 [tries] × [step]，仍未成立即断言失败。
Future<void> waitFor(
  bool Function() condition, {
  Duration step = const Duration(milliseconds: 10),
  int tries = 100,
}) async {
  for (var i = 0; i < tries && !condition(); i++) {
    await Future<void>.delayed(step);
  }
  expect(condition(), isTrue, reason: '等待条件在 ${step * tries} 内未成立');
}

/// 连接测试统一使用的三要素。
const AimiEndpoints endpoints = AimiEndpoints(
  host: '192.168.1.10',
  port: 7777,
  token: 'token-12345678',
);

void main() {
  late SessionCache cache;

  setUp(() => cache = SessionCache());

  test('connect：hello 帧字段齐，welcome 后进入 onlineLan 且元数据入 cache', () async {
    final stub = StubWebSocketChannel();
    final server = StubServer(stub, createdSessionId: 'sess-new')..start();
    Uri? opened;
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (uri) {
        opened = uri;
        return stub;
      },
    );
    addTearDown(connection.dispose);

    await connection.connect();

    expect(opened, Uri.parse('ws://192.168.1.10:7777/ws'));
    expect(server.received.first, {
      'v': 1,
      'type': 'hello',
      'token': 'token-12345678',
      'resume': null,
      'commandAck': true,
    });
    expect(connection.state, ConnState.onlineLan);
    expect(cache.session('sess-1')?.agentId, 'claude');
    expect(cache.sessionsSnapshot(), hasLength(1));
  });

  test('cache：未知会话 seq 单调检查——越序丢弃、续接写入、重复丢弃', () {
    // 无 welcome：未知会话水位 = -1，首帧必须 seq 0。
    expect(cache.applyEvent(eventFrame(seq: 3)), isFalse);
    expect(cache.lastSeq('sess-1'), -1);

    expect(cache.applyEvent(eventFrame(seq: 0)), isTrue);
    expect(cache.applyEvent(eventFrame(seq: 1)), isTrue);
    expect(cache.applyEvent(eventFrame(seq: 1)), isFalse);

    expect(cache.lastSeq('sess-1'), 1);
    expect(cache.eventsFor('sess-1').map((f) => f.seq), [0, 1]);
  });

  test('cache：welcome 水位对齐后 seq 续接（lastSeq=5 → 6,7 写入）', () {
    cache.applyWelcome([SessionMetaDto.fromJson(metaJson(lastSeq: 5))]);

    expect(
      cache.applyEvent(eventFrame(seq: 5)),
      isFalse,
    ); // 已见水位，非 lastSeq+1 不可入
    expect(cache.applyEvent(eventFrame(seq: 6)), isTrue);
    expect(cache.applyEvent(eventFrame(seq: 7)), isTrue);

    expect(cache.lastSeq('sess-1'), 7);
    expect(cache.eventsFor('sess-1').map((f) => f.seq), [6, 7]);
    expect(cache.session('sess-1')?.lastSeq, 7);
  });

  test('cache：断线缺口对齐——本地 0 → welcome lastSeq=5 → seq 6 直接可流', () {
    // 本地已写入 seq 0（此前连接的镜像，水位 = 0）。
    expect(cache.applyEvent(eventFrame(seq: 0)), isTrue);
    expect(cache.lastSeq('sess-1'), 0);

    // 重连：服务端已推进到 lastSeq=5（本地缺 1..5）。
    cache.applyWelcome([SessionMetaDto.fromJson(metaJson(lastSeq: 5))]);
    expect(cache.applyEvent(eventFrame(seq: 6)), isTrue); // 缺口按「允许缺口」跳过
    expect(cache.lastSeq('sess-1'), 6);
    expect(cache.eventsFor('sess-1').map((f) => f.seq), [0, 6]);
  });

  test('cache：sessionsSnapshot 按 updatedAt 降序（同刻按 id 稳定）', () {
    cache.applyWelcome([
      SessionMetaDto.fromJson(metaJson(id: 'old', updatedAt: 100)),
      SessionMetaDto.fromJson(metaJson(id: 'new', updatedAt: 300)),
    ]);

    expect(cache.sessionsSnapshot().map((s) => s.id), ['new', 'old']);
  });

  test('connection：session.event 透传 events 流并写入 cache，越序帧不发出', () async {
    final stub = StubWebSocketChannel();
    StubServer(stub).start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => stub,
    );
    addTearDown(connection.dispose);
    final received = <SessionEventFrameDto>[];
    final subscription = connection.events.listen(received.add);
    addTearDown(subscription.cancel);

    await connection.connect();
    stub.serverSend(
      jsonEncode(eventJson(seq: 1)),
    ); // welcome lastSeq=0 → 下一条 = 1
    await settle();
    expect(received.map((f) => f.seq), [1]);

    stub.serverSend(jsonEncode(eventJson(seq: 3)));
    await settle();
    expect(received.map((f) => f.seq), [1], reason: '越序帧必须丢弃且不转发');
    expect(cache.lastSeq('sess-1'), 1);
  });

  test('createSession：ack 返回 sessionId，spec 字段与 TS 逐字一致', () async {
    final stub = StubWebSocketChannel();
    final server = StubServer(stub, createdSessionId: 'sess-new')..start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => stub,
    );
    addTearDown(connection.dispose);
    await connection.connect();

    const spec = SessionSpecDto(
      agentId: 'claude',
      cwd: r'D:\proj',
      permissionMode: 'plan',
      initialPrompt: '写一个 hello world',
    );
    expect(await connection.createSession(spec), 'sess-new');
    expect(server.received.last, {
      'v': 1,
      'type': 'session.create',
      'spec': {
        'agentId': 'claude',
        'cwd': r'D:\proj',
        'permissionMode': 'plan',
        'initialPrompt': '写一个 hello world',
      },
    });
  });

  test('createSession：server 回 error 帧时返回 null', () async {
    final stub = StubWebSocketChannel();
    final server = StubServer(stub, createdSessionId: null)..start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => stub,
    );
    addTearDown(connection.dispose);

    await connection.connect();
    final sessionId = await connection.createSession(
      const SessionSpecDto(
        agentId: 'claude',
        cwd: r'D:\proj',
        permissionMode: 'default',
      ),
    );

    expect(sessionId, isNull);
    expect(server.received.first, {
      'v': 1,
      'type': 'hello',
      'token': 'token-12345678',
      'resume': null,
      'commandAck': true,
    });
    expect(server.received.last, {
      'v': 1,
      'type': 'session.create',
      'spec': {
        'agentId': 'claude',
        'cwd': r'D:\proj',
        'permissionMode': 'default',
      },
    });
  });

  test('sendCommand：session.command 帧字段与 TS 逐字一致', () async {
    final stub = StubWebSocketChannel();
    final server = StubServer(stub, createdSessionId: 'sess-new')..start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => stub,
    );
    addTearDown(connection.dispose);
    await connection.connect();

    final firstResult = await connection.sendCommand(
      'sess-1',
      'client-abcdefgh',
      AgentCommandDto.interrupt(),
    );
    expect(firstResult?.status, 'delivered');
    expect(server.received.last, {
      'v': 1,
      'type': 'session.command',
      'sessionId': 'sess-1',
      'clientId': 'client-abcdefgh',
      'cmd': {'cmd': 'interrupt'},
    });

    await connection.sendCommand(
      'sess-1',
      'client-abcdefgh',
      AgentCommandDto.send('你好'),
    );
    expect(server.received.last['cmd'], {'cmd': 'send', 'text': '你好'});
  });

  test('重连退避：首次失败进 reconnecting，退避放行后第二次成功', () async {
    final stub = StubWebSocketChannel();
    StubServer(stub).start();
    final gate = Completer<void>();
    final waits = <Duration>[];
    var attempts = 0;
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) {
        attempts++;
        if (attempts == 1) throw StateError('连接被拒');
        return stub;
      },
      delay: (wait) {
        waits.add(wait);
        return gate.future;
      },
    );
    addTearDown(connection.dispose);

    await connection.connect();

    expect(connection.state, ConnState.reconnecting);
    expect(waits, hasLength(1));
    expect(
      waits.first.inMilliseconds,
      greaterThanOrEqualTo(AimiConnection.baseBackoff.inMilliseconds),
    );
    expect(
      waits.first.inMilliseconds,
      lessThanOrEqualTo(
        AimiConnection.baseBackoff.inMilliseconds +
            AimiConnection.backoffJitterMillis,
      ),
      reason: '抖动必须封顶',
    );

    gate.complete();
    await waitFor(() => connection.state == ConnState.onlineLan);
    expect(attempts, 2);
    expect(cache.session('sess-1'), isNotNull);
  });

  test('重连退避：序列 1s→2s→…→30s 封顶 + 抖动，且抖动有界', () async {
    final waits = <Duration>[];
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => throw StateError('始终连不上'),
      delay: (wait) {
        waits.add(wait);
        // 前 7 次用极短真实等待推进循环，之后停住（避免测试结束仍有长定时器）。
        return waits.length <= 7
            ? Future<void>.delayed(const Duration(milliseconds: 1))
            : Completer<void>().future;
      },
      pingPeriod: const Duration(seconds: 15),
    );
    addTearDown(connection.dispose);

    await connection.connect();
    await waitFor(
      () => waits.length >= 7,
      step: const Duration(milliseconds: 5),
    );

    expect(connection.state, ConnState.reconnecting);
    expect(
      waits.take(7).map((w) => w.inMilliseconds ~/ 1000),
      [1, 2, 4, 8, 16, 30, 30],
      reason: '退避基数按 2 的幂增长并在 30s 封顶',
    );
    final upperBound =
        AimiConnection.maxBackoff.inMilliseconds +
        AimiConnection.backoffJitterMillis;
    for (final wait in waits) {
      expect(wait.inMilliseconds, lessThanOrEqualTo(upperBound));
    }
  });

  test('心跳：两拍未回判死并转入重连', () async {
    final stub = StubWebSocketChannel();
    StubServer(stub, replyPong: false).start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => stub,
      pingPeriod: const Duration(milliseconds: 5),
      delay: (_) => Completer<void>().future,
    );
    addTearDown(connection.dispose);

    await connection.connect();
    expect(connection.state, ConnState.onlineLan);

    await waitFor(() => connection.state == ConnState.reconnecting);
  });

  test('心跳：pong 按时到达则保持在线', () async {
    final stub = StubWebSocketChannel();
    StubServer(stub, replyPong: true).start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => stub,
      pingPeriod: const Duration(milliseconds: 5),
      delay: (_) => Completer<void>().future,
    );
    addTearDown(connection.dispose);

    await connection.connect();
    await Future<void>.delayed(const Duration(milliseconds: 60));

    expect(connection.state, ConnState.onlineLan);
  });

  test('disconnect：主动断开后停止重连并落 offline', () async {
    final stub = StubWebSocketChannel();
    StubServer(stub).start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => stub,
      delay: (_) => Completer<void>().future,
    );
    addTearDown(connection.dispose);
    await connection.connect();

    await connection.disconnect();

    expect(connection.state, ConnState.offline);
    expect(
      await connection.createSession(
        const SessionSpecDto(
          agentId: 'claude',
          cwd: r'D:\proj',
          permissionMode: 'default',
        ),
      ),
      isNull,
    );
    await settle();
    expect(connection.state, ConnState.offline, reason: '主动断开后不得自行重连');
  });

  test('双链路：LAN 失败三秒后切 relay，relay 断开后重新优先探测 LAN', () async {
    final relayEndpoints = const AimiEndpoints(
      host: '192.168.1.10',
      port: 7777,
      token: 'token-12345678',
      relayUrl: 'wss://relay.example/serve',
      serverId: 'srv-1',
    );
    final relay = StubWebSocketChannel();
    StubServer(relay).start();
    final lanRecovered = StubWebSocketChannel();
    StubServer(lanRecovered).start();
    var clock = DateTime(2026, 1, 1);
    final opened = <Uri>[];
    var attempts = 0;
    final connection = AimiConnection(
      endpoints: relayEndpoints,
      cache: cache,
      channelFactory: (uri) {
        opened.add(uri);
        attempts++;
        if (attempts == 1 || attempts == 2) {
          throw StateError('LAN unavailable');
        }
        if (attempts == 3) return relay;
        return lanRecovered;
      },
      now: () => clock,
      delay: (wait) {
        clock = clock.add(wait);
        return Future<void>.value();
      },
    );
    addTearDown(connection.dispose);

    await connection.connect();
    await waitFor(() => connection.state == ConnState.onlineRelay);
    expect(opened, [
      Uri.parse('ws://192.168.1.10:7777/ws'),
      Uri.parse('ws://192.168.1.10:7777/ws'),
      Uri.parse('wss://relay.example/device?serverId=srv-1'),
    ]);

    relay.serverClose();
    await waitFor(() => opened.length >= 4);
    expect(opened[3], Uri.parse('ws://192.168.1.10:7777/ws'));
    await waitFor(() => connection.state == ConnState.onlineLan);
  });
}
