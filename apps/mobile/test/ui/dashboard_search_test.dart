import 'package:aimi/app/providers.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/ui/dashboard/dashboard_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../data/connection/aimi_connection_test.dart' as harness;

/// 会话列表搜索（feedback #20261025-204503-8b9db4②）：
/// 隐藏式搜索入口 + 本地子串过滤（cwd/项目名/状态名），与状态 chips 叠加。
void main() {
  SessionMetaDto meta(String id, String cwd, String state) => SessionMetaDto(
    id: id,
    agentId: 'claude',
    cwd: cwd,
    permissionMode: 'default',
    state: state,
    lastSeq: 0,
    createdAt: 1,
    updatedAt: 1,
  );

  /// 公共装配：在线 + 已配置端点 + 两个项目的会话（无事件，标题=项目名）。
  Future<void> boot(WidgetTester tester) async {
    final container = ProviderContainer(
      overrides: [
        cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
        connectionProvider.overrideWith((ref) => null),
        connStateProvider.overrideWith((ref) => Stream.value(ConnState.onlineLan)),
        endpointsProvider.overrideWith((ref) async => harness.endpoints),
        cacheProvider.overrideWith((ref) async => SessionMirror()),
        sessionsProvider.overrideWith(
          (ref) => [
            meta('s1', r'C:\work-alpha', 'finished'),
            meta('s2', r'C:\work-alpha', 'running'),
            meta('s3', r'D:\beta', 'finished'),
          ],
        ),
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const DashboardScreen(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
  }

  testWidgets('默认收起搜索；点图标展开输入行', (tester) async {
    await boot(tester);
    expect(find.byType(TextField), findsNothing);

    await tester.tap(find.byTooltip('搜索会话'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('关键字过滤会话列表，chip 计数随过滤变化', (tester) async {
    await boot(tester);
    await tester.tap(find.byTooltip('搜索会话'));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'beta');
    // 200ms 防抖 + 重建。
    await tester.pump(const Duration(milliseconds: 300));

    // beta 项目的组头与行可见；work-alpha 的组头/行消失。
    expect(find.text('beta'), findsWidgets);
    expect(find.text('work-alpha'), findsNothing);
    // chip 计数按过滤结果计（全部 1）。
    expect(find.text('全部 1'), findsOneWidget);
  });

  testWidgets('大小写不敏感；清空后恢复全部', (tester) async {
    await boot(tester);
    await tester.tap(find.byTooltip('搜索会话'));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'WORK-ALPHA');
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('beta'), findsNothing);

    await tester.enterText(find.byType(TextField), '');
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('work-alpha'), findsWidgets);
    expect(find.text('beta'), findsWidgets);
  });

  testWidgets('无匹配时展示空态文案', (tester) async {
    await boot(tester);
    await tester.tap(find.byTooltip('搜索会话'));
    await tester.pump();
    await tester.enterText(find.byType(TextField), '不存在');
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('没有匹配的会话'), findsOneWidget);
  });
}
