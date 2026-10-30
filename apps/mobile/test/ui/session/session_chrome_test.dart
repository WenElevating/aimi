import 'dart:io';
import 'dart:async';
import 'dart:ui' as ui;

import 'package:aimi/app/providers.dart';
import 'package:aimi/app/session_render_provider.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/data/db/persistent_cache.dart';
import 'package:aimi/ui/session/session_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// 在真实会话布局中验证安全区、标题和事件行共用完整顶栏，而非只改标题色。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    const output = String.fromEnvironment('AIMI_SCREENSHOT_DIR');
    if (output.isEmpty) return;
    for (final family in ['Inter', 'JetBrainsMono']) {
      final loader = FontLoader(family)
        ..addFont(rootBundle.load('assets/fonts/$family-Variable.ttf'));
      await loader.load();
    }
    if (Platform.isWindows) {
      final bytes = File(r'C:\Windows\Fonts\msyh.ttc').readAsBytesSync();
      final loader = FontLoader('Microsoft YaHei')
        ..addFont(Future.value(ByteData.view(bytes.buffer)));
      await loader.load();
    }
  });
  for (final dark in [false, true]) {
    testWidgets('会话顶部连续同色并匹配系统图标：${dark ? '深色' : '浅色'}', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final theme = dark ? AimiTheme.dark() : AimiTheme.light();
      final container = ProviderContainer(
        overrides: [
          cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
          connectionProvider.overrideWith((ref) => null),
          cacheProvider.overrideWith((ref) async => SessionMirror()),
          sessionsProvider.overrideWith(
            (ref) => const [
              SessionMetaDto(
                id: 's1',
                agentId: 'claude',
                cwd: 'C:/project',
                permissionMode: 'default',
                state: 'finished',
                lastSeq: 2,
                createdAt: 1,
                updatedAt: 1,
              ),
            ],
          ),
          sessionRenderEventsProvider('s1').overrideWith(
            (ref) => [
              AgentEventDto.fromJson({'type': 'state', 'state': 'starting'}),
              AgentEventDto.fromJson({
                'type': 'text_delta',
                'text': '会话正文保持独立画布。',
              }),
              AgentEventDto.fromJson({'type': 'state', 'state': 'finished'}),
            ],
          ),
          outgoingMessageStoreProvider.overrideWith(
            (ref) => Completer<DriftOutgoingMessageStore>().future,
          ),
        ],
      );
      addTearDown(container.dispose);
      final boundaryKey = GlobalKey();
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: theme,
            home: MediaQuery(
              data: const MediaQueryData(
                size: Size(390, 844),
                padding: EdgeInsets.only(top: 24),
              ),
              child: RepaintBoundary(
                key: boundaryKey,
                child: const SessionScreen(sessionId: 's1'),
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 250));
      final chrome = find.byKey(const ValueKey('session-chrome'));
      expect(chrome, findsOneWidget);
      final decoration =
          tester.widget<DecoratedBox>(chrome).decoration as BoxDecoration;
      // 参考图风格（白纸面）：顶栏并入纯白画布与时间线连续，且无底部分割线。
      expect(decoration.color, theme.extension<AimiColors>()!.surfaceSolid);
      expect(decoration.border, isNull, reason: '顶栏下不再画分割线');
      expect(tester.getRect(chrome).top, 0);
      // 新顶栏为标题+副行一体块（去独立状态条后总高 ~52）：仍显著高于单行标题。
      expect(tester.getRect(chrome).bottom, greaterThan(60));
      // 副行（状态元信息）并入标题块：标题在上，副行紧贴其下 ~7px——
      // 「● N 分钟 · N 事件」是标题的注脚，不是独立一条悬在中间。
      final title = tester.getRect(
        find.descendant(
          of: chrome,
          matching: find.text('会话正文保持独立画布。'),
        ),
      );
      final metaRow = tester.getRect(
        find.descendant(of: chrome, matching: find.textContaining('事件')),
      );
      expect(
        metaRow.top - title.bottom,
        inInclusiveRange(4, 10),
        reason: '副行贴标题正下方，间距 7px 量级',
      );
      // chrome 底界 = 状态副行底 + 少量留白；副行之下不再有独立状态条。
      expect(
        tester.getRect(chrome).bottom - metaRow.bottom,
        inInclusiveRange(0, 14),
        reason: '副行是 chrome 最后一个内容行',
      );
      final overlay = tester
          .widget<AnnotatedRegion<SystemUiOverlayStyle>>(
            find.byKey(const ValueKey('session-system-overlay')),
          )
          .value;
      expect(
        overlay.statusBarIconBrightness,
        dark ? Brightness.light : Brightness.dark,
      );
      expect(
        overlay.statusBarColor,
        theme.extension<AimiColors>()!.surfaceSolid,
      );
      final boundary =
          boundaryKey.currentContext!.findRenderObject()!
              as RenderRepaintBoundary;
      final screenshot = (await tester.runAsync(() => boundary.toImage()))!;
      final pixels = (await tester.runAsync(
        () => screenshot.toByteData(format: ui.ImageByteFormat.rawRgba),
      ))!;

      /// 读取远离文字/按钮的背景像素，验证安全区至副行确实连续同色。
      /// （新顶栏 = 标题 + 副行一体块，chrome 底 ≈ 24 + 62 ≈ 86；y=70 在副行内。）
      List<int> sample(int y) =>
          pixels.buffer.asUint8List((y * screenshot.width + 2) * 4, 4).toList();
      expect(sample(8), sample(40));
      expect(sample(40), sample(70));
      // feedback #20261025-192751-348465：顶栏与正文时间线同色，不再分段。
      expect(sample(70), sample(130));
      const output = String.fromEnvironment('AIMI_SCREENSHOT_DIR');
      if (output.isNotEmpty) {
        final png = (await tester.runAsync(
          () => screenshot.toByteData(format: ui.ImageByteFormat.png),
        ))!;
        File(
          '$output/session-${dark ? 'dark' : 'light'}.png',
        ).writeAsBytesSync(png.buffer.asUint8List());
      }
      screenshot.dispose();
      expect(tester.takeException(), isNull);
    });
  }
}
