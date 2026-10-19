import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.hub_outlined, size: 56),
            const SizedBox(height: 16),
            const Text(
              '连接 aimi',
              style: TextStyle(fontSize: 24, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: () => context.push('/pairing/scan'),
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('扫码配对'),
            ),
            TextButton.icon(
              onPressed: () => context.push('/pairing/manual'),
              icon: const Icon(Icons.edit_outlined),
              label: const Text('手动配对'),
            ),
          ],
        ),
      ),
    ),
  );
}
