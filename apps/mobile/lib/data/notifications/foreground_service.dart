import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Android FGS bridge；非 Android 平台静默 no-op。
class ForegroundServiceBridge {
  static const MethodChannel _channel = MethodChannel(
    'aimi/foreground_service',
  );

  Future<void> start() async {
    if (kIsWeb) return;
    try {
      await _channel.invokeMethod<void>('start');
    } on MissingPluginException {
      // Desktop/test builds intentionally have no platform service.
    }
  }

  Future<void> stop() async {
    if (kIsWeb) return;
    try {
      await _channel.invokeMethod<void>('stop');
    } on MissingPluginException {
      // Desktop/test builds intentionally have no platform service.
    }
  }
}
