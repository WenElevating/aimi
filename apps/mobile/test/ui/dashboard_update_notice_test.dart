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

/// 更新入口改 header 图标（feedback #8d81bf③）：有新版本才出现、点击直达
/// 更新弹窗（无需去设置页点检查更新）；替代 1.3.6 的顶部通知自动弹。
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
    return (
      container: container,
      updater: container.read(appUpdaterProvider.notifier),
    );
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

  testWidgets('无可用更新：header 不显示更新图标', (tester) async {
    final (container: _, updater: _) = await boot(
      tester,
      sessions: [meta('s1', r'C:\proj', 'finished')],
    );
    expect(find.byTooltip('发现新版本，点击更新'), findsNothing);
  });

  testWidgets('更新可用：header 出现图标，点击直达更新弹窗', (tester) async {
    final (container: _, updater: updater) = await boot(
      tester,
      sessions: [meta('s1', r'C:\proj', 'finished')],
    );
    updater.onInfo(info('1.4.0', 2));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    expect(find.byTooltip('发现新版本，点击更新'), findsOneWidget);
    // 顶部通知形态已退役（用户明确要 header 图标直达弹窗）。
    expect(find.byTooltip('关闭通知'), findsNothing);

    await tester.tap(find.byTooltip('发现新版本，点击更新'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    // 更新弹窗直接呈现（不再绕道设置页）。
    expect(find.textContaining('1.4.0'), findsWidgets);
  });
}
