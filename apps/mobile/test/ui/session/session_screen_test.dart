import 'package:aimi/app/providers.dart';
import 'package:aimi/app/session_render_provider.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/db/aimi_database.dart';
import 'package:aimi/data/db/persistent_cache.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/ui/session/session_screen.dart';
import 'package:aimi/ui/session/composer.dart';
import 'package:aimi/ui/session/shimmer_line.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// 事件流的可变容器：测试内改 state 即驱动会话页重绘。
///
/// why 不用二次 `pumpWidget`：family provider 的 override 在第二次 pump 时不会
/// 重新求值，数据源换不掉（表现为"改了数据界面不动"）。
final eventsHolder = StateNotifierProvider<EventsHolder, List<AgentEventDto>>(
  (ref) => EventsHolder(),
);

/// 可变事件列表的持有者。
class EventsHolder extends StateNotifier<List<AgentEventDto>> {
  EventsHolder() : super(const <AgentEventDto>[]);
}

/// 会话元数据的可变持有者（同理，避免二次 pump 不生效）。
final metaHolder = StateNotifierProvider<MetaHolder, SessionMetaDto>(
  (ref) => MetaHolder(),
);

/// 可变会话元数据的持有者。
class MetaHolder extends StateNotifier<SessionMetaDto> {
  MetaHolder() : super(_metaOf('running'));
}

SessionMetaDto _metaOf(String state) => SessionMetaDto(
  id: 's1',
  agentId: 'claude',
  cwd: r'D:\proj',
  permissionMode: 'default',
  state: state,
  lastSeq: 0,
  createdAt: 1,
  updatedAt: 1,
);

/// 会话页骨架：overrides 挂在测试自建的容器上（与测试改 state 的是同一个），
/// 数据变化才能传导到页面。
Widget _sessionApp(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(
    theme: AimiTheme.light(),
    home: const SessionScreen(sessionId: 's1'),
  ),
);

