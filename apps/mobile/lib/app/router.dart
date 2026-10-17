import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../ui/dashboard/dashboard_screen.dart';
import '../ui/session/session_screen.dart';
import '../ui/settings/settings_screen.dart';

/// 路由：/ 看板；/session/:id 会话时间线；/settings 连接设置（M1 的 QR 配对入口放这里）。
final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    routes: [
      GoRoute(path: '/', builder: (_, _) => const DashboardScreen()),
      GoRoute(path: '/settings', builder: (_, _) => const SettingsScreen()),
      GoRoute(
        path: '/session/:id',
        builder: (_, state) => SessionScreen(sessionId: state.pathParameters['id']!),
      ),
    ],
  );
});
