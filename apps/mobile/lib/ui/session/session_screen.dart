import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../app/providers.dart';
import '../../data/connection/aimi_connection.dart';
import '../../data/protocol/frame_dto.dart';
import '../../domain/session_view.dart';
import '../widgets/timeline_view.dart';

/// 会话时间线：事件流渲染 + 发送 + 打断。
///
/// 只读 provider 快照（`sessionEventsProvider` → `timelineOf`），不做本地状态；
/// 唯一的本地状态是输入框文本。
class SessionScreen extends ConsumerStatefulWidget {
  /// [sessionId] 来自路由 `/session/:id`。
  const SessionScreen({super.key, required this.sessionId});

  /// 会话 id（server 生成）。
  final String sessionId;

  @override
  ConsumerState<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends ConsumerState<SessionScreen> {
  final TextEditingController _input = TextEditingController();

  static const Uuid _uuid = Uuid();

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  /// 标题只展示 id 前 8 位（完整 id 在 M0 无展示价值，保留空间给状态）。
  String get _shortId => widget.sessionId.length <= 8
      ? widget.sessionId
      : widget.sessionId.substring(0, 8);

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    if (!_ensureOnline()) return;
    // clientId 由手机生成：断线重发同一命令时 server 据此幂等去重（异常 #7）。
    await ref.read(connectionProvider)!.sendCommand(
          widget.sessionId,
          _uuid.v4(),
          AgentCommandDto.send(text),
        );
    _input.clear();
  }

  Future<void> _interrupt() async {
    if (!_ensureOnline()) return;
    await ref.read(connectionProvider)!.sendCommand(
          widget.sessionId,
          _uuid.v4(),
          const InterruptCommandDto(),
        );
  }

  /// 未在线时不发包（T14 的 `sendCommand` 对离线是静默丢弃，回执在 M1 才有）——宁可显式告知，
  /// 也不让用户以为消息已经发出去。
  bool _ensureOnline() {
    if (ref.read(connectionProvider) == null) {
      _snack('未配置连接：请到设置填地址与令牌');
      return false;
    }
    if (ref.read(connStateProvider).value != ConnState.onlineLan) {
      _snack('未连接：消息未发出（等连接恢复后再发）');
      return false;
    }
    return true;
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final items = timelineOf(ref.watch(sessionEventsProvider(widget.sessionId)));

    return Scaffold(
      appBar: AppBar(
        title: Text(_shortId),
        actions: [
          IconButton(
            tooltip: '打断',
            icon: Icon(
              Icons.stop_circle_outlined,
              color: Theme.of(context).colorScheme.error,
            ),
            onPressed: _interrupt,
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: items.isEmpty
                ? const Center(child: Text('还没有事件'))
                : TimelineView(items: items),
          ),
          const Divider(height: 1),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 4,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _send(),
                      decoration: const InputDecoration(
                        hintText: '给 agent 发消息',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '发送',
                    icon: const Icon(Icons.send),
                    onPressed: _send,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
