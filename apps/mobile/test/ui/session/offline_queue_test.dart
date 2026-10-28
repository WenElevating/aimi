import 'package:aimi/app/providers.dart';
import 'package:aimi/app/session_render_provider.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/ui/session/session_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../data/connection/aimi_connection_test.dart' as harness;

/// 离线发送接线：输入不被断线禁用，消息进本地队列并在时间线标记「待发送」，
/// 队列状态被补发服务更新后 UI 跟随（queued → sent 徽标消失）。
///
/// 注意：会话页头部有每秒刷新耗时的周期 Timer，本文件一律用固定步进
/// pump（不能用 pumpAndSettle，否则永不收敛）。
void main() {
  /// 公共装配：离线连接 + finished 会话 + 空事件 + 注入的内存队列。
  Future<ProviderContainer> boot(
    WidgetTester tester, {
    required OutgoingMessageStore store,
  }) async {
    // 从不 connect 的真实连接：connStateProvider 推 offline。
    final connection = AimiConnection(
      endpoints: harness.endpoints,
      cache: SessionMirror(),
      channelFactory: (_) => harness.StubWebSocketChannel(),
    );
    addTearDown(connection.dispose);
    final container = ProviderContainer(
      overrides: [
        cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
        connectionProvider.overrideWith((ref) => connection),
        cacheProvider.overrideWith((ref) async => SessionMirror()),
        sessionsProvider.overrideWith(
          (ref) => const [
            SessionMetaDto(
              id: 's1',
              agentId: 'claude',
              cwd: 'C:/project',
              permissionMode: 'default',
              state: 'finished',
              lastSeq: 2,
              createdAt: 1,
              updatedAt: 1,
            ),
          ],
        ),
        sessionRenderEventsProvider('s1').overrideWith((ref) => []),
        outgoingMessageStoreProvider.overrideWith((ref) async => store),
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const SessionScreen(sessionId: 's1'),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    return container;
  }

  testWidgets('离线发送：消息进入队列并在时间线标记待发送', (tester) async {
    final store = OutgoingMessageStore();
    await boot(tester, store: store);

    // 断线不再禁用输入：可以打字并点发送。
    await tester.enterText(find.byType(TextField), '离线消息');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('待发送'), findsOneWidget);
    // 消息文本出现两处：时间线气泡 + 会话标题（首条用户消息即标题，既有口径）。
    expect(find.text('离线消息'), findsWidgets);
    final queued = store.messagesFor('s1');
    expect(queued, hasLength(1));
    expect(queued.single.status, OutgoingMessageStatus.queued);
    expect(queued.single.text, '离线消息');

    // 冲掉 snack 的 4s 自动消失定时器，避免测试结束残留。
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('补发完成后徽标跟随队列状态消失', (tester) async {
    final store = OutgoingMessageStore();
    await boot(tester, store: store);
    await tester.enterText(find.byType(TextField), '稍后补发');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('待发送'), findsOneWidget);

    // 补发服务回写队列状态（markSent），时间线徽标应随之消失。
    store.markSent(store.messagesFor('s1').single.clientId);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('待发送'), findsNothing);
    // 同上：标题与气泡各一处。
    expect(find.text('稍后补发'), findsWidgets);

    await tester.pump(const Duration(seconds: 5));
  });
}
