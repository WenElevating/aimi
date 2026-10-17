import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../ui/dashboard/dashboard_screen.dart';
import '../ui/session/session_screen.dart';

/// 路由：/ 看板；/session/:id 会话时间线（点通知/卡片深链直达）。
final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    routes: [
      GoRoute(path: '/', builder: (_, _) => const DashboardScreen()),
      GoRoute(
        path: '/session/:id',
        builder: (_, state) => SessionScreen(sessionId: state.pathParameters['id']!),
      ),
    ],
  );
});
