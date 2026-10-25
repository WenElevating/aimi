import 'package:aimi/app/theme.dart';
import 'package:aimi/ui/widgets/aimi_primitives.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // 顶部提示挂在 rootOverlay：宿主必须自带 MaterialApp 的 Overlay。
  Future<void> pumpHost(WidgetTester tester) => tester.pumpWidget(
        MaterialApp(
          theme: AimiTheme.light(),
          home: Scaffold(body: const SizedBox.expand()),
        ),
      );

  testWidgets('顶部提示：文案可见、2s 后自动摘除（退场动画走完）', (tester) async {
    await pumpHost(tester);
    showAimiTopToast(tester.element(find.byType(Scaffold)), '当前已是最新版本');
    await tester.pumpAndSettle();
    expect(find.text('当前已是最新版本'), findsOneWidget);

    // 停留 2000ms + 退场 180ms。
    await tester.pump(const Duration(milliseconds: 2100));
    await tester.pumpAndSettle();
    expect(find.text('当前已是最新版本'), findsNothing);
  });

  testWidgets('重复弹出：后一条顶掉前一条，不叠影', (tester) async {
    await pumpHost(tester);
    final context = tester.element(find.byType(Scaffold));
    showAimiTopToast(context, '第一条');
    await tester.pumpAndSettle();
    showAimiTopToast(context, '第二条');
    await tester.pumpAndSettle();

    expect(find.text('第一条'), findsNothing);
    expect(find.text('第二条'), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 2100));
    await tester.pumpAndSettle();
    expect(find.text('第二条'), findsNothing);
  });
}
