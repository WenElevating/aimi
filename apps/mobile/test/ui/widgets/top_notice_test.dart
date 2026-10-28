import 'package:aimi/app/theme.dart';
import 'package:aimi/ui/widgets/aimi_primitives.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 可停留顶部通知（AimiTopNotice，feedback #20261025-234028-2465ab）：
/// 不自动消失、可关闭、整条可点、同一时刻仅一条（与 toast 同槽互斥）。
void main() {
  // 顶部通知挂在 rootOverlay：宿主必须自带 MaterialApp 的 Overlay。
  Future<void> pumpHost(WidgetTester tester, ThemeData theme) =>
      tester.pumpWidget(
        MaterialApp(
          theme: theme,
          home: Scaffold(body: const SizedBox.expand()),
        ),
      );

  testWidgets('通知可停留：不自动消失，点关闭按钮才移除', (tester) async {
    await pumpHost(tester, AimiTheme.light());
    showAimiTopNotice(tester.element(find.byType(Scaffold)), message: '发现新版本 1.4.0');
    await tester.pumpAndSettle();
    expect(find.text('发现新版本 1.4.0'), findsOneWidget);

    // 远超 toast 的 2s 生命周期：通知仍在。
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    expect(find.text('发现新版本 1.4.0'), findsOneWidget);

    await tester.tap(find.byTooltip('关闭通知'));
    await tester.pumpAndSettle();
    expect(find.text('发现新版本 1.4.0'), findsNothing);
  });

  testWidgets('整条可点：触发回调并收起', (tester) async {
    await pumpHost(tester, AimiTheme.light());
    var tapped = false;
    showAimiTopNotice(
      tester.element(find.byType(Scaffold)),
      message: '发现新版本',
      onTap: () => tapped = true,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('发现新版本'));
    await tester.pumpAndSettle();

    expect(tapped, isTrue);
    expect(find.text('发现新版本'), findsNothing);
  });

  testWidgets('单实例互斥：新通知顶掉旧通知；后弹的 toast 也顶掉通知', (tester) async {
    await pumpHost(tester, AimiTheme.light());
    final context = tester.element(find.byType(Scaffold));
    showAimiTopNotice(context, message: '第一条通知');
    await tester.pumpAndSettle();
    showAimiTopNotice(context, message: '第二条通知');
    await tester.pumpAndSettle();
    expect(find.text('第一条通知'), findsNothing);
    expect(find.text('第二条通知'), findsOneWidget);

    showAimiTopToast(context, '轻提示');
    await tester.pumpAndSettle();
    expect(find.text('第二条通知'), findsNothing);
    expect(find.text('轻提示'), findsOneWidget);
  });

  // 与 toast 的暗色对比同源（feedback #20261025-234028-2465ab）：
  // 通知配色走主题 token，暗色下文字不得与背景同色。
  testWidgets('暗色主题：文字颜色与背景形成对比，非同色', (tester) async {
    await pumpHost(tester, AimiTheme.dark());
    showAimiTopNotice(tester.element(find.byType(Scaffold)), message: '对比度检查');
    await tester.pumpAndSettle();

    final text = tester.widget<Text>(find.text('对比度检查'));
    final container = tester.widget<Container>(
      find
          .ancestor(
            of: find.text('对比度检查'),
            matching: find.byWidgetPredicate(
              (widget) =>
                  widget is Container &&
                  widget.decoration is BoxDecoration &&
                  (widget.decoration as BoxDecoration?)?.color != null,
            ),
          )
          .first,
    );
    final background = (container.decoration as BoxDecoration).color!;

    expect(text.style?.color, isNotNull);
    expect(text.style!.color!.toARGB32(), isNot(equals(background.toARGB32())));
  });
}
