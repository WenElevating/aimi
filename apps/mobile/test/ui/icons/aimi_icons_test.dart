import 'package:aimi/ui/icons/aimi_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 图标集 smoke：全部字形可渲染（SVG path 解析不抛错、给定尺寸下有像素输出）。
void main() {
  final all = <String, AimiIconData>{
    'arrowUp': AimiIcons.arrowUp,
    'plus': AimiIcons.plus,
    'chevronDown': AimiIcons.chevronDown,
    'chevron': AimiIcons.chevron,
    'doc': AimiIcons.doc,
    'search': AimiIcons.search,
    'pen': AimiIcons.pen,
    'terminal': AimiIcons.terminal,
    'more': AimiIcons.more,
    'back': AimiIcons.back,
    'pause': AimiIcons.pause,
    'clock': AimiIcons.clock,
    'trash': AimiIcons.trash,
    'spark': AimiIcons.spark,
    'lock': AimiIcons.lock,
    'key': AimiIcons.key,
    'check': AimiIcons.check,
    'close': AimiIcons.close,
    'copy': AimiIcons.copy,
    'scan': AimiIcons.scan,
    'slash': AimiIcons.slash,
    'gear': AimiIcons.gear,
    'folder': AimiIcons.folder,
    'linkOff': AimiIcons.linkOff,
  };

  testWidgets('每枚图标在明暗两主题下都能渲染且不越界', (tester) async {
    tester.view.physicalSize = const Size(240, 480);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    for (final entry in all.entries) {
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData.light(),
          home: Row(
            children: [
              for (final size in const [13.0, 15.0, 17.0])
                AimiIcon(data: entry.value, size: size),
            ],
          ),
        ),
      );
      expect(tester.takeException(), isNull, reason: '${entry.key} 渲染异常');
      expect(find.byType(AimiIcon), findsNWidgets(3), reason: entry.key);
    }
  });

  test('more 图标用实心点而非 stroke（三枚 fills）', () {
    expect(AimiIcons.more.fills.length, 3);
    expect(AimiIcons.more.paths, isEmpty);
  });

  test('lock 图标锁体为实心点 + 外框 stroke', () {
    expect(AimiIcons.lock.fills.length, 1);
    expect(AimiIcons.lock.paths.length, 2);
  });
}
