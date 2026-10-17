import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../data/connection/aimi_connection.dart';
import '../widgets/state_badge.dart';

/// 设置页（M0 手填连接三要素；M1 换 QR 配对，键名不变）。
///
/// 保存 = 写 secure_storage + `invalidate(endpointsProvider)` → 连接层重建 → 自动连接。
/// 「重新连接」走 `disconnect()` → `connect()`：T14 的 `connect()` 非重入，不可直接重调。
class SettingsScreen extends ConsumerStatefulWidget {
  /// 无参构造（路由 `/settings`）。
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final TextEditingController _host = TextEditingController();
  final TextEditingController _port = TextEditingController();
  final TextEditingController _token = TextEditingController();

  @override
  void initState() {
    super.initState();
    // 已加载的 endpoints（看板已在同一 provider 上等待过）→ 直接回填。
    final endpoints = ref.read(endpointsProvider).value;
    if (endpoints != null) {
      _host.text = endpoints.host;
      _port.text = '${endpoints.port}';
      _token.text = endpoints.token;
    }
  }

  @override
  void dispose() {
    _host.dispose();
    _port.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final host = _host.text.trim();
    final port = int.tryParse(_port.text.trim());
    final token = _token.text.trim();
    if (host.isEmpty || token.isEmpty || port == null || port <= 0 || port > 65535) {
      _snack('请填写完整的 host / 端口(1-65535) / 令牌');
      return;
    }

    final storage = ref.read(secureStorageProvider);
    await storage.write(key: hostStorageKey, value: host);
    await storage.write(key: portStorageKey, value: '$port');
    await storage.write(key: tokenStorageKey, value: token);
    if (!mounted) return;

    // 触发重读：endpoints 变更 → connectionProvider 重建（旧实例 dispose）→ bootstrap 自动连。
    ref.invalidate(endpointsProvider);
    _snack('已保存，返回看板自动连接');
  }

  /// 先断后连（T14：`connect()` 非重入，重复调用会叠加重连链）。
  Future<void> _reconnect() async {
    final connection = ref.read(connectionProvider);
    if (connection == null) {
      _snack('尚未配置地址与令牌');
      return;
    }
    await connection.disconnect();
    await connection.connect();
    _snack('已重新连接');
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final conn = ref.watch(connStateProvider).value ?? ConnState.offline;

    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _host,
            autocorrect: false,
            enableSuggestions: false,
            decoration: const InputDecoration(
              labelText: '主机（电脑的局域网 IP）',
              hintText: '192.168.1.10',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _port,
            keyboardType: TextInputType.number,
            autocorrect: false,
            enableSuggestions: false,
            decoration: const InputDecoration(
              labelText: '端口',
              hintText: '8787',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _token,
            autocorrect: false,
            enableSuggestions: false,
            decoration: const InputDecoration(
              labelText: '令牌',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton(onPressed: _save, child: const Text('保存')),
          const SizedBox(height: 24),
          const Divider(),
          const SizedBox(height: 8),
          Row(
            children: [
              const Text('连接状态：'),
              StateBadge(state: conn.name),
              const Spacer(),
              OutlinedButton(
                onPressed: _reconnect,
                child: const Text('重新连接'),
              ),
            ],
          ),
          const SizedBox(height: 16),
          const Text(
            '令牌从电脑端获取：在电脑上执行 `aimi-server lan-token`，把打印出的地址与令牌填到这里。'
            '（M0 只支持局域网直连；扫码配对在 M1。）',
            style: TextStyle(fontSize: 12),
          ),
        ],
      ),
    );
  }
}
