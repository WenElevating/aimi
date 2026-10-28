import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../data/protocol/frame_dto.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';

/// 电脑目录浏览页：只显示服务端返回的子目录，选择结果回传给新建会话页。
class DirectoryPickerScreen extends ConsumerStatefulWidget {
  const DirectoryPickerScreen({super.key, this.initialPath});
  final String? initialPath;

  @override
  ConsumerState<DirectoryPickerScreen> createState() =>
      _DirectoryPickerScreenState();
}

class _DirectoryPickerScreenState extends ConsumerState<DirectoryPickerScreen> {
  String _path = '';
  String? _parent;
  List<DirectoryEntryDto> _entries = const [];
  String? _error;
  bool _loading = true;
  int _request = 0;
  String _requestedPath = '';
  bool _hasValidSelection = false;

  @override
  void initState() {
    super.initState();
    _load(widget.initialPath ?? '');
  }

  /// 请求期间禁用确认，失败后不允许误选之前加载的旧目录。
  Future<void> _load(String path) async {
    final request = ++_request;
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
        _requestedPath = path;
        _hasValidSelection = false;
      });
    }
    final connection = ref.read(connectionProvider);
    final result = await connection?.listDirectory(path);
    if (!mounted || request != _request) return;
    setState(() {
      _loading = false;
      if (result == null || result.error != null) {
        _error = _errorText(result?.error);
        return;
      }
      _path = result.path ?? path;
      _parent = result.parent;
      _entries = result.entries ?? const [];
      _hasValidSelection = _path.isNotEmpty;
    });
  }

  /// 区分旧电脑端、网络状态与文件系统错误，避免误导用户反复检查连接。
  String _errorText(String? error) => switch (error) {
    'unsupported' => '电脑端需要更新，暂时请返回手动填写目录',
    'offline' => '电脑已断开连接，请连接后重试',
    'timeout' => '电脑响应超时，请重试',
    'io_error' => '电脑读取目录失败，请重试',
    'not_found' => '目录不存在',
    'permission_denied' => '没有权限读取此目录',
    'not_directory' => '路径不是目录',
    'invalid_path' => '目录路径无效',
    // 未知错误码（含服务端未来新增的码）不得断言连接状态——误报「已断开」
    // 会把用户引向无意义的重连排查（feedback #20261025-192751-348465②）。
    _ => '读取目录失败，请重试',
  };

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Scaffold(
      backgroundColor: ai.canvas,
      body: AimiPageBackground(
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 6, 16, 8),
                child: Row(
                  children: [
                    AimiIconButton(
                      icon: AimiIcons.back,
                      semanticLabel: '返回',
                      onPressed: () => context.pop(),
                      foreground: ai.ink2,
                    ),
                    Text('选择目录', style: tt.title),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 4,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        _path.isEmpty ? '电脑目录' : _path,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: tt.mono.copyWith(color: ai.ink2),
                      ),
                    ),
                    if (_path.isNotEmpty || _error != null)
                      TextButton(
                        onPressed: _loading ? null : () => _load(''),
                        child: const Text('电脑根目录'),
                      ),
                    if (_parent != null)
                      AimiIconButton(
                        icon: AimiIcons.back,
                        semanticLabel: '上一级',
                        onPressed: _loading ? null : () => _load(_parent!),
                        foreground: ai.ink2,
                      ),
                  ],
                ),
              ),
              Expanded(child: _body(ai, tt)),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                child: SizedBox(
                  width: double.infinity,
                  height: 50,
                  child: FilledButton(
                    onPressed: _loading || !_hasValidSelection
                        ? null
                        : () => context.pop(_path),
                    child: const Text('选择此目录'),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 加载、错误与空目录分开呈现，错误提供原路径重试。
  Widget _body(AimiColors ai, AimiText tt) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(_error!, style: tt.body.copyWith(color: ai.red)),
              const SizedBox(height: 12),
              TextButton(
                onPressed: () => _load(_requestedPath),
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }
    if (_entries.isEmpty) {
      return Center(
        child: Text('此目录没有子目录', style: tt.body.copyWith(color: ai.ink3)),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
      itemCount: _entries.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (_, index) {
        final entry = _entries[index];
        return ListTile(
          leading: AimiIcon(data: AimiIcons.folder, size: 18, color: ai.ink3),
          title: Text(entry.name, style: tt.body.copyWith(color: ai.ink)),
          onTap: () => _load(entry.path),
        );
      },
    );
  }
}
