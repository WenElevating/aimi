import 'dart:convert';

import 'package:aimi/app/providers.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/db/aimi_database.dart';
import 'package:aimi/data/db/persistent_cache.dart';
import 'package:aimi/ui/new_session/new_session_screen.dart';
import 'package:aimi/ui/session/composer.dart';
import 'package:aimi/ui/session/session_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import '../data/connection/aimi_connection_test.dart' show StubWebSocketChannel;

const _oldModel = 'vendor-a/model-old';
const _newModel = 'vendor-b/model-new[fast]';
const _models = <Map<String, String>>[
  {'value': _oldModel, 'name': '供应商 A 模型'},
  {'value': _newModel, 'name': '供应商 B 模型'},
];

/// 用真实连接、协议解析和镜像驱动页面；只替换 WebSocket 对端及 SQLite 存储位置。
class _ModelHarness {
  /// 建立未连接的测试环境，允许手动控制创建和配置的回执时机。
  _ModelHarness({this.newSession = false, this.ackStatus = 'delivered'}) {
    connection = AimiConnection(
      endpoints: const AimiEndpoints(host: '127.0.0.1', port: 8787, token: 't'),
      cache: mirror,
      channelFactory: (_) => channel,
      createTimeout: const Duration(seconds: 2),
    );
    channel.clientFrames.listen(_receive);
  }

  final bool newSession;
  String? ackStatus;
  bool autoCreateAck = true;
  final mirror = SessionMirror();
  final database = AimiDatabase.inMemory();
  final channel = StubWebSocketChannel();
  final commands = <Map<String, dynamic>>[];
  final creates = <Map<String, dynamic>>[];
  late final AimiConnection connection;
  late final ProviderContainer container;
  late final GoRouter router;
  List<Map<String, String>> models = _models;

  /// 服务端握手与显式配置回执；模型标识从来不做别名转换。
  void _receive(Object? raw) {
    final frame = jsonDecode(raw as String) as Map<String, dynamic>;
    switch (frame['type']) {
      case 'hello':
        welcome();
      case 'session.create':
        creates.add(frame);
        if (autoCreateAck) created();
      case 'session.command':
        commands.add(frame);
        if (ackStatus != null) acknowledge(ackStatus!);
      case 'ping':
        channel.serverSend(jsonEncode({'v': 1, 'type': 'pong'}));
    }
  }

  /// 用同一个 welcome 同步能力清单与权威会话模型，覆盖重连后的恢复路径。
  void welcome({String model = _oldModel}) {
    channel.serverSend(
      jsonEncode({
        'v': 1,
        'type': 'welcome',
        'serverVersion': '0.1.0',
        'agents': [
          {
            'id': 'claude',
            'label': 'Claude',
            'permissionCeiling': 'default',
            'models': models,
          },
        ],
        'sessions': newSession
            ? []
            : [
                {
                  'id': 's1',
                  'agentId': 'claude',
                  'cwd': 'D:/work',
                  'permissionMode': 'default',
                  'model': model,
                  'state': 'finished',
                  'lastSeq': 0,
                  'createdAt': 1,
                  'updatedAt': 1,
                },
              ],
      }),
    );
  }

  /// 确认创建，用于验证请求发出后的表单值不会污染新会话镜像。
  void created() {
    channel.serverSend(jsonEncode({'v': 1, 'type': 'ack', 'sessionId': 's1'}));
  }

  /// 回复最近一条配置命令，保留真实 clientId 关联。
  void acknowledge(String status) {
    channel.serverSend(
      jsonEncode({
        'v': 1,
        'type': 'command.ack',
        'sessionId': 's1',
        'clientId': commands.last['clientId'],
        'status': status,
      }),
    );
  }

  /// 模拟上一回合的完整实测模型；它不应改变当前配置选择或下拉勾选。
  void observedModel() {
    channel.serverSend(
      jsonEncode({
        'v': 1,
        'type': 'session.event',
        'sessionId': 's1',
        'seq': 1,
        'ts': 2,
        'agentEvent': {'type': 'configured', 'model': 'actual-old-model'},
      }),
    );
  }

  /// 先挂载订阅再连接，让页面走真实的在线状态与能力投影通知链。
  Future<void> boot(WidgetTester tester) async {
    addTearDown(() async {
      if (connection.mounted) connection.dispose();
      await database.close();
    });
    final store = await DriftOutgoingMessageStore.open(database);
    container = ProviderContainer(
      overrides: [
        cacheProvider.overrideWith((ref) async => mirror),
        connectionProvider.overrideWithValue(connection),
        outgoingMessageStoreProvider.overrideWith((ref) async => store),
      ],
    );
    container.read(capsBootstrapProvider);
    router = GoRouter(
      initialLocation: newSession ? '/new-session' : '/session/s1',
      routes: [
        GoRoute(
          path: '/new-session',
          builder: (context, state) => const NewSessionScreen(),
        ),
        GoRoute(
          path: '/session/:id',
          builder: (context, state) =>
              SessionScreen(sessionId: state.pathParameters['id']!),
        ),
      ],
    );
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(
          theme: AimiTheme.light(),
          routerConfig: router,
        ),
      ),
    );
    await tester.pump();
    await connection.connect();
    await tester.pumpAndSettle();
  }

  /// 卸载页面并清理连接心跳、超时和数据库，不把临时资源留给下一条用例。
  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    connection.dispose();
    container.dispose();
    router.dispose();
    await mirror.flushPersistence();
    mirror.dispose();
    await database.close();
    await tester.pump(const Duration(seconds: 3));
  }
}

