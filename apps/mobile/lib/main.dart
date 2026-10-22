import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/providers.dart';
import 'app/router.dart';
import 'app/theme.dart';

/// 启动 aimi 移动端应用；当前只适配 Android，桌面与 Web 端不在支持范围内。
void main() {
  runApp(const ProviderScope(child: AimiApp()));
}

class AimiApp extends ConsumerWidget {
  const AimiApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // 全局单连接的自启动：endpoints 就绪即连接，与当前处于哪一屏无关。
    ref.watch(connectionBootstrapProvider);
    ref.watch(foregroundServiceBootstrapProvider);
    ref.watch(notificationBootstrapProvider);
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
    );
  }
}
