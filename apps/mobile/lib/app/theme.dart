import 'package:flutter/material.dart';

/// 主题基础配置：只保证配色一致性与深浅两套主题，视觉细化另行安排。
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
