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
  /// 非 null 时 `ready` 挂到该门完成为止（模拟拨号悬死的通道）。
  StubWebSocketChannel({Completer<void>? readyGate}) : _readyGate = readyGate;

  final Completer<void>? _readyGate;

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
  Future<void> get ready =>
      _readyGate != null ? _readyGate.future : Future<void>.value();

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
  StubServer(this.channel, {this.replyPong = false, this.createdSessionId, this.features});

  final StubWebSocketChannel channel;

  /// 是否回 pong；false 表示模拟「两拍未回」
  final bool replyPong;

  /// 非 null 时 `session.create`/`session.fork` 回 ack（带该 id）；null 时回 error 帧
  final String? createdSessionId;

  /// welcome.features 附加声明（能力协商测试用）
  final Map<String, dynamic>? features;

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
              if (features != null) 'features': features,
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
        case 'session.fork':
          final forkId = createdSessionId;
          channel.serverSend(
            jsonEncode(
              forkId == null
                  ? {
                      'v': 1,
                      'type': 'error',
                      'code': 'session.not_found',
                      'message': '源会话不可分叉',
                    }
                  : {'v': 1, 'type': 'ack', 'sessionId': forkId},
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
      'capabilities': {'dynamicPermissions': true},
    });
    expect(connection.state, ConnState.onlineLan);
    expect(cache.session('sess-1')?.agentId, 'claude');
    expect(cache.sessionsSnapshot(), hasLength(1));
  });

  test('connect 单飞：并发两次 connect 只拨一次号、发一次 hello', () async {
    var factoryCalls = 0;
    final stub = StubWebSocketChannel();
    final server = StubServer(stub, createdSessionId: 'sess-new')..start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) {
        factoryCalls++;
        return stub;
      },
      connectTimeout: const Duration(seconds: 2),
    );
    addTearDown(connection.dispose);

    // 冷启动时序竞态的复现入口：两个 connect() 几乎同时发起。
    final first = connection.connect();
    final second = connection.connect();
    await Future.wait([first, second]);

    expect(factoryCalls, 1, reason: '并发 connect 共享同一次拨号，不开第二条链');
    expect(server.received.where((f) => f['type'] == 'hello'), hasLength(1));
    expect(connection.state, ConnState.onlineLan);
  });

  test('过时拨号的超时不得拆掉后继健康通道（僵尸在线回归）', () async {
    // 通道 1 拨号悬死（ready 永不完成）；链路中断后重连链用通道 2（健康）。
    final hanging = StubWebSocketChannel(readyGate: Completer<void>());
    final healthy = StubWebSocketChannel();
    final healthyServer = StubServer(healthy, createdSessionId: 'sess-new')
      ..start();
    final channels = <StubWebSocketChannel>[hanging, healthy];
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      // 清单耗尽后改发悬死通道：每次尝试吃满 connectTimeout，重连链速率有界，
      // 避免零延迟+同步抛错的无限风暴把测试进程打进 OOM。
      channelFactory: (_) =>
          channels.isEmpty ? StubWebSocketChannel(readyGate: Completer<void>()) : channels.removeAt(0),
      connectTimeout: const Duration(milliseconds: 100),
      delay: (_) => Future<void>.value(),
    );
    addTearDown(connection.dispose);

    unawaited(connection.connect());
    await Future<void>.delayed(const Duration(milliseconds: 10));
    // 触发链路中断 → 重连链接管 → 健康通道接管进入 onlineLan。
    hanging.serverClose();
    final deadline = DateTime.now().add(const Duration(seconds: 2));
    while (connection.state != ConnState.onlineLan) {
      if (DateTime.now().isAfter(deadline)) fail('健康通道未在期限内接管');
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    // 悬死拨号的 100ms 超时此刻到期：代次守卫生效则健康通道不被拆——
    // 僵尸在线的判据是「表面 online 但通道已死」，能拿到 ack 即通道存活。
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(connection.state, ConnState.onlineLan);
    const spec = SessionSpecDto(
      agentId: 'claude',
      cwd: r'D:\proj',
      permissionMode: 'plan',
    );
    expect(
      await connection.createSession(spec),
      'sess-new',
      reason: '健康通道仍可用（未被过时 attempt 的超时拆掉）',
      // 健康桩只被拨过一次：守卫失效时重连链还会再拨一次，一并暴露。
    );
    expect(channels, isEmpty);
    expect(
      healthyServer.received.where((f) => f['type'] == 'hello'),
      hasLength(1),
    );
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
      'capabilities': {'dynamicPermissions': true},
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

  test('update：update.info 帧进入 updates 流（latest null 与带清单两形态）', () async {
    final stub = StubWebSocketChannel();
    StubServer(stub, replyPong: true).start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (uri) => stub,
    );
    addTearDown(connection.dispose);
    final received = <UpdateInfoFrameDto>[];
    final sub = connection.updates.listen(received.add);
    addTearDown(sub.cancel);

    await connection.connect();
    stub.serverSend(
      jsonEncode({'v': 1, 'type': 'update.info', 'latest': null}),
    );
    stub.serverSend(
      jsonEncode({
        'v': 1,
        'type': 'update.info',
        'latest': {
          'versionName': '1.0.1',
          'versionCode': 2,
          'size': 1024,
          'sha256': 'a' * 64,
          'downloadPath': '/updates/app-2.apk',
        },
      }),
    );
    await waitFor(() => received.length == 2);
    expect(received[0].latest, isNull);
    expect(received[1].latest?.versionCode, 2);
  });

  test('update：checkForUpdate 发出 update.check 帧；未连接时返回 false', () async {
    final stub = StubWebSocketChannel();
    final server = StubServer(stub, replyPong: true)..start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (uri) => stub,
    );
    addTearDown(connection.dispose);

    // 未连接：发送被丢弃，返回 false。
    expect(connection.checkForUpdate(), isFalse);

    await connection.connect();
    expect(connection.checkForUpdate(), isTrue);
    await waitFor(
      () => server.received.any((f) => f['type'] == 'update.check'),
    );
    final frame = server.received.firstWhere(
      (f) => f['type'] == 'update.check',
    );
    expect(frame, {'v': 1, 'type': 'update.check'});
  });
  test('目录能力缺失时本地拒绝，不向旧服务端发送未知帧', () async {
    final stub = StubWebSocketChannel();
    final server = StubServer(stub)..start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => stub,
    );
    addTearDown(connection.dispose);
    expect((await connection.listDirectory(''))?.error, 'offline');
    await connection.connect();
    expect(connection.supportsDirectoryBrowsing, isFalse);
    expect((await connection.listDirectory(''))?.error, 'unsupported');
    expect(
      server.received.where((frame) => frame['type'] == 'directory.list'),
      isEmpty,
    );
  });

  test('目录结果按请求关联，超时有独立错误，权限快照不进入事件流', () async {
    final stub = StubWebSocketChannel();
    final directories = <Map<String, dynamic>>[];
    final hello = <Map<String, dynamic>>[];
    stub.clientFrames.listen((raw) {
      final frame = jsonDecode(raw as String) as Map<String, dynamic>;
      if (frame['type'] == 'hello') {
        hello.add(frame);
        stub.serverSend(
          jsonEncode({
            'v': 1,
            'type': 'welcome',
            'serverVersion': 'new',
            'sessions': [metaJson()],
            'features': {'directoryBrowsing': true, 'dynamicPermissions': true},
          }),
        );
      } else if (frame['type'] == 'directory.list') {
        directories.add(frame);
      }
    });
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => stub,
      createTimeout: const Duration(milliseconds: 150),
    );
    addTearDown(connection.dispose);
    await connection.connect();
    expect(hello.single['capabilities']['dynamicPermissions'], isTrue);
    expect(connection.supportsDirectoryBrowsing, isTrue);
    expect(connection.supportsDynamicPermissions, isTrue);
    final first = connection.listDirectory('first');
    final second = connection.listDirectory('second');
    await waitFor(() => directories.length == 2);
    stub.serverSend(
      jsonEncode({
        'v': 1,
        'type': 'directory.result',
        'requestId': directories[1]['requestId'],
        'path': 'second',
        'entries': [],
      }),
    );
    stub.serverSend(
      jsonEncode({
        'v': 1,
        'type': 'directory.result',
        'requestId': directories[0]['requestId'],
        'path': 'first',
        'entries': [],
      }),
    );
    expect((await first)?.path, 'first');
    expect((await second)?.path, 'second');
    expect((await connection.listDirectory('timeout'))?.error, 'timeout');
    stub.serverSend(
      jsonEncode({
        'v': 1,
        'type': 'session.permissions',
        'sessionId': 'sess-1',
        'currentMode': 'workspaceOnly',
        'modes': [
          {
            'id': 'workspaceOnly',
            'name': '工作区',
            'description': '仅工作区',
            'availability': 'available',
          },
        ],
      }),
    );
    await waitFor(
      () => cache.session('sess-1')?.permissionMode == 'workspaceOnly',
    );
    expect(cache.eventsFor('sess-1'), isEmpty);
    connection.disconnect();
    expect(connection.supportsDirectoryBrowsing, isFalse);
    expect(connection.supportsDynamicPermissions, isFalse);
  });

  test('forkSession：服务端声明能力且 ack 回新会话 id，帧形状与源 id 正确', () async {
    final stub = StubWebSocketChannel();
    final server = StubServer(
      stub,
      createdSessionId: 'sess-forked',
      features: {'sessionFork': true},
    )..start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => stub,
    );
    addTearDown(connection.dispose);
    await connection.connect();
    expect(connection.supportsSessionFork, isTrue);

    final forked = await connection.forkSession('sess-1');
    expect(forked, 'sess-forked');
    final forkFrame = server.received
        .where((f) => f['type'] == 'session.fork')
        .toList(growable: false);
    expect(forkFrame, hasLength(1));
    expect(forkFrame.single['sourceId'], 'sess-1');
  });

  test('服务端未声明分叉能力：supportsSessionFork 为 false（旧端兼容）', () async {
    final stub = StubWebSocketChannel();
    StubServer(stub).start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => stub,
    );
    addTearDown(connection.dispose);
    await connection.connect();
    expect(connection.supportsSessionFork, isFalse);
  });

  test('离线时 forkSession 直接返回 null，不发帧', () async {
    final stub = StubWebSocketChannel();
    // 桩仅兜底不应答；断言点是「未 connect 即调用不产生任何出站帧」。
    final server = StubServer(stub, createdSessionId: 'x')..start();
    final connection = AimiConnection(
      endpoints: endpoints,
      cache: cache,
      channelFactory: (_) => stub,
    );
    addTearDown(connection.dispose);
    expect(await connection.forkSession('sess-1'), isNull);
    expect(server.received, isEmpty);
  });
}
