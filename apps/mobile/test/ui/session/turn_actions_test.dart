import 'dart:ui' show Tristate;

import 'package:aimi/app/theme.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/domain/session_view.dart';
import 'package:aimi/ui/session/turn_actions.dart';
import 'package:aimi/ui/widgets/timeline_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// 把 JSON 事件解析成领域 DTO（走真实契约解析路径）。
List<AgentEventDto> eventsOf(List<Map<String, dynamic>> json) =>
    json.map(AgentEventDto.fromJson).toList();

/// 固定逻辑视口，防止不同测试机尺寸影响溢出断言。
void useViewport(WidgetTester tester, {Size size = const Size(390, 844)}) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

/// 剪贴板内存桩：复制断言走这里，不触真实系统剪贴板。
///
/// why 必须打桩：widget 测试默认没有 Clipboard 的 platform channel 实现，
/// `Clipboard.getData` 的 Future 永不完成，用例挂到 10 分钟超时。
class _InMemoryClipboard {
  static String? text;

  /// 安装 mock 通道；测试结束自动卸载。
  static void install() {
    TestWidgetsFlutterBinding.ensureInitialized();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      SystemChannels.platform,
      (message) async {
        if (message.method == 'Clipboard.setData') {
          final data = message.arguments as Map<Object?, Object?>;
          text = data['text'] as String?;
          return null;
        }
        if (message.method == 'Clipboard.getData') {
          return text == null ? null : <String, dynamic>{'text': text};
        }
        return null;
      },
    );
  }
}

/// 用真主题泵出时间线（settled 控制最后回合是否收盘）。
Future<void> pumpTimeline(
  WidgetTester tester,
  ConversationView view, {
  bool settled = true,
  bool showShimmer = false,
  VoidCallback? onTurnFeedback,
}) => tester.pumpWidget(
  MaterialApp(
    theme: AimiTheme.light(),
    home: Scaffold(
      body: SingleChildScrollView(
        child: TimelineView(
          view: view,
          agentLabel: 'Claude Code',
          settled: settled,
          showShimmer: showShimmer,
          onTurnFeedback: onTurnFeedback,
        ),
      ),
    ),
  ),
);