void main() {
  /// 建容器并渲染；返回容器供测试在数据变化后改 holder 再 pump。
  ///
  /// [seedStore] 在首次 pump 前向离线发送队列落一条消息（模拟"已发送/已排队、
  /// 尚未被事件锚定"的 trailing 形态）；[connState] 可注入离线等链路状态。
  Future<ProviderContainer> boot(
    WidgetTester tester, {
    required List<AgentEventDto> events,
    required String state,
    ConnState connState = ConnState.onlineLan,
    Future<void> Function(DriftOutgoingMessageStore store)? seedStore,
  }) async {
    final container = ProviderContainer(
      overrides: [
        cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
        connStateProvider.overrideWith((ref) => Stream.value(connState)),
        sessionsProvider.overrideWith(
          (ref) => <SessionMetaDto>[ref.watch(metaHolder)],
        ),
        sessionRenderEventsProvider(
          's1',
        ).overrideWith((ref) => ref.watch(eventsHolder)),
        cacheProvider.overrideWith((ref) async => SessionMirror()),
        outgoingMessageStoreProvider.overrideWith(
          (ref) async =>
              DriftOutgoingMessageStore.open(AimiDatabase.inMemory()),
        ),
        connectionProvider.overrideWith((ref) => null),
      ],
    );
    addTearDown(container.dispose);
    container.read(metaHolder.notifier).state = _metaOf(state);
    container.read(eventsHolder.notifier).state = events;
    if (seedStore != null) {
      await seedStore(
        await container.read(outgoingMessageStoreProvider.future),
      );
    }
    await tester.pumpWidget(_sessionApp(container));
    await tester.pump();
    return container;
  }

  testWidgets('运行中且无可见输出：agent 标签下显示起势过渡', (tester) async {
    await boot(
      tester,
      events: [
        AgentEventDto.fromJson({'type': 'state', 'state': 'starting'}),
        AgentEventDto.fromJson({'type': 'state', 'state': 'running'}),
      ],
      state: 'running',
    );
    expect(find.byType(ShimmerLine), findsOneWidget);
  });

  testWidgets('已有可见输出的运行回合：底部持续显示生成过渡', (tester) async {
    await boot(
      tester,
      events: [
        AgentEventDto.fromJson({'type': 'state', 'state': 'starting'}),
        AgentEventDto.fromJson({'type': 'state', 'state': 'running'}),
        AgentEventDto.fromJson({'type': 'text_delta', 'text': '回复'}),
      ],
      state: 'running',
    );
    expect(find.byType(ShimmerLine), findsOneWidget);
  });

  testWidgets('回合无输出即起势；首个可见输出后仍保持生成态', (tester) async {
    final container = await boot(
      tester,
      events: [
        AgentEventDto.fromJson({'type': 'state', 'state': 'starting'}),
        AgentEventDto.fromJson({'type': 'state', 'state': 'running'}),
      ],
      state: 'running',
    );
    expect(find.byType(ShimmerLine), findsOneWidget);

    // 首 token/错误原因到达 → Shimmer 继续留在回复尾部。
    container.read(eventsHolder.notifier).state = [
      AgentEventDto.fromJson({'type': 'state', 'state': 'starting'}),
      AgentEventDto.fromJson({'type': 'state', 'state': 'running'}),
      AgentEventDto.fromJson({
        'type': 'text_delta',
        'text': '403 当前令牌无权访问所选分组',
        'error': true,
      }),
    ];
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.byType(ShimmerLine), findsOneWidget);
    // 错误原因可见（时间线正文 + header 标题各一份）。
    expect(find.textContaining('403 当前令牌无权访问所选分组'), findsWidgets);
  });

  testWidgets('会话已结束（failed）不再起势', (tester) async {
    await boot(
      tester,
      events: [
        AgentEventDto.fromJson({'type': 'state', 'state': 'starting'}),
        AgentEventDto.fromJson({
          'type': 'text_delta',
          'text': '403 无权访问',
          'error': true,
        }),
        AgentEventDto.fromJson({'type': 'state', 'state': 'failed'}),
      ],
      state: 'failed',
    );
    expect(find.byType(ShimmerLine), findsNothing);
  });

  testWidgets('发送后回合未开盘即起势（上一回合的输出不压制新回合）', (tester) async {
    // 真机回归形态：finished 会话（上一回合有输出）再发消息——服务端要等
    // CLI init 才翻 running（秒级），起势必须在发送瞬间就出现。
    // 旧回合的消息也在队列里（历史 sent 记录），由旧回合的 starting 锚定；
    // 新消息滞留 trailing，等待下一次 starting 开盘。
    await boot(
      tester,
      events: [
        AgentEventDto.fromJson({'type': 'state', 'state': 'starting'}),
        AgentEventDto.fromJson({'type': 'state', 'state': 'running'}),
        AgentEventDto.fromJson({'type': 'text_delta', 'text': '上一回合回复'}),
      ],
      state: 'finished',
      seedStore: (store) async {
        store.enqueue(
          clientId: 'client-old',
          sessionId: 's1',
          text: '第一条提问',
          ts: 1,
        );
        store.enqueue(
          clientId: 'client-fresh',
          sessionId: 's1',
          text: '第二条提问',
          ts: 2,
        );
      },
    );
    expect(find.byType(ShimmerLine), findsOneWidget);
  });

  testWidgets('长文本流式仅在底部跟随，上滑后保持阅读位置且输入区不重建', (tester) async {
    final initial = [
      AgentEventDto.fromJson({'type': 'state', 'state': 'starting'}),
      AgentEventDto.fromJson({
        'type': 'text_delta',
        'text': List.filled(100, '历史输出一行\n').join(),
      }),
    ];
    final container = await boot(tester, events: initial, state: 'running');
    await tester.pump();
    final scrollFinder = find.byKey(const ValueKey('session-timeline-scroll'));
    final controller = tester
        .widget<SingleChildScrollView>(scrollFinder)
        .controller!;
    await tester.pump(const Duration(milliseconds: 120));
    await tester.pump(const Duration(milliseconds: 120));
    expect(controller.offset, closeTo(controller.position.maxScrollExtent, 1));
    final inputBefore = tester.widget<Composer>(find.byType(Composer));
    container.read(eventsHolder.notifier).state = [
      ...initial,
      AgentEventDto.fromJson({'type': 'text_delta', 'text': '\n新输出'}),
    ];
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));
    await tester.pump(const Duration(milliseconds: 120));
    expect(controller.offset, closeTo(controller.position.maxScrollExtent, 1));
    expect(
      identical(inputBefore, tester.widget<Composer>(find.byType(Composer))),
      isTrue,
    );
    // 小幅拖动仍处于旧版 96px 阈值内，也不能被下一批输出抢回底部。
    await tester.drag(scrollFinder, const Offset(0, 40));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    final smallDragOffset = controller.offset;
    expect(
      controller.position.maxScrollExtent - smallDragOffset,
      greaterThan(0),
    );
    container.read(eventsHolder.notifier).state = [
      ...container.read(eventsHolder),
      AgentEventDto.fromJson({'type': 'text_delta', 'text': '继续输出'}),
    ];
    await tester.pump();
    await tester.pump();
    expect(controller.offset, closeTo(smallDragOffset, 1));
    await tester.drag(scrollFinder, const Offset(0, 350));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    final readingOffset = controller.offset;
    expect(
      controller.position.maxScrollExtent - readingOffset,
      greaterThan(96),
    );
    container.read(eventsHolder.notifier).state = [
      ...container.read(eventsHolder),
      AgentEventDto.fromJson({'type': 'text_delta', 'text': '\n末尾仍在增长\n'}),
    ];
    await tester.pump();
    await tester.pump();
    expect(controller.offset, closeTo(readingOffset, 1));
  });

  testWidgets('离线排队中的消息不起势（避免死等闪烁）', (tester) async {
    await boot(
      tester,
      events: [
        AgentEventDto.fromJson({'type': 'state', 'state': 'starting'}),
        AgentEventDto.fromJson({'type': 'state', 'state': 'running'}),
        AgentEventDto.fromJson({'type': 'text_delta', 'text': '上一回合回复'}),
      ],
      state: 'finished',
      connState: ConnState.offline,
      seedStore: (store) async {
        store.enqueue(
          clientId: 'client-queued',
          sessionId: 's1',
          text: '排队消息',
          ts: 2,
        );
      },
    );
    expect(find.byType(ShimmerLine), findsNothing);
  });
}
