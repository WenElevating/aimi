import 'package:aimi/app/providers.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/data/update/app_updater.dart';
import 'package:aimi/data/update/install_bridge.dart';
import 'package:aimi/ui/settings/settings_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// 假连接：checkForUpdate() 返回 true（在线语义）。应答帧由测试手动喂给
/// updater——真实链路里服务端应答经 connection.updates 流回到 onInfo，
/// 桩里直接喂等价。构造参数仅为满足父类签名，桩不真正建连。
class _FakeConnection extends AimiConnection {
  _FakeConnection()
      : super(
          endpoints: AimiEndpoints(
            host: 'test',
            port: 8787,
            scheme: 'ws',
            token: 't',
          ),
          cache: SessionMirror(),
          channelFactory: (uri) => WebSocketChannel.connect(uri),
        );

  @override
  bool checkForUpdate() => true;
}

/// 假下载器：不做网络 IO，进度一次给满后返回临时路径。
Future<String> fakeDownload({
  required Uri url,
  required String fileName,
  required void Function(int received, int total) onProgress,
}) async {
  onProgress(10, 10);
  return '/tmp/fake.apk';
}

/// 覆写 appUpdaterProvider：注入测试状态机（currentVersionCode=1）+ 在线假连接。
/// 返回喂帧函数：tap 之后调用才发检查应答（模拟服务端往返）。
Future<(ProviderContainer, void Function())> pumpWithUpdater(
  WidgetTester tester, {
  required int latestVersionCode,
}) async {
  final container = ProviderContainer(
    overrides: [
      connStateProvider.overrideWith((ref) => Stream.value(ConnState.onlineLan)),
      connectionProvider.overrideWithValue(_FakeConnection()),
      appUpdaterProvider.overrideWith(
        (ref) => AppUpdater(
          currentVersionCode: () async => 1,
          downloadUrlOf: (manifest) => Uri.http('test', manifest.downloadPath),
          download: fakeDownload,
          installBridge: InstallBridge(),
        ),
      ),
    ],
  );
  addTearDown(container.dispose);

  final manifest = AppUpdateManifestDto(
    versionName: '9.9.9',
    versionCode: latestVersionCode,
    size: 10,
    sha256: 'x',
    downloadPath: '/apk',
  );
  void answerCheck() {
    container
        .read(appUpdaterProvider.notifier)
        .onInfo(UpdateInfoFrameDto(latest: manifest));
  }

  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: AimiTheme.light(),
        home: const SettingsScreen(),
      ),
    ),
  );
  await tester.pump();
  return (container, answerCheck);
}

void main() {
  testWidgets('有更新：点检查更新弹中间模态（不弹底部抽屉），主键触发下载', (tester) async {
    final (_, answerCheck) = await pumpWithUpdater(tester, latestVersionCode: 2);
    await tester.pumpAndSettle();

    await tester.tap(find.text('检查更新'));
    // 点击后才喂检查应答（模拟服务端往返）；分帧 pump 到 _evaluate 异步链走完。
    answerCheck();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 模态形态：标题 + 发现新版本 + 主键；旧底部抽屉独有文案不再出现。
    expect(find.text('发现新版本 9.9.9'), findsOneWidget);
    expect(find.text('下载并安装'), findsOneWidget);
    expect(find.text('以后再说'), findsOneWidget);
    expect(find.text('已是最新版本'), findsNothing);

    // 主键按下：进入 downloading（进度文案出现）。
    await tester.tap(find.text('下载并安装'));
    await tester.pumpAndSettle();
    expect(find.textContaining('正在下载'), findsOneWidget);
  });

  testWidgets('无更新：不弹任何面板，顶部轻提示「当前已是最新版本」', (tester) async {
    final (_, answerCheck) = await pumpWithUpdater(tester, latestVersionCode: 1);
    await tester.pumpAndSettle();

    await tester.tap(find.text('检查更新'));
    // 同上：点击后喂应答；分帧 pump（不 settle，防快进 toast 停留 Timer）。
    answerCheck();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('当前已是最新版本'), findsOneWidget);
    expect(find.text('软件更新'), findsNothing); // 无模态
    expect(find.text('下载并安装'), findsNothing);

    // 停留 2000ms + 退场 180ms 后摘除。
    await tester.pump(const Duration(milliseconds: 2200));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('当前已是最新版本'), findsNothing);
  });

  testWidgets('未连接：startCheck 立即失败，顶部轻提示原因', (tester) async {
    final container = ProviderContainer(
      overrides: [
        appUpdaterProvider.overrideWith(
          (ref) => AppUpdater(
            currentVersionCode: () async => 1,
            downloadUrlOf: (_) => null,
            download: fakeDownload,
            installBridge: InstallBridge(),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(theme: AimiTheme.light(), home: const SettingsScreen()),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('检查更新'));
    // 同上：不 settle，避免快进掉提示停留 Timer。
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.textContaining('未连接服务器'), findsOneWidget);
    expect(find.text('软件更新'), findsNothing);
  });
}