void main() {
  testWidgets('收盘回合末尾出现动作行：复制/有帮助/没帮助 三键', (tester) async {
    useViewport(tester);
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': '第一轮回答'},
        {'type': 'state', 'state': 'finished'},
      ]),
      const [SentPrompt(clientId: 'c1', text: '问题', ts: 1, status: 'sent')],
    );
    await pumpTimeline(tester, view);

    expect(find.byType(TurnActionsRow), findsOneWidget);
    expect(find.bySemanticsLabel('复制这段回答'), findsOneWidget);
    expect(find.bySemanticsLabel('有帮助'), findsOneWidget);
    expect(find.bySemanticsLabel('没帮助，反馈问题'), findsOneWidget);
    // 分叉不在本次范围（服务端无此能力）。
    expect(find.bySemanticsLabel('从这段回答分叉'), findsNothing);
  });

  testWidgets('流式中的最后回合不出现动作行，历史回合照常', (tester) async {
    useViewport(tester);
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': '第一轮回答'},
        {'type': 'state', 'state': 'finished'},
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': '第二轮进行中'},
        {'type': 'state', 'state': 'running'},
      ]),
      const [SentPrompt(clientId: 'c1', text: '问题', ts: 1, status: 'sent')],
    );
    // 未收盘：只有历史回合（第一轮）有动作行。
    await pumpTimeline(tester, view, settled: false);
    expect(find.byType(TurnActionsRow), findsOneWidget);

    // 收盘后：两个回合各一行。
    await pumpTimeline(tester, view, settled: true);
    expect(find.byType(TurnActionsRow), findsNWidgets(2));
  });

  testWidgets('复制动作：把整轮文字写入剪贴板并提示已复制', (tester) async {
    useViewport(tester);
    _InMemoryClipboard.install();
    addTearDown(() => _InMemoryClipboard.text = null);
    // 两段文本之间插一次工具调用：相邻 text_delta 会被合并成一条，
    // 用工具卡隔开才能验证"多段文本拼接"的复制口径。
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': '前半段。'},
        {
          'type': 'tool_call',
          'id': 't1',
          'name': 'Read',
          'summary': 'a.ts',
          'inputDigest': 'd1',
        },
        {'type': 'text_delta', 'text': '后半段。'},
        {'type': 'state', 'state': 'finished'},
      ]),
      const [SentPrompt(clientId: 'c1', text: '问题', ts: 1, status: 'sent')],
    );
    await pumpTimeline(tester, view);

    await tester.tap(find.bySemanticsLabel('复制这段回答'));
    await tester.pump();
    expect(_InMemoryClipboard.text, '前半段。\n\n后半段。');
    // copyToClipboard 的 SnackBar 在 setData 完成后的微任务里挂上，需再 pump。
    await tester.pump();
    expect(find.text('已复制'), findsOneWidget);
  });

  testWidgets('赞踩互斥：按下后留在原地，切换时另一边自动抬起', (tester) async {
    useViewport(tester);
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': '回答'},
        {'type': 'state', 'state': 'finished'},
      ]),
      const [],
    );
    await pumpTimeline(tester, view);

    // 选中态走 Semantics(selected)；经 semantics 树断言 flags。
    // Tristate 来自 dart:ui（material.dart 已导出）。
    bool upSelected() =>
        tester
            .getSemantics(find.bySemanticsLabel('有帮助'))
            .flagsCollection
            .isSelected ==
        Tristate.isTrue;
    bool downSelected() =>
        tester
            .getSemantics(find.bySemanticsLabel('没帮助，反馈问题'))
            .flagsCollection
            .isSelected ==
        Tristate.isTrue;

    await tester.tap(find.bySemanticsLabel('有帮助'));
    await tester.pump();
    expect(upSelected(), isTrue);
    expect(downSelected(), isFalse);

    // 互斥：改踩后赞自动抬起；两键都还在（不消失）。
    await tester.tap(find.bySemanticsLabel('没帮助，反馈问题'));
    await tester.pump();
    expect(upSelected(), isFalse);
    expect(downSelected(), isTrue);
    expect(find.bySemanticsLabel('有帮助'), findsOneWidget);

    // 再点一次踩 = 取消评价。
    await tester.tap(find.bySemanticsLabel('没帮助，反馈问题'));
    await tester.pump();
    expect(downSelected(), isFalse);
  });

  testWidgets('点踩触发反馈回调；复制与赞不触发', (tester) async {
    useViewport(tester);
    var feedbackCalls = 0;
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': '回答'},
        {'type': 'state', 'state': 'finished'},
      ]),
      const [],
    );
    await pumpTimeline(tester, view, onTurnFeedback: () => feedbackCalls++);

    await tester.tap(find.bySemanticsLabel('复制这段回答'));
    await tester.pump();
    expect(feedbackCalls, 0);
    await tester.tap(find.bySemanticsLabel('有帮助'));
    await tester.pump();
    expect(feedbackCalls, 0);
    await tester.tap(find.bySemanticsLabel('没帮助，反馈问题'));
    await tester.pump();
    expect(feedbackCalls, 1);
  });

  testWidgets('错误回合也有动作行：复制内容含报错文本', (tester) async {
    useViewport(tester);
    _InMemoryClipboard.install();
    addTearDown(() => _InMemoryClipboard.text = null);
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': '403 令牌无权访问所选分组', 'error': true},
        {'type': 'state', 'state': 'failed'},
      ]),
      const [SentPrompt(clientId: 'c1', text: '问题', ts: 1, status: 'sent')],
    );
    await pumpTimeline(tester, view);
    expect(find.byType(TurnActionsRow), findsOneWidget);

    await tester.tap(find.bySemanticsLabel('复制这段回答'));
    await tester.pump();
    expect(_InMemoryClipboard.text, contains('403 令牌无权访问所选分组'));
  });

  testWidgets('无文字的回合（纯审批/纯状态）不出现动作行', (tester) async {
    useViewport(tester);
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'state', 'state': 'finished'},
      ]),
      const [],
    );
    await pumpTimeline(tester, view);
    expect(find.byType(TurnActionsRow), findsNothing);
  });
}
