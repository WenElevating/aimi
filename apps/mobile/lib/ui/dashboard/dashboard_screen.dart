import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../data/connection/aimi_connection.dart';
import '../../data/protocol/frame_dto.dart';
import '../../domain/session_view.dart';
import '../widgets/state_badge.dart';

/// 会话看板：连接徽标 + 重连提示条 + 会话卡列表 + 新建会话。
///
/// 数据来源全部是 provider 的同步快照（`sessionsProvider`/`sessionEventsProvider`），
/// 这些 provider 由 `cacheTicksProvider` 在事件/连接变化后触发重读——`SessionCache` 没有
/// 变更流（T14 冻结接口），故用小部件不做任何轮询。
class DashboardScreen extends ConsumerWidget {
  /// 无参构造（路由 `/`）。
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final conn = ref.watch(connStateProvider).value ?? ConnState.offline;
    final endpoints = ref.watch(endpointsProvider);
    final configured = endpoints.value != null;
    final sessions = ref.watch(sessionsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('aimi'),
        actions: [
          StateBadge(state: conn.name),
          IconButton(
            tooltip: '设置',
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => context.push('/settings'),
          ),
        ],
      ),
      body: Column(
        children: [
          // T14 移交必办：M0 无事件重放，重连期间的增量永久丢失，必须常驻告知用户。
          if (conn == ConnState.reconnecting) const _ReconnectingBanner(),
          Expanded(
            child: !configured
                ? const _NotConfiguredGuide()
                : sessions.isEmpty
                    ? const _EmptySessionsGuide()
                    : ListView.builder(
                        itemCount: sessions.length,
                        itemBuilder: (context, index) => _SessionCard(
                          meta: sessions[index],
                        ),
                      ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _createSession(context, ref, sessions),
        icon: const Icon(Icons.add),
        label: const Text('新建会话'),
      ),
    );
  }

  /// 弹层收参数 → `session.create` → 成功 push 时间线，失败 SnackBar 说明原因。
  ///
  /// `createSession` 只回 sessionId 或 null（T14 冻结签名），故失败原因只能分两类：
  /// 未在线（本地判定）/ 服务端拒绝或超时。
  Future<void> _createSession(
    BuildContext context,
    WidgetRef ref,
    List<SessionMetaDto> sessions,
  ) async {
    final defaultCwd = sessions.isEmpty ? '' : sessions.first.cwd;
    final request = await showModalBottomSheet<_NewSessionRequest>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _NewSessionSheet(initialCwd: defaultCwd),
    );
    if (request == null || !context.mounted) return;

    final connection = ref.read(connectionProvider);
    if (connection == null ||
        ref.read(connStateProvider).value != ConnState.onlineLan) {
      _snack(context, '未连接：请到设置检查地址与令牌，等徽标变为 LAN 再试');
      return;
    }

    final sessionId = await connection.createSession(
      SessionSpecDto(
        agentId: 'claude',
        cwd: request.cwd,
        permissionMode: 'default',
        initialPrompt: request.prompt.isEmpty ? null : request.prompt,
      ),
    );
    if (!context.mounted) return;
    if (sessionId == null) {
      _snack(context, '创建失败：服务端拒绝或超时（检查目标目录是否存在）');
      return;
    }
    context.push('/session/$sessionId');
  }

  void _snack(BuildContext context, String message) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}

/// 重连常驻提示条（细条 + 橙底；不可省略——M0 无重放）。
class _ReconnectingBanner extends StatelessWidget {
  const _ReconnectingBanner();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: Colors.orange.withValues(alpha: 0.18),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: const Row(
        children: [
          Icon(Icons.wifi_off_outlined, size: 14, color: Colors.orange),
          SizedBox(width: 6),
          Expanded(
            child: Text(
              '重连中，可能错过消息',
              style: TextStyle(fontSize: 12, color: Colors.orange),
            ),
          ),
        ],
      ),
    );
  }
}

/// 未配置态：引导去设置（M0 手填 host/port/token）。
class _NotConfiguredGuide extends StatelessWidget {
  const _NotConfiguredGuide();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.link_off, size: 40),
            const SizedBox(height: 12),
            const Text('先去设置填地址与令牌'),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: () => context.push('/settings'),
              child: const Text('打开设置'),
            ),
          ],
        ),
      ),
    );
  }
}

/// 已连接但没有任何会话。
class _EmptySessionsGuide extends StatelessWidget {
  const _EmptySessionsGuide();

  @override
  Widget build(BuildContext context) {
    return const Center(child: Text('还没有会话，点右下角「新建会话」'));
  }
}

/// 会话卡：agent 标签 + 状态徽标 + 最近文本摘要 + 相对时间。
class _SessionCard extends ConsumerWidget {
  const _SessionCard({required this.meta});

  final SessionMetaDto meta;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(sessionEventsProvider(meta.id));
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: ListTile(
        title: Row(
          children: [
            Text(meta.agentId, style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            StateBadge(state: meta.state, compact: true),
          ],
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(
            dashboardSubtitle(events, meta.state),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 12),
          ),
        ),
        trailing: Text(
          relativeTimeLabel(meta.updatedAt),
          style: const TextStyle(fontSize: 11),
        ),
        onTap: () => context.push('/session/${meta.id}'),
      ),
    );
  }
}

/// 新建会话弹层的返回值（弹层本身不碰 provider/网络，只收参数）。
class _NewSessionRequest {
  const _NewSessionRequest({required this.cwd, required this.prompt});

  final String cwd;
  final String prompt;
}

/// 新建会话弹层：agent 固定 claude（M0 唯一 agent）；cwd 手输（默认取最近一个会话的目录）。
class _NewSessionSheet extends StatefulWidget {
  const _NewSessionSheet({required this.initialCwd});

  final String initialCwd;

  @override
  State<_NewSessionSheet> createState() => _NewSessionSheetState();
}

class _NewSessionSheetState extends State<_NewSessionSheet> {
  late final TextEditingController _cwd =
      TextEditingController(text: widget.initialCwd);
  final TextEditingController _prompt = TextEditingController();

  @override
  void dispose() {
    _cwd.dispose();
    _prompt.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.viewInsetsOf(context).bottom + 16,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('新建会话', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          const SizedBox(height: 12),
          const Text('agent：claude（M0 固定）', style: TextStyle(fontSize: 12)),
          const SizedBox(height: 12),
          TextField(
            controller: _cwd,
            decoration: const InputDecoration(
              labelText: '目标目录（电脑上的绝对路径）',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _prompt,
            minLines: 2,
            maxLines: 4,
            decoration: const InputDecoration(
              labelText: '任务描述（可选）',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton(
              onPressed: () {
                final cwd = _cwd.text.trim();
                if (cwd.isEmpty) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('请先填写目标目录')),
                  );
                  return;
                }
                Navigator.of(context).pop(
                  _NewSessionRequest(cwd: cwd, prompt: _prompt.text.trim()),
                );
              },
              child: const Text('创建'),
            ),
          ),
        ],
      ),
    );
  }
}

/// `updatedAt`（server 毫秒时间戳）→ 相对时间文案（看板卡右侧）。
String relativeTimeLabel(int millis, {DateTime? now}) {
  final at = DateTime.fromMillisecondsSinceEpoch(millis);
  final diff = (now ?? DateTime.now()).difference(at);
  if (diff.inSeconds < 60) return '刚刚';
  if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
  if (diff.inHours < 24) return '${diff.inHours} 小时前';
  return '${diff.inDays} 天前';
}
