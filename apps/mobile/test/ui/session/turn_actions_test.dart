import 'package:aimi/app/theme.dart';
import 'package:aimi/ui/session/turn_actions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  /// 动作行宿主：主题 + Scaffold（copyToClipboard 需要 ScaffoldMessenger）。
  Future<void> pumpRow(WidgetTester tester, TurnActionsRow row) =>
      tester.pumpWidget(
        MaterialApp(
          theme: AimiTheme.light(),
          home: Scaffold(body: ListView(children: [row])),
        ),
      );

  testWidgets('四个动作齐备：点「分叉」触发回调（能力声明时）', (tester) async {
    var forked = false;
    await pumpRow(
      tester,
      TurnActionsRow(
        turnText: '回合文本',
        onFeedback: () {},
        onFork: () => forked = true,
      ),
    );
    // 动作按钮以 Semantics 暴露名称（无障碍口径），经语义树查找。
    final handle = tester.ensureSemantics();
    await tester.tap(find.bySemanticsLabel('从这段回答分叉'));
    expect(forked, isTrue);
    handle.dispose();
  });

  testWidgets('能力未声明：分叉置灰不响应，名称注明不支持', (tester) async {
    var forked = false;
    await pumpRow(
      tester,
      TurnActionsRow(turnText: '回合文本', onFeedback: () {}, onFork: null),
    );
    final handle = tester.ensureSemantics();
    expect(find.bySemanticsLabel('分叉（电脑端不支持）'), findsOneWidget);
    await tester.tap(
      find.bySemanticsLabel('分叉（电脑端不支持）'),
      warnIfMissed: false,
    );
    expect(forked, isFalse);
    handle.dispose();
  });
}
