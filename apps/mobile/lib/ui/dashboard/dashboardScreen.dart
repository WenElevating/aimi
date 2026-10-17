import 'package:flutter/material.dart';

/// 会话看板（T15 实现完整看板；M0 骨架占位）。
class DashboardScreen extends StatelessWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('aimi')),
      body: const Center(child: Text('会话看板（骨架）')),
    );
  }
}
