import 'package:aimi/main.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('应用启动渲染看板骨架', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: AimiApp()));
    // 看板标题按 design.md §2.5 取栏目名「会话」，不再复述应用名 aimi。
    expect(find.text('会话'), findsOneWidget);
  });
}
