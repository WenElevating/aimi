import 'dart:io';

import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/data/update/app_updater.dart';
import 'package:aimi/data/update/install_bridge.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';

/// 可控行为的安装桥假体：记录 installApk/跳设置调用并可切换授权状态。
class FakeInstallBridge extends InstallBridge {
  FakeInstallBridge({this.allowed = true});

  bool allowed;
  String? installedName;
  int settingsOpened = 0;

  @override
  Future<bool> canRequestPackageInstalls() async => allowed;

  @override
  Future<void> installApk(String fileName) async {
    installedName = fileName;
  }

  @override
  Future<void> openUnknownAppSourcesSettings() async {
    settingsOpened += 1;
  }
}

void main() {
  late Directory tempDir;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('aimi-updater-test-');
  });

  tearDown(() {
    tempDir.deleteSync(recursive: true);
  });

  /// 组装被测 AppUpdater；下载假体返回写有 [body] 的临时文件路径（供 sha256 校验）。
  /// [noDownloadUrl] 置 true 时 downloadUrlOf 恒返回 null（relay 场景路径）。
  (AppUpdater, FakeInstallBridge) makeUpdater({
    required List<int> body,
    int currentVersionCode = 1,
    bool installAllowed = true,
    bool noDownloadUrl = false,
  }) {
    final file = File('${tempDir.path}${Platform.pathSeparator}apk.bin');
    file.writeAsBytesSync(body);
    final bridge = FakeInstallBridge(allowed: installAllowed);
    final updater = AppUpdater(
      currentVersionCode: () async => currentVersionCode,
      downloadUrlOf: noDownloadUrl
          ? (_) => null
          : (manifest) => Uri.parse('http://127.0.0.1:1${manifest.versionCode}/updates/x.apk'),
      download: ({required url, required fileName, required onProgress}) async {
        onProgress((body.length / 2).floor(), body.length);
        return file.path;
      },
      installBridge: bridge,
    );
    return (updater, bridge);
  }

  /// 目标版本 manifest（versionCode 默认比自身大）。
  AppUpdateManifestDto manifestOf({int versionCode = 2, String? sha256}) {
    return AppUpdateManifestDto(
      versionName: '1.0.$versionCode',
      versionCode: versionCode,
      size: 8,
      sha256: sha256 ?? '0' * 64,
      downloadPath: '/updates/app-$versionCode.apk',
    );
  }

  test('推送新版本 → available；同版本/更低版本不提示（手动检查时回 upToDate）', () async {
    final (updater, bridge) = makeUpdater(body: [1, 2, 3]);
    final good = AppUpdateManifestDto(
      versionName: '1.0.2', versionCode: 2, size: 3,
      sha256: sha256.convert([1, 2, 3]).toString(), downloadPath: '/updates/app-2.apk',
    );
    updater.onInfo(UpdateInfoFrameDto(latest: good));
    await Future<void>.delayed(Duration.zero);
    expect(updater.state.phase, UpdatePhase.available);
    expect(updater.state.manifest?.versionCode, 2);

    updater.onInfo(UpdateInfoFrameDto(latest: manifestOf(versionCode: 1)));
    await Future<void>.delayed(Duration.zero);
    expect(updater.state.phase, UpdatePhase.available, reason: '推送旧版本不打断 available');

    // 手动检查路径：先置 checking 再收到旧版本 → upToDate。
    updater.startCheck(() => true);
    expect(updater.state.phase, UpdatePhase.checking);
    updater.onInfo(UpdateInfoFrameDto(latest: manifestOf(versionCode: 1)));
    await Future<void>.delayed(Duration.zero);
    expect(updater.state.phase, UpdatePhase.upToDate);
  });

  test('手动检查：latest null → upToDate；发送失败 → failed', () async {
    final (updater, bridge) = makeUpdater(body: [1]);
    updater.startCheck(() => true);
    updater.onInfo(const UpdateInfoFrameDto(latest: null));
    expect(updater.state.phase, UpdatePhase.upToDate);

    updater.startCheck(() => false);
    expect(updater.state.phase, UpdatePhase.failed);
    expect(updater.state.error, contains('未连接'));
  });

  test('下载并安装：进度推进 → sha256 通过 → 调起安装', () async {
    final body = List<int>.generate(64, (i) => i);
    final (updater, bridge) = makeUpdater(body: body);
    final good = AppUpdateManifestDto(
      versionName: '1.0.2', versionCode: 2, size: body.length,
      sha256: sha256.convert(body).toString(), downloadPath: '/updates/app-2.apk',
    );
    updater.onInfo(UpdateInfoFrameDto(latest: good));
    await Future<void>.delayed(Duration.zero);

    await updater.downloadAndInstall();
    expect(updater.state.phase, UpdatePhase.installing);
    expect(bridge.installedName, 'aimi-update-2.apk');
  });

  test('installing 被打断 → onAppResumed 回退 available，重试直接调安装器', () async {
    final body = List<int>.generate(64, (i) => i);
    final (updater, bridge) = makeUpdater(body: body);
    final good = AppUpdateManifestDto(
      versionName: '1.0.2', versionCode: 2, size: body.length,
      sha256: sha256.convert(body).toString(), downloadPath: '/updates/app-2.apk',
    );
    updater.onInfo(UpdateInfoFrameDto(latest: good));
    await Future<void>.delayed(Duration.zero);
    await updater.downloadAndInstall();
    expect(updater.state.phase, UpdatePhase.installing);

    // 用户在系统安装器上取消/回退：回到应用（生命周期 resume）→ 状态回退 available。
    await updater.onAppResumed();
    expect(updater.state.phase, UpdatePhase.available);
    expect(updater.state.manifest?.versionCode, 2);

    // 再次 downloadAndInstall：复用已下载文件直接调安装器（不重复下载）。
    await updater.downloadAndInstall();
    expect(updater.state.phase, UpdatePhase.installing);
    expect(bridge.installedName, 'aimi-update-2.apk');
  });

  test('sha256 不符 → failed 且提示校验失败', () async {
    final (updater, bridge) = makeUpdater(body: [9, 9, 9]);
    final bad = AppUpdateManifestDto(
      versionName: '1.0.2', versionCode: 2, size: 3,
      sha256: '1' * 64, downloadPath: '/updates/app-2.apk',
    );
    updater.onInfo(UpdateInfoFrameDto(latest: bad));
    await Future<void>.delayed(Duration.zero);

    await updater.downloadAndInstall();
    expect(updater.state.phase, UpdatePhase.failed);
    expect(updater.state.error, contains('校验失败'));
  });

  test('缺安装授权 → permissionNeeded；开启后重试直接安装（跳过下载）', () async {
    final body = List<int>.generate(8, (i) => i * 3);
    final (updater, bridge) = makeUpdater(body: body, installAllowed: false);
    final good = AppUpdateManifestDto(
      versionName: '1.0.2', versionCode: 2, size: body.length,
      sha256: sha256.convert(body).toString(), downloadPath: '/updates/app-2.apk',
    );
    updater.onInfo(UpdateInfoFrameDto(latest: good));
    await Future<void>.delayed(Duration.zero);

    await updater.downloadAndInstall();
    expect(updater.state.phase, UpdatePhase.permissionNeeded);
    expect(bridge.installedName, isNull);

    bridge.allowed = true;
    await updater.downloadAndInstall();
    expect(updater.state.phase, UpdatePhase.installing);
    expect(bridge.installedName, 'aimi-update-2.apk');
  });

  test('retryAfterPermission：已授权 → 复用下载直接安装；未授权 → 再次跳设置', () async {
    final body = List<int>.generate(8, (i) => i);
    final (updater, bridge) = makeUpdater(body: body, installAllowed: false);
    final good = AppUpdateManifestDto(
      versionName: '1.0.2', versionCode: 2, size: body.length,
      sha256: sha256.convert(body).toString(), downloadPath: '/updates/app-2.apk',
    );
    updater.onInfo(UpdateInfoFrameDto(latest: good));
    await Future<void>.delayed(Duration.zero);
    await updater.downloadAndInstall();
    expect(updater.state.phase, UpdatePhase.permissionNeeded);

    // 授权尚未开启：重试再次跳设置（不进入安装）。
    await updater.retryAfterPermission();
    expect(updater.state.phase, UpdatePhase.permissionNeeded);
    expect(bridge.installedName, isNull);
    expect(bridge.settingsOpened, 1);

    // 授权开启后：重试直接安装（防死循环的唯一出口）。
    bridge.allowed = true;
    await updater.retryAfterPermission();
    expect(updater.state.phase, UpdatePhase.installing);
    expect(bridge.installedName, 'aimi-update-2.apk');
  });

  test('无下载通道（downloadUrlOf 返回 null）→ failed 提示 relay 场景', () async {
    final (updater, bridge) = makeUpdater(body: [1], noDownloadUrl: true);
    updater.onInfo(UpdateInfoFrameDto(latest: manifestOf()));
    await Future<void>.delayed(Duration.zero);

    await updater.downloadAndInstall();
    expect(updater.state.phase, UpdatePhase.failed);
    expect(updater.state.error, contains('直连'));
  });
}
