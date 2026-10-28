import 'package:aimi/app/providers.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/data/update/app_updater.dart';
import 'package:aimi/data/update/install_bridge.dart';
import 'package:aimi/ui/dashboard/dashboard_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../data/connection/aimi_connection_test.dart' as harness;

/// 更新通知顶部化（feedback #20261025-234028-2465ab）：
/// 内联横幅改为可停留顶部通知；同一目标版本只自动弹一次。
void main() {
  /// 公共装配：在线看板 + 注入桩依赖的 AppUpdater（返回 updater notifier 驱动状态）。
  Future<({ProviderContainer container, AppUpdater updater})> boot(
    WidgetTester tester, {
    required List<SessionMetaDto> sessions,
  }) async {
    final container = ProviderContainer(
      overrides: [
        cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
        connectionProvider.overrideWith((ref) => null),
        connStateProvider.overrideWith(
          (ref) => Stream.value(ConnState.onlineLan),
        ),
        endpointsProvider.overrideWith((ref) async => harness.endpoints),
        cacheProvider.overrideWith((ref) async => SessionMirror()),
        sessionsProvider.overrideWith((ref) => sessions),
        appUpdaterProvider.overrideWith(
          (ref) => AppUpdater(
            currentVersionCode: () async => 1,
            downloadUrlOf: (_) => null,
            download:
                ({
                  required Uri url,
                  required String fileName,
                  required void Function(int received, int total) onProgress,
                }) async => '',
            installBridge: InstallBridge(),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const DashboardScreen(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    return (container: container, updater: container.read(appUpdaterProvider.notifier));
  }

  SessionMetaDto meta(String id, String cwd, String state) => SessionMetaDto(
    id: id,
    agentId: 'claude',
    cwd: cwd,
    permissionMode: 'default',
    state: state,
    lastSeq: 0,
    createdAt: 1,
    updatedAt: 1,
  );

  UpdateInfoFrameDto info(String versionName, int versionCode) =>
      UpdateInfoFrameDto(
        latest: AppUpdateManifestDto(
          versionName: versionName,
          versionCode: versionCode,
          size: 1024,
          sha256: 'a' * 64,
          downloadPath: '/updates/a.apk',
        ),
      );

  testWidgets('更新可用：顶部通知弹出且可停留，不重复弹第二条', (tester) async {
    final (container: container, updater: updater) = await boot(
      tester,
      sessions: [meta('s1', r'C:\proj', 'finished')],
    );

    updater.onInfo(info('1.4.0', 2));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    // 顶部通知出现；远超 toast 生命周期仍在（可停留）。
    expect(find.textContaining('1.4.0'), findsOneWidget);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.textContaining('1.4.0'), findsOneWidget);

    // 状态再广播（同版本）不重复弹。
    updater.onInfo(info('1.4.0', 2));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.textContaining('1.4.0'), findsOneWidget);

    // 关闭后不再自动打扰（同版本不重弹）。
    debugPrint(
      'close-btn count=${find.byTooltip('关闭通知').evaluate().length} '
      'rect=${tester.getRect(find.byTooltip('关闭通知'))}',
    );
    // 关闭后不再自动打扰（同版本不重弹）。
    await tester.tap(find.byTooltip('关闭通知'));
    // 退场 180ms：拆成多步泵（Overlay 条目在 post-frame 插入，单次大步
    // pump 的时钟推进对该 ticker 不可靠）。
    await tester.pump(const Duration(milliseconds: 120));
    await tester.pump(const Duration(milliseconds: 120));
    await tester.pump(const Duration(milliseconds: 120));
    expect(find.textContaining('1.4.0'), findsNothing);
    updater.onInfo(info('1.4.0', 2));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.textContaining('1.4.0'), findsNothing);
  });

  testWidgets('内联更新横幅不再出现（已由顶部通知取代）', (tester) async {
    final (container: container, updater: updater) = await boot(
      tester,
      sessions: [meta('s1', r'C:\proj', 'finished')],
    );
    updater.onInfo(info('1.4.0', 2));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.text('发现新版本 1.4.0，可更新'), findsNothing);
  });

  testWidgets('新版本再次发布：重新弹出通知', (tester) async {
    final (container: container, updater: updater) = await boot(
      tester,
      sessions: [meta('s1', r'C:\proj', 'finished')],
    );
    updater.onInfo(info('1.4.0', 2));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    await tester.tap(find.byTooltip('关闭通知'));
    await tester.pump(const Duration(milliseconds: 250));

    updater.onInfo(info('1.5.0', 3));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.textContaining('1.5.0'), findsOneWidget);
  });
}
