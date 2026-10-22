import 'dart:async';
import 'dart:convert';

import 'package:aimi/app/providers.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/db/aimi_database.dart';
import 'package:aimi/data/db/persistent_cache.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/ui/new_session/new_session_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// `WebSocketChannel` 的手写流对桩（同 aimi_connection_test 形态）：
/// 双向通道由 [StreamChannelController] 承载，帧以 JSON 字符串走真实编解码，
/// 测试内不触及任何真实 socket。
class _StubWebSocketChannel extends StreamChannelMixin
    implements WebSocketChannel {
  final StreamChannelController<Object?> _controller =
      StreamChannelController<Object?>(sync: true, allowForeignErrors: false);

  /// 手机→server 的原始帧（连接层序列化后的 JSON 文本）。
  Stream<Object?> get clientFrames => _controller.local.stream;

  /// 模拟 server 下发一条帧。
  void serverSend(String json) => _controller.local.sink.add(json);

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

/// 只实现连接层实际用到的成员；`close` 的 code/reason 被忽略。
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

void main() {
  testWidgets('新建会话聚焦预填目录时全选，并提供清空操作', (tester) async {
    const cwd = r'D:\AiProject\aimi-smoke-sandbox';
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          endpointsProvider.overrideWith((ref) async => null),
          cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
          sessionsProvider.overrideWith(
            (ref) => const [
              SessionMetaDto(
                id: 's1',
                agentId: 'claude',
                cwd: cwd,
                permissionMode: 'default',
                state: 'finished',
                lastSeq: 0,
                createdAt: 1,
                updatedAt: 1,
              ),
            ],
          ),
        ],
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const NewSessionScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 目录预填最近会话的 cwd（mono 井里的第二个 TextField）。
    final cwdField = tester.widget<TextField>(find.byType(TextField).at(1));
    expect(cwdField.controller!.text, cwd);

    // 聚焦即全选：用户接着输入会整体替换，而不是插在路径中间。
    await tester.tap(find.byType(TextField).at(1));
    await tester.pump();
    expect(cwdField.controller!.selection.baseOffset, 0);
    expect(cwdField.controller!.selection.extentOffset, cwd.length);

    // 清除按钮：一键清空，避免残留旧路径。
    await tester.tap(find.byTooltip('清除目录'));
    await tester.pump();
    expect(cwdField.controller!.text, isEmpty);
  });

  testWidgets('新建会话页只决定任务/目录/agent/模型，不含权限与审批', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          endpointsProvider.overrideWith((ref) async => null),
          cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
          sessionsProvider.overrideWith((ref) => const <SessionMetaDto>[]),
        ],
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const NewSessionScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('任务'), findsOneWidget);
    expect(find.text('默认模型'), findsOneWidget);
    expect(find.text('Opus 4.6'), findsNothing);
    expect(find.text('目录'), findsOneWidget);
    expect(find.text('Agent'), findsOneWidget);
    expect(find.text('模型'), findsOneWidget);
    expect(find.text('开始'), findsOneWidget);
    // codex 不可用：置灰 + 斜杠 + 可访问说明（三重编码；标签在 Semantics 节点上）。
    final codexSemantics = tester.widgetList<Semantics>(find.byType(Semantics)).where(
          (widget) => widget.properties.label == 'codex，暂不可用',
        );
    expect(codexSemantics, isNotEmpty);
    expect(codexSemantics.first.properties.enabled, isFalse);
    // 权限档位与审批不应出现在这一层（design.md §2.2）。
    expect(find.text('每次询问'), findsNothing);
    expect(find.text('允许一次'), findsNothing);
  });

  testWidgets('空目录点击开始 → 页内错误提示且不发起创建', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          endpointsProvider.overrideWith((ref) async => null),
          cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
          sessionsProvider.overrideWith((ref) => const <SessionMetaDto>[]),
        ],
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const NewSessionScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('开始'));
    await tester.pumpAndSettle();
    expect(find.text('请先填写目标目录'), findsOneWidget);
  });

  testWidgets('空任务点击开始 → 提示填写目标和期望结果', (tester) async {
    const cwd = r'D:\AiProject\aimi-smoke-sandbox';
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          endpointsProvider.overrideWith((ref) async => null),
          cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
          sessionsProvider.overrideWith(
            (ref) => const [
              SessionMetaDto(
                id: 's1',
                agentId: 'claude',
                cwd: cwd,
                permissionMode: 'default',
                state: 'finished',
                lastSeq: 0,
                createdAt: 1,
                updatedAt: 1,
              ),
            ],
          ),
        ],
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const NewSessionScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('开始'));
    await tester.pumpAndSettle();
    expect(find.text('请描述任务目标和期望结果'), findsOneWidget);
  });

  testWidgets('创建成功：首条任务入发送记录，新会话写入镜像并进入会话页', (tester) async {
    // 回归：welcome 只在连接时全量下发，新建的会话若不写本地镜像，会话页在
    // 下次 welcome 前读不到 meta.state——起势过渡与 composer 打断态全部失效。
    const cwd = r'D:\AiProject\aimi-smoke-sandbox';
    const task = '这个项目是干嘛的？';
    final mirror = SessionMirror();
    final database = AimiDatabase.inMemory();
    final store = await DriftOutgoingMessageStore.open(database);

    // 脚本化 server：hello→welcome 完成上线，session.create 回 ack（不触及真实 socket）。
    final stub = _StubWebSocketChannel();
    stub.clientFrames.listen((frame) {
      if (frame is! String) return;
      switch (jsonDecode(frame)['type']) {
        case 'hello':
          stub.serverSend(
            jsonEncode({
              'v': 1,
              'type': 'welcome',
              'serverVersion': '0.1.0',
              'sessions': const [],
            }),
          );
        case 'session.create':
          stub.serverSend(
            jsonEncode({'v': 1, 'type': 'ack', 'sessionId': 'sess-new'}),
          );
      }
    });
    final connection = AimiConnection(
      endpoints: const AimiEndpoints(host: '127.0.0.1', port: 8787, token: 't'),
      cache: mirror,
      channelFactory: (_) => stub,
    );
    // 先 pump 再 connect：connStateProvider 在页面首帧订阅连接流，connect 造成
    // 的 offline→onlineLan 变化才会推送进来（流不重放订阅前的旧状态）。


    final router = GoRouter(
      initialLocation: '/new-session',
      routes: [
        GoRoute(
          path: '/new-session',
          builder: (context, state) => const NewSessionScreen(),
        ),
        GoRoute(
          path: '/session/:id',
          builder: (context, state) => Scaffold(
            body: Text('session-page:${state.pathParameters['id']}'),
          ),
        ),
      ],
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
          connectionProvider.overrideWithValue(connection),
          cacheProvider.overrideWith((ref) async => mirror),
          outgoingMessageStoreProvider.overrideWith((ref) async => store),
        ],
        child: MaterialApp.router(
          routerConfig: router,
          theme: AimiTheme.light(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await connection.connect();
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), task);
    await tester.enterText(find.byType(TextField).at(1), cwd);
    await tester.tap(find.text('开始'));
    await tester.pumpAndSettle();

    // 进入会话页。
    expect(find.text('session-page:sess-new'), findsOneWidget);
    // 新会话已写入镜像：state 从 starting 起步 + 创建请求字段齐全。
    final created = mirror.session('sess-new');
    expect(created, isNotNull);
    expect(created!.state, 'starting');
    expect(created.agentId, 'claude');
    expect(created.cwd, cwd);
    expect(created.model, isNull);
    // 首条任务已进本地发送记录（重进会话后可见）。
    expect(store.messagesFor('sess-new').single.text, task);

    // 组件测试的 pending-timer 检查先于 addTearDown 执行，收尾必须在测试体内：
    // 连接 dispose 取消心跳（周期定时器不会自行耗尽），推进假时间耗尽
    // createSession 的 Future.timeout 兜底 Timer（ack 先到时它不会自取消）。
    connection.dispose();
    await database.close();
    await tester.pump(const Duration(minutes: 1));
  });
}
