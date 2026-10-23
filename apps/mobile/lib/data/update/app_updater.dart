import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../protocol/frame_dto.dart';
import 'install_bridge.dart';

/// 更新流程的阶段；UI 按阶段渲染（检查中/已是最新/可更新/下载中/安装中/需授权/失败）。
enum UpdatePhase {
  /// 空闲（未检查或无更新推送）
  idle,

  /// 已发出 update.check，等待应答
  checking,

  /// 无可用更新（服务端应答 latest 为 null 或 versionCode 不大于自身）
  upToDate,

  /// 有新版本待下载安装
  available,

  /// 正在下载 APK（[UpdateState.received]/[UpdateState.total] 报进度）
  downloading,

  /// 已调起系统安装器，等待用户在系统界面确认
  installing,

  /// 缺少"允许安装未知应用"授权；用户去系统设置开启后可重试
  permissionNeeded,

  /// 失败（下载/校验/安装调用异常），[UpdateState.error] 携带原因
  failed,
}

/// 更新流程的快照状态；[manifest] 在 available 及之后各阶段携带目标版本。
class UpdateState {
  const UpdateState({
    required this.phase,
    this.manifest,
    this.received = 0,
    this.total = 0,
    this.error,
  });

  final UpdatePhase phase;
  final AppUpdateManifestDto? manifest;
  final int received;
  final int total;
  final String? error;
}

/// APK 下载器抽象：把 [url] 下载到 cacheDir 下的 [fileName]，流式回报进度，返回文件绝对路径。
/// 抽象出来便于单测注入假实现（真实实现见 providers 的生产装配）。
typedef ApkDownloader = Future<String> Function({
  required Uri url,
  required String fileName,
  required void Function(int received, int total) onProgress,
});

/// 版本检查与下载安装的状态机（服务端 update.info 帧的唯一消费者）。
///
/// 输入：连接层 updates 流的帧经 [onInfo]（welcome 直发/发布广播/手动检查应答共用）；
/// 升级判据只有 versionCode（严格大于自身才提示），versionName 仅展示。
/// 下载走服务端同端口的 HTTP 端点（URL 由装配层用当前连接的 host/port 拼出），
/// 下载完成后做 sha256 校验，再经 [InstallBridge] 调起系统安装器。
class AppUpdater extends StateNotifier<UpdateState> {
  AppUpdater({
    required Future<int> Function() currentVersionCode,
    required Uri? Function(AppUpdateManifestDto manifest) downloadUrlOf,
    required ApkDownloader download,
    required InstallBridge installBridge,
  }) : _currentVersionCode = currentVersionCode,
       _downloadUrlOf = downloadUrlOf,
       _download = download,
       _installBridge = installBridge,
       super(const UpdateState(phase: UpdatePhase.idle));

  final Future<int> Function() _currentVersionCode;
  final Uri? Function(AppUpdateManifestDto manifest) _downloadUrlOf;
  final ApkDownloader _download;
  final InstallBridge _installBridge;

  /// 已下载待安装的文件名（cacheDir 相对名）；null = 尚无可安装产物。
  String? _downloadedFile;

  /// 当前检查是否由用户手动触发（决定"无更新"时是否提示"已是最新"）。
  bool _manualCheck = false;

  /// 连接层 updates 流的入口；任何 [AppUpdateManifestDto.versionCode] 变化的帧都会重估状态。
  void onInfo(UpdateInfoFrameDto frame) {
    final latest = frame.latest;
    if (latest == null) {
      if (state.phase == UpdatePhase.checking) {
        state = const UpdateState(phase: UpdatePhase.upToDate);
      }
      return;
    }
    unawaited(_evaluate(latest));
  }

  /// 手动检查入口：置 checking 并用 [send] 发出 update.check。
  /// [send] 返回 false（未连接）时立即失败提示，不排队重发。
  void startCheck(bool Function() send) {
    _manualCheck = true;
    state = const UpdateState(phase: UpdatePhase.checking);
    if (!send()) {
      state = const UpdateState(
        phase: UpdatePhase.failed,
        error: '未连接服务器，请先连接后再检查更新',
      );
    }
  }

