import 'dart:convert';

import 'package:aimi/app/providers.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/ui/new_session/directory_picker_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../data/connection/aimi_connection_test.dart' as harness;

/// 使用真实连接与 JSON 通道验证目录错误与选择行为。
Future<AimiConnection> pumpDirectory(
  WidgetTester tester, {
  bool supported = true,
  required List<String> requests,
}) async {
  final channel = harness.StubWebSocketChannel();
  final cache = SessionMirror();
  channel.clientFrames.listen((raw) {
    final frame = jsonDecode(raw as String) as Map<String, dynamic>;
    if (frame['type'] == 'hello') {
      channel.serverSend(
        jsonEncode({
          'v': 1,
          'type': 'welcome',
          'serverVersion': 'test',
          'sessions': [],
          if (supported) 'features': {'directoryBrowsing': true},
        }),
      );
    } else if (frame['type'] == 'directory.list') {
      final path = frame['path'] as String;
      requests.add(path);
      channel.serverSend(
        jsonEncode({
          'v': 1,
          'type': 'directory.result',
          'requestId': frame['requestId'],
          if (path == '/blocked')
            'error': 'permission_denied'
          else if (path == '/weird')
            // 服务端未来新增/本机未知的错误码：客户端不得误读为断线。
            'error': 'some_future_error_code'
          else ...{
            'path': path,
            'parent': '',
            'entries': [
              {'name': '无权限目录', 'path': '/blocked'},
              {'name': '损坏目录', 'path': '/weird'},
            ],
          },
        }),
      );
    }
  });
  final connection = AimiConnection(
    endpoints: harness.endpoints,
    cache: cache,
    channelFactory: (_) => channel,
  );
  addTearDown(connection.dispose);
  addTearDown(cache.dispose);
  await connection.connect();
  await tester.pumpWidget(
    ProviderScope(
      overrides: [connectionProvider.overrideWith((ref) => connection)],
      child: MaterialApp(
        theme: AimiTheme.light(),
        home: const DirectoryPickerScreen(initialPath: '/okay'),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return connection;
}

/// 旧服务端要清晰提示升级；读取失败后不得选择旧目录。
void main() {
  testWidgets('旧服务端目录能力缺失时提示升级并保留返回手动输入', (tester) async {
    final requests = <String>[];
    final connection = await pumpDirectory(
      tester,
      supported: false,
      requests: requests,
    );
    expect(find.textContaining('电脑端需要更新'), findsOneWidget);
    expect(requests, isEmpty);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    expect(find.text('重试'), findsOneWidget);
    await connection.disconnect();
  });

  testWidgets('无权限后禁用旧目录选择，支持重试与返回电脑根目录', (tester) async {
    final requests = <String>[];
    final connection = await pumpDirectory(tester, requests: requests);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNotNull,
    );
    await tester.tap(find.text('无权限目录'));
    await tester.pumpAndSettle();
    expect(find.text('没有权限读取此目录'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    await tester.tap(find.text('重试'));
    await tester.pumpAndSettle();
    expect(requests.where((path) => path == '/blocked'), hasLength(2));
    await tester.tap(find.text('电脑根目录'));
    await tester.pumpAndSettle();
    expect(requests.last, '');
    expect(find.text('电脑目录'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    await connection.disconnect();
  });

  testWidgets('未知错误码不误报断线：提示读取失败而非连接问题', (tester) async {
    final requests = <String>[];
    final connection = await pumpDirectory(tester, requests: requests);
    await tester.tap(find.text('损坏目录'));
    await tester.pumpAndSettle();
    expect(find.text('读取目录失败，请重试'), findsOneWidget);
    expect(find.text('电脑已断开连接，请连接后重试'), findsNothing);
    await connection.disconnect();
  });
}
