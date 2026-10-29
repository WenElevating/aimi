import 'package:aimi/ui/opening/opening_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('正常播放：字标可见，约 3.55s 后交棒', (tester) async {
    var done = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Stack(
          children: [
            const ColoredBox(color: Colors.white),
            OpeningScreen(onDone: () => done = true),
          ],
        ),
      ),
    );
    expect(find.byType(OpeningScreen), findsOneWidget); // 字标经 CustomPainter 绘制

    await tester.pump(const Duration(milliseconds: 3600));
    expect(done, isTrue);
  });

  testWidgets('点击任意处立即跳过', (tester) async {
    var done = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Stack(
          children: [
            const ColoredBox(color: Colors.white),
            OpeningScreen(onDone: () => done = true),
          ],
        ),
      ),
    );
    await tester.tap(find.byType(OpeningScreen));
    expect(done, isTrue);
  });

  testWidgets('reduced-motion：定格帧短暂停留后交棒', (tester) async {
    var done = false;
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: MaterialApp(
          home: Stack(
            children: [
              const ColoredBox(color: Colors.white),
              OpeningScreen(onDone: () => done = true),
            ],
          ),
        ),
      ),
    );
    expect(find.byType(OpeningScreen), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 700));
    expect(done, isTrue);
  });
}
