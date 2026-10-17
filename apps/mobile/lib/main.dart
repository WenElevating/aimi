import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/router.dart';
import 'app/theme.dart';

/// aimi 移动端入口（M0：Android-first 骨架，连接/会话能力在 data/ 与 ui/ 各任务落地）。
void main() {
  runApp(const ProviderScope(child: AimiApp()));
}

class AimiApp extends ConsumerWidget {
  const AimiApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    return MaterialApp.router(
      title: 'aimi',
      theme: AimiTheme.light(),
      darkTheme: AimiTheme.dark(),
      themeMode: ThemeMode.system,
      routerConfig: router,
    );
  }
}
