import 'package:aimi/app/theme.dart';
import 'package:aimi/ui/widgets/aimi_primitives.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // 顶部提示挂在 rootOverlay：宿主必须自带 MaterialApp 的 Overlay。
  Future<void> pumpHost(
    WidgetTester tester,
    ThemeData theme,
  ) =>
      tester.pumpWidget(
        MaterialApp(
          theme: theme,
          home: Scaffold(body: const SizedBox.expand()),
        ),
      );

  testWidgets('顶部提示：文案可见、2s 后自动摘除（退场动画走完）', (tester) async {
    await pumpHost(tester, AimiTheme.light());
    showAimiTopToast(tester.element(find.byType(Scaffold)), '当前已是最新版本');
    await tester.pumpAndSettle();
    expect(find.text('当前已是最新版本'), findsOneWidget);

    // 停留 2000ms + 退场 180ms。
    await tester.pump(const Duration(milliseconds: 2100));
    await tester.pumpAndSettle();
    expect(find.text('当前已是最新版本'), findsNothing);
  });

  testWidgets('重复弹出：后一条顶掉前一条，不叠影', (tester) async {
    await pumpHost(tester, AimiTheme.light());
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

  // 复现 feedback #20261025-234028-2465ab 暴露的缺陷：
  // 修复前暗色主题下前景取 ai.ink，与背景（同为 ai.ink）同色，文字不可见。
  testWidgets('暗色主题：文字颜色与背景形成对比，非同色', (tester) async {
    await pumpHost(tester, AimiTheme.dark());
    showAimiTopToast(tester.element(find.byType(Scaffold)), '对比度检查');
    await tester.pumpAndSettle();

    final text = tester.widget<Text>(find.text('对比度检查'));
    final container = tester.widget<Container>(
      find.ancestor(
        of: find.text('对比度检查'),
        matching: find.byType(Container),
      ).first,
    );
    final background = (container.decoration as BoxDecoration).color!;

    expect(text.style?.color, isNotNull);
    expect(text.style!.color!.toARGB32(), isNot(equals(background.toARGB32())));
    expect(text.style!.color, same(AimiColors.dark.canvas));
  });
}
