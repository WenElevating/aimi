import 'package:aimi/app/providers.dart';
import 'package:aimi/app/session_render_provider.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/ui/session/composer.dart';
import 'package:aimi/ui/session/session_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// 不可续接（无续接线索、服务端 archived）会话的只读态：
/// composer 整体收起，时间线末尾挂静态「已归档，仅供查看」提示；
/// 可续接（resumable）的终态会话维持现状——发消息即续接。
void main() {
  SessionMetaDto meta(String state, {required bool resumable}) =>
      SessionMetaDto(
        id: 's1',
        agentId: 'claude',
        cwd: r'C:\proj',
        permissionMode: 'default',
        state: state,
        lastSeq: 2,
        createdAt: 1,
        updatedAt: 1,
        resumable: resumable,
      );

  Future<void> boot(WidgetTester tester, SessionMetaDto meta) async {
    final container = ProviderContainer(
      overrides: [
        cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
        connectionProvider.overrideWith((ref) => null),
        connStateProvider.overrideWith(
          (ref) => Stream.value(ConnState.onlineLan),
        ),
        cacheProvider.overrideWith((ref) async => SessionMirror()),
        sessionsProvider.overrideWith((ref) => [meta]),
        sessionRenderEventsProvider('s1').overrideWith(
          (ref) => [
            AgentEventDto.fromJson({'type': 'state', 'state': 'starting'}),
            AgentEventDto.fromJson({'type': 'text_delta', 'text': '历史回答'}),
            AgentEventDto.fromJson({'type': 'state', 'state': meta.state}),
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
          home: const SessionScreen(sessionId: 's1'),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
  }

  testWidgets('不可续接的 finished 会话：composer 收起并显示归档提示', (tester) async {
    await boot(tester, meta('finished', resumable: false));
    expect(find.byType(Composer), findsNothing);
    expect(find.text('会话已归档，仅供查看'), findsOneWidget);
  });

  testWidgets('不可续接的 stopped 会话：同样只读', (tester) async {
    await boot(tester, meta('stopped', resumable: false));
    expect(find.byType(Composer), findsNothing);
    expect(find.text('会话已归档，仅供查看'), findsOneWidget);
  });

  testWidgets('可续接的 finished 会话：composer 保留（发消息即续接）', (tester) async {
    await boot(tester, meta('finished', resumable: true));
    expect(find.byType(Composer), findsOneWidget);
    expect(find.text('会话已归档，仅供查看'), findsNothing);
  });
}
