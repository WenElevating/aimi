import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../data/notifications/notification_policy.dart';
import '../ui/dashboard/dashboard_screen.dart';
import '../ui/session/session_screen.dart';
import '../ui/settings/settings_background_screen.dart';
import '../ui/settings/settings_notifications_screen.dart';
import '../ui/settings/settings_screen.dart';
import '../ui/welcome/welcome_screen.dart';
import '../ui/pairing/pairing_screen.dart';
import '../ui/new_session/new_session_screen.dart';
import '../ui/new_session/directory_picker_screen.dart';

/// 应用内深链的纯解析/生成工具；通知、桌面链接和测试共用同一规则。
class AimiDeepLink {
  const AimiDeepLink._();

  static String session(String sessionId) {
    if (sessionId.isEmpty) throw ArgumentError.value(sessionId, 'sessionId');
    return '/session/${Uri.encodeComponent(sessionId)}';
  }

  /// 将通知平台回调转换为可导航位置；非法或篡改的 payload 返回 null。
  static String? fromNotification(Map<String, dynamic> json) {
    final payload = NotificationActionPayload.fromJson(json);
    return payload?.deepLink;
  }

  /// 只接受 `/session/:id`，避免通知回调把任意路径注入路由栈。
  static String? sessionId(Uri uri) {
    if (uri.pathSegments.length != 2 || uri.pathSegments.first != 'session') {
      return null;
    }
    final id = uri.pathSegments[1];
    return id.isEmpty ? null : id;
  }
}

/// 路由：/ 看板；/session/:id 会话时间线；/settings 连接设置（扫码配对入口日后也放在这里）。
final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    routes: [
      GoRoute(path: '/welcome', builder: (_, _) => const WelcomeScreen()),
      // 扫码与手动配对各一屏（不在一屏里做分段切换，design.md §3.0）。
      GoRoute(
        path: '/pairing/scan',
        builder: (_, _) => const PairingScanScreen(),
      ),
      GoRoute(
        path: '/pairing/manual',
        builder: (_, _) => const PairingManualScreen(),
      ),
      GoRoute(path: '/', builder: (_, _) => const DashboardScreen()),
      GoRoute(
        path: '/new-session',
        builder: (_, _) => const NewSessionScreen(),
      ),
      GoRoute(
        path: '/new-session/directory',
        builder: (_, state) => DirectoryPickerScreen(
          initialPath: state.uri.queryParameters['path'],
        ),
      ),
      GoRoute(path: '/settings', builder: (_, _) => const SettingsScreen()),
      // 设置二级页：通知分类开关 / 后台保活（一级页只留入口，design.md §3.0）。
      GoRoute(
        path: '/settings/notifications',
        builder: (_, _) => const SettingsNotificationsScreen(),
      ),
      GoRoute(
        path: '/settings/background',
        builder: (_, _) => const SettingsBackgroundScreen(),
      ),
      GoRoute(
        path: '/session/:id',
        builder: (_, state) =>
            SessionScreen(sessionId: state.pathParameters['id']!),
      ),
    ],
  );
});
