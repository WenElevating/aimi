import 'package:aimi/app/theme.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/domain/session_view.dart';
import 'package:aimi/ui/session/shimmer_line.dart';
import 'package:aimi/ui/widgets/timeline_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 把 JSON 事件解析成领域 DTO（走真实契约解析路径）。
List<AgentEventDto> eventsOf(List<Map<String, dynamic>> json) =>
    json.map(AgentEventDto.fromJson).toList();

/// 固定逻辑视口，防止不同测试机尺寸影响换行/溢出断言。
void useViewport(WidgetTester tester, {Size size = const Size(390, 844)}) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

/// 用真主题泵出时间线（颜色/字阶都来自 token，断言才对得上）。
Future<void> pumpTimeline(
  WidgetTester tester,
  ConversationView view, {
  String agentLabel = 'Claude Code',
  String? pendingRequestId,
  void Function(PermissionTimelineItem)? onOpenApproval,
  void Function(QuestionTimelineItem)? onOpenQuestion,
}) => tester.pumpWidget(
  MaterialApp(
    theme: AimiTheme.light(),
    home: Scaffold(
      body: SingleChildScrollView(
        child: TimelineView(
          view: view,
          agentLabel: agentLabel,
          pendingRequestId: pendingRequestId,
          onOpenApproval: onOpenApproval,
          onOpenQuestion: onOpenQuestion,
        ),
      ),
    ),
  ),
);

