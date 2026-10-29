import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import 'app/providers.dart';
import 'app/router.dart';
import 'ui/opening/opening_screen.dart';
import 'app/theme.dart';
import 'data/logging/aimi_logger.dart';

/// 启动 aimi 移动端应用；当前只适配 Android，桌面与 Web 端不在支持范围内。
///
/// 崩溃捕获在 [runApp] 之前装配：FlutterError（框架异常）与 PlatformDispatcher
/// （未捕获的平台/异步异常）全部写入日志——"进程死了日志还在"的另一半。
/// 文件层初始化是异步的，启动头几条日志仅入内存环（init 完成后统一落盘）。
Future<void> main() async {
  final logger = AimiLogger.instance;
  FlutterError.onError = (details) {
    aimiLog(
      AimiLogLevel.error,
      'flutter',
      '框架异常: ${details.exceptionAsString()}\n${details.stack ?? StackTrace.current}',
    );
    // 保留框架默认行为（debug 呈现/Release 静默），日志只是旁路。
    FlutterError.presentError(details);
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    aimiLog(AimiLogLevel.error, 'dart', '未捕获异常: $error\n$stack');
    return true;
  };
  runZonedGuarded(() {
    unawaited(_initFileLogging(logger));
    aimiLog(AimiLogLevel.info, 'app', '应用启动');
    runApp(const ProviderScope(child: AimiApp()));
  }, (error, stack) {
    aimiLog(AimiLogLevel.error, 'dart', 'zone 未捕获异常: $error\n$stack');
  });
}

/// 文件层初始化：路径由平台插件提供，失败由 logger 内部降级兜底。
Future<void> _initFileLogging(AimiLogger logger) async {
  try {
    final support = await getApplicationSupportDirectory();
    await logger.init(Directory('${support.path}${Platform.pathSeparator}logs'));
  } on Object catch (error) {
    // 插件不可用（测试/桌面）等场景：仅内存环 + debugPrint，不影响启动。
    aimiLog(AimiLogLevel.warn, 'app', '日志文件层初始化失败（降级为内存环）：$error');
  }
}

class AimiApp extends ConsumerStatefulWidget {
  const AimiApp({super.key});

  @override
  ConsumerState<AimiApp> createState() => _AimiAppState();
}

class _AimiAppState extends ConsumerState<AimiApp> {
  /// 开屏只播一次（冷启动内存态）；结束（播完/跳过）后整段不再出现。
  bool _opening = true;

  /// 从系统安装器返回应用时，把卡在 installing 的更新状态回退为可用
  /// （否则安装被打断后用户没有任何入口完成安装）。
  AppLifecycleListener? _lifecycleListener;

  @override
  void initState() {
    super.initState();
    _lifecycleListener = AppLifecycleListener(
      onResume: () => unawaited(
        ref.read(appUpdaterProvider.notifier).onAppResumed(),
      ),
    );
  }

  @override
  void dispose() {
    _lifecycleListener?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // 全局单连接的自启动：endpoints 就绪即连接，与当前处于哪一屏无关。
    ref.watch(connectionBootstrapProvider);
    ref.watch(foregroundServiceBootstrapProvider);
    ref.watch(notificationBootstrapProvider);
    ref.watch(updateBootstrapProvider);
    ref.watch(capsBootstrapProvider);
    final router = ref.watch(routerProvider);
    final themeMode = ref.watch(themeModeProvider);
    final notificationService = ref.watch(localNotificationServiceProvider);
    final connection = ref.watch(connectionProvider);
    notificationService.bind(
      navigate: router.go,
      approve: (sessionId, requestId, decision) => approveFromNotification(
        connection,
        sessionId,
        requestId,
        decision,
      ),
    );
    return MaterialApp.router(
      title: 'aimi',
      debugShowCheckedModeBanner: false,
      theme: AimiTheme.light(),
      darkTheme: AimiTheme.dark(),
      themeMode: switch (themeMode) {
        AimiThemeMode.system => ThemeMode.system,
        AimiThemeMode.light => ThemeMode.light,
        AimiThemeMode.dark => ThemeMode.dark,
      },
      routerConfig: router,
      builder: (context, child) {
        // 开屏覆盖在导航之上：不承载信息、不阻塞装配（连接在底层照常启动）。
        return Stack(
          children: [
            ?child,
            if (_opening)
              OpeningScreen(onDone: () => setState(() => _opening = false)),
          ],
        );
      },
    );
  }
}
