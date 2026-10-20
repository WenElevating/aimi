import 'package:aimi/app/theme.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/domain/session_view.dart';
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
  VoidCallback? onResume,
}) =>
    tester.pumpWidget(
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
              onResume: onResume,
            ),
          ),
        ),
      ),
    );

void main() {
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

  testWidgets('失败回合显示「进程已退出」与「续接」动作', (tester) async {
    useViewport(tester);
    var resumed = false;
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'notice', 'severity': 'error', 'text': '适配器协议未确认'},
        {'type': 'state', 'state': 'failed'},
        {'type': 'exit', 'exitCode': 1, 'durationMs': 31226},
      ]),
      const [SentPrompt(clientId: 'c1', text: '问题', ts: 1, status: 'sent')],
    );
    await pumpTimeline(tester, view, onResume: () => resumed = true);
    expect(find.textContaining('进程已退出'), findsOneWidget);
    await tester.tap(find.text('续接'));
    expect(resumed, isTrue);
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
