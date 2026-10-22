import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:uuid/uuid.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../data/connection/aimi_connection.dart';
import '../../data/protocol/frame_dto.dart';
import '../icons/aimi_icons.dart';
import '../session/composer.dart';
import '../widgets/aimi_primitives.dart';

/// 新建会话页（原型 new-session.html）：只决定「跑什么 / 在哪跑 / 交给谁」。
///
/// 不含权限档位与审批（design.md §2.2 进入前表格）：权限在会话内 composer 上调。
/// 目录预填最近会话的 cwd，聚焦时全选并提供清除，避免从路径中间插入文字拼出坏路径。
class NewSessionScreen extends ConsumerStatefulWidget {
  /// 新建会话页（路由 `/new-session`），不接受额外参数。
  const NewSessionScreen({super.key});

  @override
  ConsumerState<NewSessionScreen> createState() => _NewSessionScreenState();
}

class _NewSessionScreenState extends ConsumerState<NewSessionScreen> {
  final TextEditingController _task = TextEditingController();
  final TextEditingController _cwd = TextEditingController();
  final FocusNode _cwdFocus = FocusNode();
  final FocusNode _taskFocus = FocusNode();

  /// 选定模型（null = 跟随 CLI 默认）。
  String? _model;

  /// 是否正在提交（防重复点击）。
  bool _submitting = false;

  /// 提交失败的原因（页内呈现，不用一次性 SnackBar 藏起来）。
  String? _error;

  @override
  void initState() {
    super.initState();
    // 预填最近一次会话的目录：省去重复输入，同时仍可改。
    final sessions = ref.read(sessionsProvider);
    if (sessions.isNotEmpty) _cwd.text = sessions.first.cwd;
    // 聚焦即全选：让第一次输入直接替换旧路径，而不是插在中间。
    _cwdFocus.addListener(_selectAllOnFocus);
  }

  @override
  void dispose() {
    _cwdFocus.removeListener(_selectAllOnFocus);
    _task.dispose();
    _cwd.dispose();
    _cwdFocus.dispose();
    _taskFocus.dispose();
    super.dispose();
  }

