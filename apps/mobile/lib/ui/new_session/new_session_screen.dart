import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class NewSessionScreen extends StatelessWidget {
  const NewSessionScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('新建会话')),
    body: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const TextField(
            maxLines: 3,
            decoration: InputDecoration(
              hintText: '要做什么？',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          const ListTile(
            leading: Icon(Icons.folder_outlined),
            title: Text('工作目录'),
            subtitle: Text('在会话中选择电脑目录'),
          ),
          const ListTile(
            leading: Icon(Icons.smart_toy_outlined),
            title: Text('Agent'),
            subtitle: Text('claude'),
          ),
          const ListTile(
            leading: Icon(Icons.memory_outlined),
            title: Text('模型'),
            subtitle: Text('Opus 4.6'),
          ),
          const Spacer(),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: () => context.pop(),
              icon: const Icon(Icons.play_arrow),
              label: const Text('开始'),
            ),
          ),
        ],
      ),
    ),
  );
}
