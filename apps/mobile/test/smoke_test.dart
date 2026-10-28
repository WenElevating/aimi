import 'package:aimi/main.dart';
import 'package:aimi/ui/opening/opening_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('应用启动渲染看板骨架', (tester) async {
    // 显式给正常动画环境：测试宿主缺省把 disableAnimations 视为 true，
    // 会让开屏走定格路径并留下未冲掉的停留定时器（收尾 pending 断言拦截）。
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(disableAnimations: false),
        child: const ProviderScope(child: AimiApp()),
      ),
    );
    // 冷启动先播开屏（品牌入场，只此一次）；任意点击跳过直达看板。
    expect(find.text('aimi'), findsWidgets);
    await tester.tap(find.byType(OpeningScreen));
    await tester.pump();
    // 看板标题按 design.md §2.5 取栏目名「会话」，不再复述应用名 aimi。
    expect(find.text('会话'), findsOneWidget);
  });
}
