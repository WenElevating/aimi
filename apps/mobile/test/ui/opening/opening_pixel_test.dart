import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:aimi/ui/opening/opening_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

/// 开屏字标区域的像素级验收（feedback #8d81bf①）：
/// 1.3.6 的 ShaderMask 光带在真机（三星）与模拟器上均在字标下缘渲染出一条
/// 与字标等宽的实心黄条（R/G 高、B 低的杂色）。本测试在多个光带进度下
/// 采样整屏像素，断言除白/灰（R≈G≈B）与开屏底色外不得出现任何杂色。
void main() {
  /// 扫描 RGBA 字节：允许 开屏底色（近黑）与 白/灰系（R≈G≈B）；其余一律算杂色。
  List<String> strayColors(Uint8List bytes, int width, int height) {
    final stray = <String>{};
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        final i = (y * width + x) * 4;
        final r = bytes[i], g = bytes[i + 1], b = bytes[i + 2];
        final isDark = r < 40 && g < 40 && b < 60; // 开屏底色（冷黑）
        final maxChannel = [r, g, b].reduce((a, b2) => a > b2 ? a : b2);
        final minChannel = [r, g, b].reduce((a, b2) => a < b2 ? a : b2);
        final isNeutral = maxChannel - minChannel <= 24; // 白/灰系（字标、光带）
        if (!isDark && !isNeutral) stray.add('($x,$y)=#$r$g$b');
      }
    }
    return stray.toList();
  }

  testWidgets('光带各进度下字标区域无杂色（黄条回归防线）', (tester) async {
    addTearDown(tester.view.resetPhysicalSize);
    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1;
    // 覆盖光带行程的代表性采样点：起势、早段、中段、尾段、揭示完成。
    for (final pumpMs in [200, 600, 1200, 2000, 2800]) {
      await tester.pumpWidget(
        MaterialApp(
          home: Stack(
            children: [
              const ColoredBox(color: Colors.white),
              RepaintBoundary(
                key: const ValueKey('opening-capture'),
                child: const OpeningScreen(onDone: _noop),
              ),
            ],
          ),
        ),
      );
      await tester.pump(Duration(milliseconds: pumpMs));
      final boundary = tester.renderObject<RenderRepaintBoundary>(
        find.byKey(const ValueKey('opening-capture')),
      );
      // 像素回读走真实异步通道（runAsync）：测试绑定的假时钟里 toImage 会永久挂起。
      final image = (await tester.runAsync<ui.Image>(
        () => boundary.toImage(pixelRatio: 1),
      ))!;
      final byteData = await tester.runAsync<ByteData?>(
        () => image.toByteData(format: ui.ImageByteFormat.rawRgba),
      );
      final stray = strayColors(
        byteData!.buffer.asUint8List(),
        image.width,
        image.height,
      );
      expect(
        stray,
        isEmpty,
        reason: 'pump=${pumpMs}ms 出现杂色像素（1.3.6 黄条回归）：'
            '${stray.take(5).join(", ")}',
      );
      image.dispose();
    }
  });
}

void _noop() {}
