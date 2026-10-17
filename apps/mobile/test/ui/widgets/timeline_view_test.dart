import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/domain/session_view.dart';
import 'package:aimi/ui/widgets/timeline_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 30 条混合事件：3 条相邻 `text_delta`（合并为 1 项）+ 一对 tool_call/tool_result（折叠为 1 行）
/// + 1 条 notice + 1 条 state + 23 条交替 text_delta/state（各自成项，不被合并）。
///
/// 断言链固定为：30 事件 → 28 项（`timelineOf`）→ 27 行（`foldTimelineRows`）。
List<AgentEventDto> mixedEvents() {
  final events = <AgentEventDto>[
    AgentEventDto.fromJson({'type': 'state', 'state': 'running'}),
    AgentEventDto.fromJson({'type': 'text_delta', 'text': '开始'}),
    AgentEventDto.fromJson({'type': 'text_delta', 'text': '处理'}),
    AgentEventDto.fromJson({'type': 'text_delta', 'text': '任务'}),
    AgentEventDto.fromJson({
      'type': 'tool_call',
      'id': 't1',
      'name': 'Bash',
      'summary': 'ls -la',
      'inputDigest': 'd1',
    }),
    AgentEventDto.fromJson({
      'type': 'tool_result',
      'id': 't1',
      'ok': true,
      'outputExcerpt': 'a.txt\nb.txt',
      'exitCode': 0,
    }),
    AgentEventDto.fromJson({
      'type': 'notice',
      'severity': 'warn',
      'text': '注意上下文',
    }),
  ];
  for (var i = 7; i < 30; i++) {
    events.add(
      AgentEventDto.fromJson(
        i.isEven
            ? {'type': 'state', 'state': 'running'}
            : {'type': 'text_delta', 'text': '片段 $i'},
      ),
    );
  }
  return events;
}

/// 把视口固定为逻辑像素 [width]×[height]（physicalSize ÷ devicePixelRatio），
/// 使「可见行数」在测试里可复现。
void useViewport(WidgetTester tester, double width, double height) {
  tester.view.physicalSize = Size(width, height);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

Future<void> pumpTimeline(WidgetTester tester, List<TimelineItem> items) async {
  await tester.pumpWidget(
    MaterialApp(home: Scaffold(body: TimelineView(items: items))),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('TimelineView：30 条混合事件 → 28 项 → 27 行，视口够高时逐行渲染', (tester) async {
    useViewport(tester, 1080, 4000);

    final events = mixedEvents();
    expect(events, hasLength(30));
    final items = timelineOf(events);
    expect(items, hasLength(28));
    expect(foldTimelineRows(items), hasLength(27));

    await pumpTimeline(tester, items);

    expect(find.byType(TimelineRow), findsNWidgets(27));
    expect(tester.takeException(), isNull);
  });

  testWidgets('TimelineView：小视口只构建可见行（ListView.builder 虚拟化，洪水不整屏重建）',
      (tester) async {
    useViewport(tester, 400, 200);
    final items = timelineOf(mixedEvents());

    await pumpTimeline(tester, items);

    final built = tester.widgetList(find.byType(TimelineRow)).length;
    expect(built, greaterThan(0));
    expect(built, lessThan(foldTimelineRows(items).length));
  });

  testWidgets('工具卡：相邻同 id 的 tool_call/tool_result 折叠为一张 ExpansionTile，'
      '展开后输出为等宽字体', (tester) async {
    useViewport(tester, 1080, 2000);
    final items = timelineOf([
      AgentEventDto.fromJson({
        'type': 'tool_call',
        'id': 't1',
        'name': 'Bash',
        'summary': 'ls -la',
        'inputDigest': 'd1',
      }),
      AgentEventDto.fromJson({
        'type': 'tool_result',
        'id': 't1',
        'ok': true,
        'outputExcerpt': 'a.txt\nb.txt',
        'exitCode': 0,
      }),
    ]);
    expect(foldTimelineRows(items), hasLength(1));

    await pumpTimeline(tester, items);

    final tile = find.byType(ExpansionTile);
    expect(tile, findsOneWidget);
    expect(find.textContaining('Bash'), findsOneWidget);
    expect(find.textContaining('ls -la'), findsOneWidget);
    // 折叠态不展示输出摘录。
    expect(find.textContaining('a.txt'), findsNothing);

    await tester.tap(tile);
    await tester.pumpAndSettle();

    final output = tester.widget<Text>(find.textContaining('a.txt'));
    expect(output.style?.fontFamily, 'monospace');
    expect(tester.takeException(), isNull);
  });

  testWidgets('长文本：超长正文/摘要/输出/提示在窄视口下换行不溢出（无异常）', (tester) async {
    useViewport(tester, 320, 640);
    final items = <TimelineItem>[
      TextTimelineItem('很长的中文段落' * 40),
      ToolCallTimelineItem(
        id: 't9',
        name: 'Bash',
        summary: '超长入参摘要 ' * 30,
        inputDigest: 'd9',
      ),
      ToolResultTimelineItem(
        id: 't9',
        ok: false,
        outputExcerpt: 'ERROR: 构建失败 ' * 60,
        exitCode: 1,
      ),
      NoticeTimelineItem(severity: 'error', text: '失败提示 ' * 40),
    ];

    await pumpTimeline(tester, items);

    expect(find.byType(TimelineRow), findsNWidgets(3));
    expect(find.textContaining('很长的中文段落'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