void main() {
  testWidgets('Text Shimmer 最后一句停留等待首个可见输出，不循环回第一句', (tester) async {
    useViewport(tester);
    await tester.pumpWidget(
      MaterialApp(
        theme: AimiTheme.light(),
        home: const Scaffold(body: ShimmerLine()),
      ),
    );
    await tester.pump(const Duration(seconds: 10));
    expect(find.text('思路顺了，开始写…'), findsNWidgets(2));
    expect(find.text('正在把光标接上线…'), findsNothing);
  });

  testWidgets('回合渲染：用户气泡 + 每回合一次 agent 标签 + 工具卡', (tester) async {
    useViewport(tester);
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': '我来看看'},
        {
          'type': 'tool_call',
          'id': 't1',
          'name': 'Read',
          'summary': 'apps/server/src/events/eventBus.ts',
          'inputDigest': 'd1',
        },
        {
          'type': 'tool_result',
          'id': 't1',
          'ok': true,
          'outputExcerpt': 'line1\nline2',
        },
        {'type': 'state', 'state': 'finished'},
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': '第二答'},
      ]),
      const [
        SentPrompt(clientId: 'c1', text: '第一个问题', ts: 1, status: 'sent'),
        SentPrompt(clientId: 'c2', text: '第二个问题', ts: 2, status: 'sent'),
      ],
    );
    await pumpTimeline(tester, view);

    // 两条用户消息都以气泡呈现。
    expect(find.text('第一个问题'), findsOneWidget);
    expect(find.text('第二个问题'), findsOneWidget);
    // agent 标签每回合一次（两回合 → 两次），不在工具卡里重复。
    expect(find.text('Claude Code'), findsNWidgets(2));
    // 工具卡显示工具名与 mono 参数。
    expect(find.text('Read'), findsOneWidget);
    expect(find.text('apps/server/src/events/eventBus.ts'), findsOneWidget);
    // 工具结果折叠为一行摘要（不直接展开输出）。
    expect(find.textContaining('输出 · 2 行'), findsOneWidget);
    expect(find.textContaining('line1'), findsNothing);
    expect(find.text('已完成'), findsNothing);
  });

  testWidgets('已停止的回合不额外显示终态文字', (tester) async {
    useViewport(tester);
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': '已停止的任务'},
        {'type': 'state', 'state': 'stopped'},
      ]),
      const [],
    );
    await pumpTimeline(tester, view);
    expect(find.text('已停止'), findsNothing);
  });

  testWidgets('思考行显示秒数量级，展开后可见思考文本', (tester) async {
    useViewport(tester);
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'thinking', 'text': 'x' * 120},
        {'type': 'text_delta', 'text': '答'},
      ]),
      const [],
    );
    await pumpTimeline(tester, view);
    expect(find.textContaining('思考了'), findsOneWidget);
    expect(find.text('x' * 120), findsNothing);
    await tester.tap(find.textContaining('思考了'));
    await tester.pumpAndSettle();
    expect(find.text('x' * 120), findsOneWidget);
  });

  testWidgets('空 thinking 事件不显示空内容提示', (tester) async {
    useViewport(tester);
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'thinking', 'text': ''},
        {'type': 'text_delta', 'text': '回复'},
      ]),
      const [],
    );
    await pumpTimeline(tester, view);
    expect(find.textContaining('思考了'), findsNothing);
    expect(find.text('（无内容）'), findsNothing);
    expect(find.text('回复'), findsOneWidget);
  });

  testWidgets('新建会话首个事件到达前，在 agent 标签下显示起势过渡', (tester) async {
    useViewport(tester);
    await tester.pumpWidget(
      MaterialApp(
        theme: AimiTheme.light(),
        home: Scaffold(
          body: TimelineView(
            view: conversationOf(const [], const []),
            agentLabel: 'Claude Code',
            showShimmer: true,
          ),
        ),
      ),
    );
    expect(find.text('Claude Code'), findsOneWidget);
    expect(find.byType(ShimmerLine), findsOneWidget);
  });

  testWidgets('运行回合已有用户消息时，起势过渡仍显示在 agent 标签下', (tester) async {
    // 回归：无终态行的回合会裁掉末尾"多余空隙"，shimmer 移入回合块后
    // 恰好是末位子节点，曾被 removeLast 一起删掉（设备上表现为无过渡效果）。
    useViewport(tester);
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'state', 'state': 'running'},
      ]),
      const [
        SentPrompt(clientId: 'c1', text: '这个项目是干嘛的？', ts: 1, status: 'sent'),
      ],
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AimiTheme.light(),
        home: Scaffold(
          body: TimelineView(
            view: view,
            agentLabel: 'Claude Code',
            showShimmer: true,
          ),
        ),
      ),
    );
    expect(find.text('这个项目是干嘛的？'), findsOneWidget);
    expect(find.text('Claude Code'), findsOneWidget);
    expect(find.byType(ShimmerLine), findsOneWidget);
  });

  testWidgets('起势文案逐字取自原型五句（README §4.4），不得改写', (tester) async {
    useViewport(tester);
    await tester.pumpWidget(
      MaterialApp(
        theme: AimiTheme.light(),
        home: const Scaffold(body: ShimmerLine()),
      ),
    );
    // 基底 + 高光两层 Stack，各出现一次。
    expect(find.text('正在把光标接上线…'), findsNWidgets(2));
    await tester.pump(const Duration(milliseconds: 1400));
    expect(find.text('先翻翻 event bus 的抽屉…'), findsNWidgets(2));
    await tester.pump(const Duration(milliseconds: 1400));
    expect(find.text('给 cursor 找条近路…'), findsNWidgets(2));
  });

  testWidgets('换句时整行压到 55% 再回满（原型 .swap，100ms 各向）', (tester) async {
    useViewport(tester);
    await tester.pumpWidget(
      MaterialApp(
        theme: AimiTheme.light(),
        home: const Scaffold(body: ShimmerLine()),
      ),
    );
    await tester.pump(const Duration(milliseconds: 1400));
    // 换句后 50ms：处于压暗行程中。
    await tester.pump(const Duration(milliseconds: 50));
    final dip = tester
        .widgetList<Opacity>(
          find.descendant(
            of: find.byType(ShimmerLine),
            matching: find.byType(Opacity),
          ),
        )
        .first;
    expect(dip.opacity, lessThan(1.0));
    expect(dip.opacity, greaterThanOrEqualTo(0.55));
    // 行程走完：整行回满，字形始终在。
    await tester.pump(const Duration(milliseconds: 200));
    for (final opacity in tester.widgetList<Opacity>(
      find.descendant(
        of: find.byType(ShimmerLine),
        matching: find.byType(Opacity),
      ),
    )) {
      expect(opacity.opacity, 1.0);
    }
  });

  testWidgets('首个可见输出到达：起势行 180ms 淡出上移交棒，不闪没', (tester) async {
    useViewport(tester);
    final prompts = const [
      SentPrompt(clientId: 'c1', text: '问题', ts: 1, status: 'sent'),
    ];
    Widget shimmerFrame({required bool showShimmer, String? textDelta}) {
      final events = eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'state', 'state': 'running'},
        if (textDelta != null) {'type': 'text_delta', 'text': textDelta},
      ]);
      return MaterialApp(
        theme: AimiTheme.light(),
        home: Scaffold(
          body: TimelineView(
            view: conversationOf(events, prompts),
            agentLabel: 'Claude Code',
            showShimmer: showShimmer,
          ),
        ),
      );
    }

    await tester.pumpWidget(shimmerFrame(showShimmer: true));
    expect(find.byType(ShimmerLine), findsOneWidget);
    // 首 token 到达：showShimmer 翻 false——先淡出交棒而非直接消失。
    await tester.pumpWidget(shimmerFrame(showShimmer: false, textDelta: '回复'));
    await tester.pump(const Duration(milliseconds: 90));
    expect(find.byType(ShimmerLine), findsOneWidget);
    // 交棒透明度挂在起势行的祖先链上（退出包装），90ms 时应在淡出行程中。
    final ancestors = tester
        .widgetList<Opacity>(
          find.ancestor(
            of: find.byType(ShimmerLine),
            matching: find.byType(Opacity),
          ),
        )
        .toList();
    expect(ancestors.any((o) => o.opacity < 1.0), isTrue);
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.byType(ShimmerLine), findsNothing);
  });

  testWidgets('没有用户消息和可见输出的结束回合不显示孤立 agent 标签', (tester) async {
    useViewport(tester);
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'state', 'state': 'running'},
        {'type': 'text_delta', 'text': '第一轮回复'},
        {'type': 'state', 'state': 'finished'},
        {'type': 'state', 'state': 'starting'},
        {'type': 'state', 'state': 'finished'},
      ]),
      const [SentPrompt(clientId: 'c1', text: '第一轮问题', ts: 1, status: 'sent')],
    );
    await pumpTimeline(tester, view);
    expect(find.text('Claude Code'), findsOneWidget);
    expect(find.text('第一轮问题'), findsOneWidget);
    expect(find.text('第一轮回复'), findsOneWidget);
  });

  testWidgets('待批卡：激活时可点开 sheet 入口，失效后禁用并灰化留痕', (tester) async {
    useViewport(tester);
    final events = eventsOf([
      {'type': 'state', 'state': 'starting'},
      {
        'type': 'permission',
        'id': 'req-1',
        'title': 'Bash · pnpm build',
        'detail': 'pnpm build',
        'options': const [
          {'label': '允许一次', 'kind': 'once'},
          {'label': '总是允许', 'kind': 'always'},
          {'label': '拒绝', 'kind': 'reject'},
        ],
      },
    ]);

    PermissionTimelineItem? opened;
    await pumpTimeline(
      tester,
      conversationOf(events, const []),
      pendingRequestId: 'req-1',
      onOpenApproval: (item) => opened = item,
    );
    expect(find.text('待批'), findsOneWidget);
    await tester.tap(find.text('Bash · pnpm build'));
    expect(opened?.id, 'req-1');

    // 没有 pendingRequestId → 同一张卡渲染为失效留痕，点击无动作。
    opened = null;
    await pumpTimeline(
      tester,
      conversationOf(events, const []),
      onOpenApproval: (item) => opened = item,
    );
    expect(find.text('审批已失效'), findsOneWidget);
    await tester.tap(find.text('Bash · pnpm build'));
    expect(opened, isNull);
  });

  testWidgets('失败回合：错误原因以红色文本显示在回复位置，无终态行/续接', (tester) async {
    useViewport(tester);
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': '403 当前令牌无权访问所选分组', 'error': true},
        {'type': 'state', 'state': 'failed'},
        {'type': 'exit', 'exitCode': 1, 'durationMs': 31226},
      ]),
      const [SentPrompt(clientId: 'c1', text: '问题', ts: 1, status: 'sent')],
    );
    await pumpTimeline(tester, view);
    // 错误原因在回复位置可见，且是红色。
    expect(find.textContaining('403 当前令牌无权访问所选分组'), findsOneWidget);
    final errorStyle = tester
        .widget<EditableText>(find.textContaining('403 当前令牌无权访问所选分组'))
        .style;
    final theme = Theme.of(tester.element(find.byType(TimelineView)));
    expect(errorStyle.color, theme.colorScheme.error);
    // 终态行整体移除：既无「续接」，也无回复失败/进程已退出/已停止/已完成字样。
    expect(find.text('续接'), findsNothing);
    for (final label in const ['回复失败', '进程已退出', '已停止', '已完成']) {
      expect(find.textContaining(label), findsNothing, reason: '终态行已移除：$label');
    }
  });

  testWidgets('长文本在窄视口下换行不溢出（无异常）', (tester) async {
    useViewport(tester, size: const Size(320, 640));
    final long = '很长的中文正文' * 40;
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': long},
      ]),
      [SentPrompt(clientId: 'c1', text: long, ts: 1, status: 'sent')],
    );
    await pumpTimeline(tester, view);
    expect(tester.takeException(), isNull);
  });
}
