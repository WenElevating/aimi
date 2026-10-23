import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// APK 安装桥（Android `aimi/install` MethodChannel）；
/// 非 Android 平台与测试环境无实现，按 [MissingPluginException] 静默降级为不可用。
class InstallBridge {
  static const MethodChannel _channel = MethodChannel('aimi/install');

  /// 调起系统包安装器安装 cacheDir 下的 [fileName]（由原生 FileProvider 暴露 content URI）。
  ///
  /// 抛出 [PlatformException]：文件名非法（bad_argument）或文件不存在（not_found）。
  Future<void> installApk(String fileName) async {
    if (kIsWeb) return;
    await _channel.invokeMethod<void>('installApk', {'name': fileName});
  }

  /// 是否已授予"允许此来源安装未知应用"（Android 8+ 的安装闸门）；
  /// 无原生实现（桌面/测试）时返回 false——调用方据此隐藏安装入口。
  Future<bool> canRequestPackageInstalls() async {
    if (kIsWeb) return false;
    try {
      return await _channel.invokeMethod<bool>('canRequestPackageInstalls') ?? false;
    } on MissingPluginException {
      return false;
    }
  }

  /// 引导跳转系统"允许安装未知应用"设置页；无原生实现时静默 no-op。
  Future<void> openUnknownAppSourcesSettings() async {
    if (kIsWeb) return;
    try {
      await _channel.invokeMethod<void>('openUnknownAppSourcesSettings');
    } on MissingPluginException {
      // Desktop/test builds intentionally have no platform service.
    }
  }
}
