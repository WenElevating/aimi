import 'package:flutter/material.dart';

/// M0 主题 token 骨架（视觉专项另行设计；此处只保证一致性与深浅双主题）。
abstract final class AimiTheme {
  static const seed = Color(0xFF4F6EF7);

  static ThemeData light() => _base(Brightness.light);
  static ThemeData dark() => _base(Brightness.dark);

  static ThemeData _base(Brightness brightness) {
    final scheme = ColorScheme.fromSeed(seedColor: seed, brightness: brightness);
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
    );
  }
}