  /// 下载并安装当前 [UpdateState.manifest]；只在 available/failed/permissionNeeded 阶段可用。
  Future<void> downloadAndInstall() async {
    final manifest = state.manifest;
    if (manifest == null) return;
    if (_downloadedFile != null &&
        state.phase != UpdatePhase.downloading) {
      // 同版本已下载过：跳过下载直接进入安装（权限/失败后的重试路径）。
      await _install(manifest);
      return;
    }
    final url = _downloadUrlOf(manifest);
    if (url == null) {
      state = UpdateState(
        phase: UpdatePhase.failed,
        manifest: manifest,
        error: '当前无直连下载通道（relay 场景请在局域网内操作）',
      );
      return;
    }
    final fileName = 'aimi-update-${manifest.versionCode}.apk';
    try {
      state = UpdateState(phase: UpdatePhase.downloading, manifest: manifest, total: manifest.size);
      final path = await _download(
        url: url,
        fileName: fileName,
        onProgress: (received, total) {
          state = UpdateState(
            phase: UpdatePhase.downloading,
            manifest: manifest,
            received: received,
            total: total,
          );
        },
      );
      state = UpdateState(
        phase: UpdatePhase.downloading,
        manifest: manifest,
        received: manifest.size,
        total: manifest.size,
      );
      final digest = await File(path).openRead().transform(sha256).last;
      if (digest.toString() != manifest.sha256) {
        final stale = File(path);
        if (await stale.exists()) await stale.delete();
        _downloadedFile = null;
        state = UpdateState(
          phase: UpdatePhase.failed,
          manifest: manifest,
          error: '安装包校验失败，请重试',
        );
        return;
      }
      _downloadedFile = fileName;
      await _install(manifest);
    } on Object catch (error) {
      _downloadedFile = null;
      state = UpdateState(
        phase: UpdatePhase.failed,
        manifest: manifest,
        error: '下载失败：$error',
      );
    }
  }

  /// 权限引导：跳系统"允许安装未知应用"设置页；返回后用户可再次 [downloadAndInstall]。
  Future<void> openPermissionSettings() => _installBridge.openUnknownAppSourcesSettings();

  /// 把失败/已完成状态复位回 available（保留 manifest），供 UI"重试"。
  void backToAvailable() {
    final manifest = state.manifest;
    if (manifest == null) return;
    state = UpdateState(phase: UpdatePhase.available, manifest: manifest);
  }

  /// 评估一个推送/应答到的最新版本：仅 versionCode 严格大于自身才进入 available。
  Future<void> _evaluate(AppUpdateManifestDto latest) async {
    int mine;
    try {
      mine = await _currentVersionCode();
    } on Object {
      mine = 0; // 读不到自身版本（桌面/测试）：按"需要更新"处理，让流程可继续走
    }
    if (latest.versionCode <= mine) {
      if (state.phase == UpdatePhase.checking || _manualCheck) {
        _manualCheck = false;
        state = const UpdateState(phase: UpdatePhase.upToDate);
      }
      return;
    }
    // 下载中/安装中不被旧帧打断；其余阶段切换到新版本目标。
    if (state.phase == UpdatePhase.downloading || state.phase == UpdatePhase.installing) return;
    state = UpdateState(phase: UpdatePhase.available, manifest: latest);
    _manualCheck = false;
  }

  /// 调起系统安装器（前置校验安装授权；缺授权进入 permissionNeeded 由 UI 引导）。
  Future<void> _install(AppUpdateManifestDto manifest) async {
    final fileName = _downloadedFile;
    if (fileName == null) return;
    final allowed = await _installBridge.canRequestPackageInstalls();
    if (!allowed) {
      state = UpdateState(
        phase: UpdatePhase.permissionNeeded,
        manifest: manifest,
        error: '需要授予"允许安装未知应用"权限后重试',
      );
      return;
    }
    state = UpdateState(phase: UpdatePhase.installing, manifest: manifest);
    try {
      await _installBridge.installApk(fileName);
      // 系统安装器接管界面；安装成功后系统会替换进程，无需再切状态。
    } on Object catch (error) {
      state = UpdateState(
        phase: UpdatePhase.failed,
        manifest: manifest,
        error: '调起安装失败：$error',
      );
    }
  }
}
