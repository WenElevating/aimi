import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../ui/dashboard/dashboard_screen.dart';
import '../ui/session/session_screen.dart';
import '../ui/settings/settings_screen.dart';
import '../ui/welcome/welcome_screen.dart';
import '../ui/pairing/pairing_screen.dart';
import '../ui/new_session/new_session_screen.dart';

/// 路由：/ 看板；/session/:id 会话时间线；/settings 连接设置（扫码配对入口日后也放在这里）。
final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    routes: [
      GoRoute(path: '/welcome', builder: (_, _) => const WelcomeScreen()),
      GoRoute(
        path: '/pairing/scan',
        builder: (_, _) => const PairingScreen(scan: true),
      ),
      GoRoute(
        path: '/pairing/manual',
        builder: (_, _) => const PairingScreen(scan: false),
      ),
      GoRoute(path: '/', builder: (_, _) => const DashboardScreen()),
      GoRoute(
        path: '/new-session',
        builder: (_, _) => const NewSessionScreen(),
      ),
      GoRoute(path: '/settings', builder: (_, _) => const SettingsScreen()),
      GoRoute(
        path: '/session/:id',
        builder: (_, state) =>
            SessionScreen(sessionId: state.pathParameters['id']!),
      ),
    ],
  );
});
