import 'package:flutter/material.dart';

/// 会话时间线（T15 实现完整时间线；M0 骨架占位）。
class SessionScreen extends StatelessWidget {
  const SessionScreen({super.key, required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('会话 $sessionId')),
      body: const Center(child: Text('时间线（骨架）')),
    );
  }
}
