import 'package:aimi/ui/widgets/aimi_primitives.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// AimiPressable 触摸反馈契约：
/// - 按下 → 缩放 + pressedColor 底色；松开复位并触发 onTap；
/// - 按住滑出行边界 → 高亮淡出；滑回 → 高亮重现（「移入移出」反馈）；
/// - 滑出边界后松手 → 不触发 onTap（tap 语义归 GestureDetector）；
/// - 鼠标悬停 → 与按压同一视觉态；
/// - onTap 为 null（禁用）→ 无视觉反馈也不响应。
void main() {
  /// 按压底色（测试自定色，与 surface3 语义同用的 opaque tint）。
  const pressed = Color(0xFFE9E9EE);
  /// 按压覆盖水洗（画在内容之上，测试自定色）。
  const overlay = Color(0x0F000000);

  /// 泵一个固定 200×60 的可按压块；[taps] 记录 onTap 次数。
  /// [enabled] 为 false 时传 onTap: null（显式区分「未传」与「禁用」）。
  Future<({List<String> taps})> pumpPressable(
    WidgetTester tester, {
    bool enabled = true,
  }) async {
    final taps = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 200,
              height: 60,
              child: AimiPressable(
                onTap: enabled ? () => taps.add('tap') : null,
                pressedColor: pressed,
                overlayColor: overlay,
                child: const SizedBox.expand(),
              ),
            ),
          ),
        ),
      ),
    );
    return (taps: taps);
  }

  AnimatedContainer containerOf(WidgetTester tester) =>
      tester.widget<AnimatedContainer>(find.byType(AnimatedContainer));

  AnimatedScale scaleOf(WidgetTester tester) =>
      tester.widget<AnimatedScale>(find.byType(AnimatedScale));

  Color? pressedColorOf(WidgetTester tester) =>
      (containerOf(tester).decoration! as BoxDecoration).color;

  testWidgets('按下：缩放 + 底色生效；松开复位并触发 onTap', (tester) async {
    final h = await pumpPressable(tester);
    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(AimiPressable)),
    );
    await tester.pump();

    expect(scaleOf(tester).scale, lessThan(1.0));
    expect(pressedColorOf(tester), pressed);

    await gesture.up();
    await tester.pump();
    expect(pressedColorOf(tester), isNull);
    expect(h.taps, ['tap']);
  });

  testWidgets('移入移出：按住滑出边界高亮淡出，滑回边界内高亮重现', (tester) async {
    await pumpPressable(tester);
    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(AimiPressable)),
    );
    await tester.pump();
    expect(pressedColorOf(tester), pressed);

    // 滑出 200 宽组件右边界（测试面 800 宽，+400 必然出界）。
    await gesture.moveBy(const Offset(400, 0));
    await tester.pump();
    expect(pressedColorOf(tester), isNull);

    // 滑回中心：高亮重现——这是本次修复的核心（此前滑回无任何反馈）。
    await gesture.moveBy(const Offset(-400, 0));
    await tester.pump();
    expect(pressedColorOf(tester), pressed);

    await gesture.up();
    await tester.pump();
  });

  testWidgets('滑出边界后松手：不触发 onTap（tap 语义不因视觉复位而误触）', (tester) async {
    final h = await pumpPressable(tester);
    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(AimiPressable)),
    );
    await tester.pump();
    await gesture.moveBy(const Offset(400, 0));
    await tester.pump();
    await gesture.up();
    await tester.pump();

    expect(pressedColorOf(tester), isNull);
    expect(h.taps, isEmpty);
  });

  testWidgets('鼠标悬停：移入与按压同视觉态，移出复位', (tester) async {
    await pumpPressable(tester);
    final mouse = await tester.createGesture(
      kind: PointerDeviceKind.mouse,
      pointer: 8,
    );
    // 从组件外进入（测试面左上角远处）。
    await mouse.addPointer(location: const Offset(10, 10));
    await tester.pump();
    expect(pressedColorOf(tester), isNull);

    await mouse.moveTo(tester.getCenter(find.byType(AimiPressable)));
    await tester.pump();
    expect(pressedColorOf(tester), pressed);
    expect(scaleOf(tester).scale, lessThan(1.0));

    await mouse.moveTo(const Offset(10, 10));
    await tester.pump();
    expect(pressedColorOf(tester), isNull);
  });

  testWidgets('onTap 为 null（禁用）：按下无反馈、不响应', (tester) async {
    final h = await pumpPressable(tester, enabled: false);
    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(AimiPressable)),
    );
    await tester.pump();

    expect(scaleOf(tester).scale, 1.0);
    expect(pressedColorOf(tester), isNull);

    await gesture.up();
    await tester.pump();
    expect(h.taps, isEmpty);
  });
}