/// 检查页面上的模型值与真实 JSON 帧，避免只测回调却漏掉显示和镜像不同步。
void main() {
  testWidgets('自定义供应商模型：新建页名称、创建帧和进入会话后的选择一致', (tester) async {
    final h = _ModelHarness(newSession: true);
    await h.boot(tester);
    await tester.tap(find.text('默认模型'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('供应商 B 模型'));
    await tester.pumpAndSettle();
    expect(find.text('供应商 B 模型'), findsOneWidget);

    h.models = [
      _models.first,
      {'value': _newModel, 'name': '供应商 B 新名称'},
    ];
    h.welcome();
    await tester.pumpAndSettle();
    expect(find.text('供应商 B 新名称'), findsOneWidget);
    await tester.enterText(find.byType(TextField).at(0), '测试模型选择');
    await tester.enterText(find.byType(TextField).at(1), 'D:/work');
    h.autoCreateAck = false;
    await tester.tap(find.text('开始'));
    await tester.pumpAndSettle();
    expect(h.creates.single['spec']['model'], _newModel);
    await tester.tap(find.text('供应商 B 新名称'));
    await tester.pumpAndSettle();
    expect(find.text('供应商 A 模型'), findsNothing);
    h.created();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 400));
    expect(h.mirror.session('s1')?.model, _newModel);
    expect(tester.widget<Composer>(find.byType(Composer)).model, _newModel);
    await h.close(tester);
  });

  testWidgets('旧实测值不覆盖选择：等待回执禁重复，成功后镜像驱动页面与勾选', (tester) async {
    final h = _ModelHarness(ackStatus: null);
    await h.boot(tester);
    h.observedModel();
    await tester.pumpAndSettle();
    expect(find.text('供应商 A 模型'), findsOneWidget);
    await tester.tap(find.text('供应商 A 模型'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('供应商 B 模型'));
    await tester.pumpAndSettle();
    expect(h.commands.single['cmd']['model'], _newModel);
    expect(h.mirror.session('s1')?.model, _oldModel);
    await tester.tap(find.text('供应商 A 模型'));
    await tester.pumpAndSettle();
    expect(find.text('供应商 B 模型'), findsNothing);
    h.acknowledge('delivered');
    await tester.pumpAndSettle();
    expect(h.mirror.session('s1')?.model, _newModel);
    expect(find.text('供应商 B 模型'), findsOneWidget);
    await tester.tap(find.text('供应商 B 模型'));
    await tester.pumpAndSettle();
    final selected = tester
        .widgetList<Semantics>(find.byType(Semantics))
        .where((w) => w.properties.checked == true);
    expect(selected, hasLength(1));
    expect(
      find.descendant(
        of: find.byWidget(selected.single),
        matching: find.text('供应商 B 模型'),
      ),
      findsOneWidget,
    );
    await tester.tapAt(const Offset(1, 1));
    await tester.pumpAndSettle();
    h.welcome(model: _oldModel);
    await tester.pumpAndSettle();
    expect(find.text('供应商 A 模型'), findsOneWidget);
    expect(find.text('供应商 B 模型'), findsNothing);
    await h.close(tester);
  });

  for (final status in ['rejected', 'duplicate', 'timeout']) {
    testWidgets('配置$status不造成假成功，保留当前镜像模型', (tester) async {
      final h = _ModelHarness(ackStatus: status == 'timeout' ? null : status);
      await h.boot(tester);
      await tester.tap(find.text('供应商 A 模型'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('供应商 B 模型'));
      await tester.pumpAndSettle();
      if (status == 'timeout') {
        await tester.pump(const Duration(seconds: 3));
        await tester.pumpAndSettle();
      }
      expect(h.mirror.session('s1')?.model, _oldModel);
      expect(find.text('供应商 A 模型'), findsOneWidget);
      expect(find.text('供应商 B 模型'), findsNothing);
      await h.close(tester);
    });
  }

  testWidgets('等待模型回执时离开页面，成功结果仍保存且重进会话立即可见', (tester) async {
    final h = _ModelHarness(ackStatus: null);
    await h.boot(tester);
    await tester.tap(find.text('供应商 A 模型'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('供应商 B 模型'));
    await tester.pumpAndSettle();
    h.router.go('/new-session');
    await tester.pumpAndSettle();
    h.acknowledge('delivered');
    await tester.pumpAndSettle();
    expect(h.mirror.session('s1')?.model, _newModel);
    h.router.go('/session/s1');
    await tester.pumpAndSettle();
    expect(find.text('供应商 B 模型'), findsOneWidget);
    await h.close(tester);
  });

  testWidgets('未知模型完整原样显示，取消选择不修改当前模型', (tester) async {
    final h = _ModelHarness();
    await h.boot(tester);
    const unknown = 'another-provider/custom[variant]';
    h.welcome(model: unknown);
    await tester.pumpAndSettle();
    expect(find.text(unknown), findsOneWidget);
    await tester.tap(find.text(unknown));
    await tester.pumpAndSettle();
    await tester.tapAt(const Offset(1, 1));
    await tester.pumpAndSettle();
    expect(h.commands, isEmpty);
    expect(h.mirror.session('s1')?.model, unknown);
    await h.close(tester);
  });
}
