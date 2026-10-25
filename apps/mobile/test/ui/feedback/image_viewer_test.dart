import 'dart:io';

import 'package:aimi/app/theme.dart';
import 'package:aimi/ui/feedback/image_viewer.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 使用真实图片验证查看与翻页；文件准备不依赖 widget 测试中的模拟异步队列。
void main() {
  /// 同步生成并清理图片，避免在 FakeAsync 内等待系统文件 I/O 导致用例挂起。
  List<String> makeImages() {
    final dir = Directory.systemTemp.createTempSync('aimi-viewer-test-');
    addTearDown(() => dir.deleteSync(recursive: true));
    // 1×1 红色 PNG（最小合法像素数据，手写字节）。
    const png = <int>[
      0x89,
      0x50,
      0x4E,
      0x47,
      0x0D,
      0x0A,
      0x1A,
      0x0A,
      0x00,
      0x00,
      0x00,
      0x0D,
      0x49,
      0x48,
      0x44,
      0x52,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
      0x08,
      0x02,
      0x00,
      0x00,
      0x00,
      0x90,
      0x77,
      0x53,
      0xDE,
      0x00,
      0x00,
      0x00,
      0x0C,
      0x49,
      0x44,
      0x41,
      0x54,
      0x08,
      0xD7,
      0x63,
      0xF8,
      0xCF,
      0xC0,
      0x00,
      0x00,
      0x03,
      0x01,
      0x01,
      0x00,
      0x18,
      0xDD,
      0x8D,
      0xB0,
      0x00,
      0x00,
      0x00,
      0x00,
      0x49,
      0x45,
      0x4E,
      0x44,
      0xAE,
      0x42,
      0x60,
      0x82,
    ];
    final paths = <String>[];
    for (final name in ['a.png', 'b.png']) {
      final file = File('${dir.path}/$name')..writeAsBytesSync(png);
      paths.add(file.path);
    }
    return paths;
  }

  /// 在真实异步区等待图片读盘和解码；pumpAndSettle 只能推进框架帧，不能代替文件 I/O。
  Future<void> loadImage(WidgetTester tester, String path) async {
    Object? imageError;
    await tester.runAsync(
      () => precacheImage(
        FileImage(File(path)),
        tester.element(find.byType(Scaffold).first),
        onError: (error, stack) {
          imageError = error;
        },
      ).timeout(const Duration(seconds: 5)),
    );
    expect(imageError, isNull);
    await tester.pump();
  }

  testWidgets('查看器：initialIndex 对应计数、翻页更新计数、关闭可退', (tester) async {
    final paths = makeImages();
    await tester.pumpWidget(
      MaterialApp(
        theme: AimiTheme.light(),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () =>
                    showAimiImageViewer(context, paths: paths, initialIndex: 1),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    for (final path in paths) {
      await loadImage(tester, path);
    }
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    // initialIndex=1 → 计数 2/2（PageView 只构建可见页，a.png 不在场）。
    expect(find.text('2/2'), findsOneWidget);
    expect(
      tester.widget<RawImage>(find.byType(RawImage).first).image,
      isNotNull,
    );

    await tester.drag(find.byType(PageView), const Offset(600, 0));
    await tester.pumpAndSettle();
    expect(find.text('1/2'), findsOneWidget);
    expect(
      tester.widget<RawImage>(find.byType(RawImage).first).image,
      isNotNull,
    );

    // 关闭退场。
    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();
    expect(find.text('2/2'), findsNothing);
    expect(find.text('1/2'), findsNothing);
  });

  /// 缺失文件的读取和错误通知都在真实异步区发生，颜色按查看器黑底验证。
  Future<void> verifyMissingImage(WidgetTester tester, ThemeData theme) async {
    final paths = makeImages();
    final missingPath = '${File(paths.first).parent.path}/missing.png';
    await tester.pumpWidget(
      MaterialApp(
        theme: theme,
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () =>
                    showAimiImageViewer(context, paths: [missingPath]),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    Object? imageError;
    await tester.runAsync(() async {
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await precacheImage(
        FileImage(File(missingPath)),
        tester.element(find.byType(Scaffold).first),
        onError: (error, stack) {
          imageError = error;
        },
      ).timeout(const Duration(seconds: 5));
    });
    expect(imageError, isA<FileSystemException>());
    await tester.pumpAndSettle();
    expect(find.text('图片加载失败'), findsOneWidget);
    expect(
      tester.widget<Text>(find.text('图片加载失败')).style?.color,
      Colors.white70,
    );
    expect(find.text('1/1'), findsOneWidget);
  }

  testWidgets('查看器：文件缺失显示失败占位而不崩', (tester) async {
    await verifyMissingImage(tester, AimiTheme.light());
  });

  testWidgets('查看器：深色主题下文件缺失占位同样清晰可见', (tester) async {
    await verifyMissingImage(tester, AimiTheme.dark());
  });
}
