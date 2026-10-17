import 'package:aimi/main.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('应用启动渲染看板骨架', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: AimiApp()));
    expect(find.text('aimi'), findsOneWidget);
  });
}