  /// 首次聚焦全选预填内容（用户随后直接输入即可整体替换）。
  void _selectAllOnFocus() {
    if (!_cwdFocus.hasFocus) return;
    if (_cwd.text.isEmpty) return;
    _cwd.selection = TextSelection(
      baseOffset: 0,
      extentOffset: _cwd.text.length,
    );
  }

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    // 保持连接状态订阅活跃：`_online` 走 ref.read，若本页无人 watch，冷进入时
    // provider 停在 AsyncLoading（流不重放订阅前的状态），在线判定恒假。
    ref.watch(connStateProvider);
    return Scaffold(
      backgroundColor: ai.canvas,
      body: AimiPageBackground(
        child: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _header(ai, tt),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                  children: [
                    Text('任务', style: tt.micro.copyWith(color: ai.ink3)),
                    const SizedBox(height: 6),
                    TextField(
                      controller: _task,
                      focusNode: _taskFocus,
                      minLines: 4,
                      maxLines: 8,
                      style: tt.body.copyWith(color: ai.ink),
                      decoration: InputDecoration(
                        hintText: '描述任务目标和期望结果…',
                        hintStyle: tt.body.copyWith(color: ai.ink3),
                        filled: true,
                        fillColor: ai.inputBg,
                        border: OutlineInputBorder(
                          borderRadius: const BorderRadius.all(
                            AimiRadius.inputWell,
                          ),
                          borderSide: BorderSide(color: ai.inputLine),
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: const BorderRadius.all(
                            AimiRadius.inputWell,
                          ),
                          borderSide: BorderSide(color: ai.inputLine),
                        ),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: const BorderRadius.all(
                            AimiRadius.inputWell,
                          ),
                          borderSide: BorderSide(color: ai.lineStrong),
                        ),
                      ),
                    ),
                    const SizedBox(height: AimiSpace.s4),
                    AimiSurface(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 4,
                      ),
                      child: Column(
                        children: [
                          _cwdRow(ai, tt),
                          const Divider(height: 1),
                          _agentRow(ai, tt),
                          const Divider(height: 1),
                          _modelRow(ai, tt),
                        ],
                      ),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: AimiSpace.s3),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 9,
                        ),
                        decoration: BoxDecoration(
                          color: ai.redSoft,
                          borderRadius: const BorderRadius.all(AimiRadius.well),
                        ),
                        child: Text(
                          _error!,
                          style: tt.micro.copyWith(color: ai.red),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                child: SizedBox(
                  height: 50,
                  child: FilledButton(
                    onPressed: _submitting ? null : _start,
                    child: Text(_submitting ? '正在创建…' : '开始'),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// header：返回 + 页面名（不放应用名与 agent 名重复）。
  Widget _header(AimiColors ai, AimiText tt) => Padding(
    padding: const EdgeInsets.fromLTRB(8, 6, 16, 8),
    child: Row(
      children: [
        AimiIconButton(
          icon: AimiIcons.back,
          semanticLabel: '返回',
          onPressed: _submitting ? null : () => context.pop(),
          foreground: ai.ink2,
        ),
        Text('新建会话', style: tt.title),
      ],
    ),
  );

  /// 目录行：mono 值 + 清除 + chevron（手机无文件选择器，直接编辑路径）。
  Widget _cwdRow(AimiColors ai, AimiText tt) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 10),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            AimiIcon(data: AimiIcons.folder, size: 15, color: ai.ink3),
            const SizedBox(width: 8),
            Text('目录', style: tt.meta.copyWith(color: ai.ink2)),
            const Spacer(),
            AimiIconButton(
              icon: AimiIcons.close,
              semanticLabel: '清除目录',
              onPressed: () {
                _cwd.clear();
                _cwdFocus.requestFocus();
              },
              foreground: ai.ink3,
              boxSize: 26,
              iconSize: 12,
            ),
          ],
        ),
        TextField(
          controller: _cwd,
          focusNode: _cwdFocus,
          autocorrect: false,
          enableSuggestions: false,
          style: tt.mono.copyWith(color: ai.ink),
          decoration: InputDecoration(
            hintText: '电脑上的绝对路径',
            hintStyle: tt.mono.copyWith(color: ai.ink3),
            isDense: true,
            filled: true,
            fillColor: ai.inputBg,
            border: OutlineInputBorder(
              borderRadius: const BorderRadius.all(AimiRadius.well),
              borderSide: BorderSide(color: ai.inputLine),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: const BorderRadius.all(AimiRadius.well),
              borderSide: BorderSide(color: ai.inputLine),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: const BorderRadius.all(AimiRadius.well),
              borderSide: BorderSide(color: ai.lineStrong),
            ),
          ),
        ),
      ],
    ),
  );

  /// agent 行：claude 可用；codex 置灰 + 斜杠（三重编码：置灰 + 斜杠 + aria）。
  Widget _agentRow(AimiColors ai, AimiText tt) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Row(
      children: [
        Text('Agent', style: tt.meta.copyWith(color: ai.ink2)),
        const Spacer(),
        _agentChip(label: 'claude', enabled: true, selected: true),
        const SizedBox(width: 6),
        _agentChip(label: 'codex', enabled: false, selected: false),
      ],
    ),
  );

  /// agent chip：不可用时置灰并叠斜杠。
  Widget _agentChip({
    required String label,
    required bool enabled,
    required bool selected,
  }) {
    final ai = context.ai;
    final tt = context.tt;
    return Semantics(
      label: enabled ? label : '$label，暂不可用',
      enabled: enabled,
      selected: selected,
      child: Opacity(
        opacity: enabled ? 1 : 0.42,
        child: Container(
          height: 28,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: selected ? ai.ink : ai.surface2,
            borderRadius: const BorderRadius.all(AimiRadius.pill),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: tt.micro.copyWith(
                  color: selected ? ai.canvas : ai.ink2,
                  fontWeight: FontWeight.w500,
                ),
              ),
              if (!enabled) ...[
                const SizedBox(width: 4),
                AimiIcon(data: AimiIcons.slash, size: 11, color: ai.ink3),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// 模型行：当前值 + chevron，点开与 composer 同一套 picker。
  Widget _modelRow(AimiColors ai, AimiText tt) {
    final name =
        aimiModelOptions
            .where((option) => option.value == _model)
            .map((option) => option.name)
            .firstOrNull ??
        '默认模型';
    return InkWell(
      onTap: _pickModel,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Row(
          children: [
            Text('模型', style: tt.meta.copyWith(color: ai.ink2)),
            const Spacer(),
            Text(name, style: tt.meta.copyWith(color: ai.ink)),
            const SizedBox(width: 4),
            AimiIcon(data: AimiIcons.chevron, size: 13, color: ai.ink3),
          ],
        ),
      ),
    );
  }

  /// 打开模型 picker（与 composer 同一套选项与「选中即关」行为）。
  Future<void> _pickModel() async {
    final selected = await showAimiPicker<AimiModelOption>(
      context: context,
      title: '模型',
      options: [
        for (final option in aimiModelOptions)
          AimiPickerOption(
            label: option.name,
            detail: option.detail,
            checked: option.value == _model,
            value: option,
          ),
      ],
    );
    if (selected == null || !mounted) return;
    setState(() => _model = selected.value);
  }

  /// 创建会话：校验 → 发 session.create（带回填写与首条任务）→ 进会话页。
  Future<void> _start() async {
    final cwd = _cwd.text.trim();
    final task = _task.text.trim();
    if (cwd.isEmpty) {
      setState(() => _error = '请先填写目标目录');
      _cwdFocus.requestFocus();
      return;
    }
    if (task.isEmpty) {
      setState(() => _error = '请描述任务目标和期望结果');
      _taskFocus.requestFocus();
      return;
    }
    final connection = ref.read(connectionProvider);
    if (!_online(connection)) {
      setState(() => _error = '未连接：等徽标恢复后再试');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    final sessionId = await connection!.createSession(
      SessionSpecDto(
        agentId: 'claude',
        cwd: cwd,
        permissionMode: 'default',
        model: _model,
        initialPrompt: task.isEmpty ? null : task,
      ),
    );
    if (!mounted) return;
    if (sessionId == null) {
      setState(() {
        _submitting = false;
        _error = '创建失败：服务端拒绝或超时（检查目录是否存在）';
      });
      return;
    }
    final store = await ref.read(outgoingMessageStoreProvider.future);
    if (!mounted) return;
    final clientId = Uuid().v4();
    store.enqueue(
      clientId: clientId,
      sessionId: sessionId,
      text: task,
      ts: DateTime.now().millisecondsSinceEpoch,
    );
    store.markSent(clientId);
    // 新会话先写本地镜像：welcome 只在连接建立时全量下发，不写的话会话页在
    // 下次 welcome 前读不到 meta.state，起势过渡与 composer 打断态都不会出现。
    final cache = await ref.read(cacheProvider.future);
    if (!mounted) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    cache.noteCreated(
      SessionMetaDto(
        id: sessionId,
        agentId: 'claude',
        cwd: cwd,
        permissionMode: 'default',
        state: 'starting',
        lastSeq: -1,
        createdAt: now,
        updatedAt: now,
        model: _model,
      ),
    );
    _submitting = false;
    context.pushReplacement('/session/$sessionId');
  }

  /// 在线判定（LAN 与 relay 都算在线）。
  bool _online(AimiConnection? connection) {
    if (connection == null) return false;
    final state = ref.read(connStateProvider).value;
    return state == ConnState.onlineLan || state == ConnState.onlineRelay;
  }
}
