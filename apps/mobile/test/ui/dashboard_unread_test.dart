import 'package:aimi/app/providers.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/db/aimi_database.dart';
import 'package:aimi/data/db/persistent_cache.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/ui/dashboard/dashboard_screen.dart';
import 'package:aimi/app/session_render_provider.dart';
import 'package:aimi/ui/session/session_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../data/connection/aimi_connection_test.dart' as harness;

/// 未读蓝点（批次5）：进入过的会话（有水位行）且镜像 lastSeq 超过水位 →
/// 行尾蓝点；从未进入过的会话无基线不亮；回写后蓝点消失。
void main() {
  SessionMetaDto meta(String id, int lastSeq) => SessionMetaDto(
    id: id,
    agentId: 'claude',
    cwd: 'C:/p-$id',
    permissionMode: 'default',
    state: 'finished',
    lastSeq: lastSeq,
    createdAt: 1,
    updatedAt: 1,
  );

  testWidgets('有水位且超前的会话亮蓝点；已读/从未进入的不亮', (tester) async {
    final container = ProviderContainer(
      overrides: [
        cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
        connectionProvider.overrideWith((ref) => null),
        connStateProvider.overrideWith(
          (ref) => Stream.value(ConnState.onlineLan),
        ),
        endpointsProvider.overrideWith((ref) async => harness.endpoints),
        cacheProvider.overrideWith((ref) async => SessionMirror()),
        sessionsProvider.overrideWith(
          (ref) => [meta('s-read', 5), meta('s-unread', 7), meta('s-never', 9)],
        ),
        // s-read：读到 5（无新事件）；s-unread：读到 5、镜像已到 7 → 亮；
        // s-never：无水位行（从未进入）→ 不亮（无基线口径）。
        readStatesProvider.overrideWith(
          (ref) => Stream.value({'s-read': 5, 's-unread': 5}),
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

    expect(find.byKey(const ValueKey('unread-dot')), findsOneWidget);
  });

  testWidgets('会话页打开即回写水位（drift 持久化可复检）', (tester) async {
    final db = AimiDatabase.inMemory();
    addTearDown(db.close);
    final repository = ReadStateRepository(db);
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
        databaseProvider.overrideWith((ref) => db),
        readStatesProvider.overrideWith((ref) => const Stream.empty()),
        sessionsProvider.overrideWith((ref) => [meta('s1', 5)]),
        sessionRenderEventsProvider('s1').overrideWith((ref) => []),
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
    await tester.pump(const Duration(milliseconds: 100));

    expect(await repository.readAll(), {'s1': 5});
  });

  testWidgets('回写只前进不回退', (tester) async {
    final db = AimiDatabase.inMemory();
    addTearDown(db.close);
    final repository = ReadStateRepository(db);
    await repository.markRead('s1', 7);
    await repository.markRead('s1', 3);
    expect(await repository.readAll(), {'s1': 7});
  });
}
