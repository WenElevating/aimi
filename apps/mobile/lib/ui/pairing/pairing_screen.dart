import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class PairingScreen extends StatelessWidget {
  const PairingScreen({super.key, required this.scan});
  final bool scan;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(scan ? '扫码配对' : '手动配对')),
    body: Padding(
      padding: const EdgeInsets.all(20),
      child: scan
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.qr_code_2, size: 120),
                  const SizedBox(height: 16),
                  const Text('将电脑端二维码放入取景框'),
                  const SizedBox(height: 20),
                  OutlinedButton(
                    onPressed: () => context.pop(),
                    child: const Text('返回'),
                  ),
                ],
              ),
            )
          : const _ManualPairForm(),
    ),
  );
}

class _ManualPairForm extends StatelessWidget {
  const _ManualPairForm();

  @override
  Widget build(BuildContext context) => const Column(
    children: [
      TextField(
        decoration: InputDecoration(
          labelText: '服务器地址',
          border: OutlineInputBorder(),
        ),
      ),
      SizedBox(height: 12),
      TextField(
        decoration: InputDecoration(
          labelText: '8 位配对码',
          border: OutlineInputBorder(),
        ),
      ),
      SizedBox(height: 16),
      SizedBox(
        width: double.infinity,
        child: FilledButton(onPressed: null, child: Text('连接')),
      ),
    ],
  );
}
