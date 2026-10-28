import 'dart:convert';

import 'package:aimi/data/cache/session_cache.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/connection/outbox_flusher.dart';
import 'package:flutter_test/flutter_test.dart';

import 'aimi_connection_test.dart' as harness;

/// 补发测试桩：welcome 按 [sessionState] 下发；`session.command` 的回执
/// 由 [silent]（不回，模拟回执丢失）、[rejectClientIds]（对该 clientId 回
/// rejected）控制，其余一律回 delivered。
class OutboxStubServer {
  OutboxStubServer(
    this.channel, {
    this.sessionState = 'finished',
    this.silent = false,
    this.rejectClientIds = const <String>{},
  });

  final harness.StubWebSocketChannel channel;

  /// welcome 携带的会话状态（决定补发是否暂缓）。
  final String sessionState;

  /// true = 收到命令不回执（触发补发侧超时重试）。
  final bool silent;

  /// 回 rejected 的 clientId 集合。
  final Set<String> rejectClientIds;

  /// 手机→server 的全部帧（已解码）。
  final List<Map<String, dynamic>> received = <Map<String, dynamic>>[];

  /// 启动帧回环。
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
              'sessions': [harness.metaJson(state: sessionState)],
            }),
          );
        case 'ping':
          channel.serverSend(
            jsonEncode({'v': 1, 'type': 'pong', 'nonce': frame['nonce']}),
          );
        case 'session.command':
          if (silent) return;
          final rejected = rejectClientIds.contains(frame['clientId']);
          channel.serverSend(
            jsonEncode({
              'v': 1,
              'type': 'command.ack',
              'sessionId': frame['sessionId'],
              'clientId': frame['clientId'],
              'status': rejected ? 'rejected' : 'delivered',
            }),
          );
      }
    });
  }

  /// 收到的 session.command 帧。
  List<Map<String, dynamic>> get commands =>
      received.where((frame) => frame['type'] == 'session.command').toList();
}

/// 一次测试装配：内存队列 + 真实连接（stub 通道）+ 补发服务。
class OutboxRig {
  OutboxRig({
    String sessionState = 'finished',
    bool silent = false,
    Set<String> rejectClientIds = const <String>{},
    Duration createTimeout = const Duration(seconds: 5),
    Duration retryDelay = const Duration(milliseconds: 20),
  }) {
    final channel = harness.StubWebSocketChannel();
    server = OutboxStubServer(
      channel,
      sessionState: sessionState,
      silent: silent,
      rejectClientIds: rejectClientIds,
    )..start();
    cache = SessionCache();
    store = OutgoingMessageStore();
    connection = AimiConnection(
      endpoints: harness.endpoints,
      cache: cache,
      channelFactory: (_) => channel,
      createTimeout: createTimeout,
    );
    flusher = OutboxFlusher(
      connection: connection,
      store: store,
      cache: cache,
      retryDelay: retryDelay,
    );
  }

  /// 帧回环桩。
  late final OutboxStubServer server;

  /// 连接层使用的镜像。
  late final SessionCache cache;

  /// 内存离线队列。
  late final OutgoingMessageStore store;

  /// 被测连接。
  late final AimiConnection connection;

  /// 被测补发服务。
  late final OutboxFlusher flusher;

  /// 释放连接与补发服务（镜像随连接生命周期，无独立资源）。
  void dispose() {
    flusher.dispose();
    connection.dispose();
    cache.dispose();
  }
}

/// 离线发送队列的补发服务（OutboxFlusher）行为契约。
void main() {
  test('上线后自动排空：多条 queued 按 ts 顺序补发并标记 sent', () async {
    final rig = OutboxRig();
    addTearDown(rig.dispose);
    rig.store.enqueue(
      clientId: 'c1',
      sessionId: 'sess-1',
      text: '第一条',
      ts: 100,
    );
    rig.store.enqueue(
      clientId: 'c2',
      sessionId: 'sess-1',
      text: '第二条',
      ts: 200,
    );

    rig.flusher.start();
    await rig.connection.connect();

    await harness.waitFor(
      () => rig.store.get('c2')?.status == OutgoingMessageStatus.sent,
    );
    expect(rig.store.get('c1')?.status, OutgoingMessageStatus.sent);
    expect(rig.server.commands, hasLength(2));
    expect(rig.server.commands[0]['clientId'], 'c1');
    expect(rig.server.commands[1]['clientId'], 'c2');
    expect(rig.server.commands[0]['cmd']['cmd'], 'send');
    expect(rig.server.commands[0]['cmd']['text'], '第一条');
  });

  test('服务端拒绝：该条标记 failed，后续消息继续补发', () async {
    final rig = OutboxRig(rejectClientIds: const {'c1'});
    addTearDown(rig.dispose);
    rig.store.enqueue(clientId: 'c1', sessionId: 'sess-1', text: '被拒', ts: 100);
    rig.store.enqueue(clientId: 'c2', sessionId: 'sess-1', text: '通过', ts: 200);

    rig.flusher.start();
    await rig.connection.connect();

    await harness.waitFor(
      () => rig.store.get('c2')?.status == OutgoingMessageStatus.sent,
    );
    expect(rig.store.get('c1')?.status, OutgoingMessageStatus.failed);
    expect(rig.server.commands, hasLength(2));
  });

  test('回执持续超时：retryable 重试三次后标记 failed，服务端收到 3 次', () async {
    final rig = OutboxRig(
      silent: true,
      createTimeout: const Duration(milliseconds: 30),
    );
    addTearDown(rig.dispose);
    rig.store.enqueue(clientId: 'c1', sessionId: 'sess-1', text: '超时', ts: 100);

    rig.flusher.start();
    await rig.connection.connect();

    await harness.waitFor(
      () => rig.store.get('c1')?.status == OutgoingMessageStatus.failed,
      tries: 200,
    );
    expect(rig.store.get('c1')?.attempts, 3);
    expect(rig.server.commands, hasLength(3));
  });

  test('目标会话运行中：暂缓补发，state 事件回 finished 后自动恢复', () async {
    final rig = OutboxRig(sessionState: 'running');
    addTearDown(rig.dispose);
    rig.store.enqueue(
      clientId: 'c1',
      sessionId: 'sess-1',
      text: '等等再发',
      ts: 100,
    );

    rig.flusher.start();
    await rig.connection.connect();
    await harness.settle();
    await harness.settle();

    expect(rig.server.commands, isEmpty);
    expect(rig.store.get('c1')?.status, OutgoingMessageStatus.queued);

    // 服务端回合结束：state 事件（welcome lastSeq=0 → 事件 seq=1 可入）。
    rig.server.channel.serverSend(
      jsonEncode(
        harness.eventJson(
          seq: 1,
          agentEvent: const {'type': 'state', 'state': 'finished'},
        ),
      ),
    );
    await harness.waitFor(
      () => rig.store.get('c1')?.status == OutgoingMessageStatus.sent,
    );
    expect(rig.server.commands, hasLength(1));
  });

  test('离线时 drain 不发送：消息保持 queued', () async {
    final rig = OutboxRig();
    addTearDown(rig.dispose);
    rig.store.enqueue(clientId: 'c1', sessionId: 'sess-1', text: '离线', ts: 100);

    rig.flusher.start();
    await rig.flusher.drain();
    await harness.settle();

    expect(rig.store.get('c1')?.status, OutgoingMessageStatus.queued);
    expect(rig.server.commands, isEmpty);
  });
}
