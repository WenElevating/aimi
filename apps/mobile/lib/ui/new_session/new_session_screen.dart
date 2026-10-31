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
  /// 选中的 agentId：来自 welcome.agents 投影（服务端探测面），缺省取第一个可用 agent。
  String? _agentId;

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
                          Builder(builder: (context) {
                            final agents = ref.watch(agentCapabilitiesProvider);
                            // 默认选中首个 agent（claude 优先即注册序首位的现状保持）。
                            if (_agentId == null && agents.isNotEmpty) {
                              WidgetsBinding.instance.addPostFrameCallback((_) {
                                if (mounted && _agentId == null) {
                                  setState(() => _agentId = agents.first.id);
                                }
                              });
                            }
                            return _agentRow(ai, tt, agents);
                          }),
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
            AimiIconButton(
              icon: AimiIcons.folder,
              semanticLabel: '浏览电脑目录',
              onPressed: _submitting ? null : _pickDirectory,
              foreground: ai.ink3,
              boxSize: 26,
              iconSize: 15,
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

  /// agent 行：芯片来自 welcome.agents 投影（服务端探测面，装了才出现）；单选。
  /// agent 行（design.md §5：行内下拉，右侧当前值；一行只决定一件事）。
  /// 清单来自 welcome.agents 投影（服务端探测面，装了才出现）。
  Widget _agentRow(AimiColors ai, AimiText tt, List<AgentCapabilityDto> agents) {
    final selectedId = _agentId ?? agents.firstOrNull?.id;
    final selectedLabel =
        agents.where((agent) => agent.id == selectedId).firstOrNull?.label ?? '默认';
    return InkWell(
      onTap: _submitting || agents.isEmpty
          ? null
          : () async {
              final selected = await showAimiPicker<AgentCapabilityDto>(
                context: context,
                title: 'Agent',
                options: [
                  for (final agent in agents)
                    AimiPickerOption(
                      label: agent.label,
                      checked: agent.id == selectedId,
                      value: agent,
                    ),
                ],
              );
              if (selected == null || !mounted || selected.id == _agentId) return;
              setState(() {
                _agentId = selected.id;
                _model = null; // 模型清单随 agent 走：切换后重置，避免把 claude 清单带给 zcode
              });
            },
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Row(
          children: [
            Text('Agent', style: tt.meta.copyWith(color: ai.ink2)),
            const Spacer(),
            Text(selectedLabel, style: tt.meta.copyWith(color: ai.ink)),
            const SizedBox(width: 4),
            AimiIcon(data: AimiIcons.chevron, size: 13, color: ai.ink3),
          ],
        ),
      ),
    );
  }

  /// 模型行：当前值 + chevron，点开与 composer 同一套 picker。
  Widget _modelRow(AimiColors ai, AimiText tt) {
    if (_agentId != null && _agentId != 'claude') {
      // 非 claude agent：模型清单来自其 welcome.agents 投影（value 编码 providerId:modelId，
      // create 时随 spec 下发）；不选 = 跟随该 agent 的全局配置。
      final options = ref
          .watch(agentCapabilitiesProvider)
          .where((agent) => agent.id == _agentId)
          .firstOrNull?.models
          .map(
            (m) => AimiModelOption(
              name: m.name,
              detail: m.detail ?? '',
              value: m.value,
              group: m.group,
            ),
          )
          .toList() ??
          const <AimiModelOption>[];
      final name = _model == null ? '跟随 agent 配置' : modelDisplayName(_model, options);
      return InkWell(
        onTap: _submitting || options.isEmpty ? null : () => _pickModel(options),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Row(
            children: [
              Text('模型', style: tt.meta.copyWith(color: ai.ink2)),
              const Spacer(),
              Text(name, style: tt.meta.copyWith(color: options.isEmpty ? ai.ink3 : ai.ink)),
              if (options.isNotEmpty) ...[
                const SizedBox(width: 4),
                AimiIcon(data: AimiIcons.chevron, size: 13, color: ai.ink3),
              ],
            ],
          ),
        ),
      );
    }
    final name = modelDisplayName(_model, ref.watch(modelOptionsProvider));
    return InkWell(
      onTap: _submitting ? null : _pickModel,
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
  /// 多供应商清单（group 非空）按供应商分段渲染（组头 = provider 名），行内不重复供应商名。
  Future<void> _pickModel([List<AimiModelOption>? overrideOptions]) async {
    if (_submitting) return;
    final List<AimiModelOption> options = overrideOptions ?? ref.read(modelOptionsProvider);
    final grouped = <String, List<AimiModelOption>>{};
    for (final option in options) {
      final key = option.group ?? '';
      if (key.isEmpty) continue;
      grouped.putIfAbsent(key, () => <AimiModelOption>[]).add(option);
    }
    final groups = grouped.isEmpty
        ? null
        : <AimiPickerGroup<AimiModelOption>>[
            for (final entry in grouped.entries)
              AimiPickerGroup(
                header: entry.key,
                options: [
                  for (final option in entry.value)
                    AimiPickerOption(
                      label: option.name,
                      checked: option.value == _model,
                      value: option,
                    ),
                ],
              ),
          ];
    final selected = await showAimiPicker<AimiModelOption>(
      context: context,
      title: '模型',
      groups: groups,
      options: [
        for (final option in options)
          AimiPickerOption(
            label: option.name,
            detail: option.group == null ? option.detail : null,
            checked: option.value == _model,
            value: option,
          ),
      ],
    );
    if (selected == null || !mounted || _submitting) {
      return;
    }
    setState(() => _model = selected.value);
  }

  /// 打开电脑目录浏览页；手动输入路径作为无连接/旧服务端兼容入口保留。
  Future<void> _pickDirectory() async {
    final selected = await context.push<String>(
      '/new-session/directory?path=${Uri.encodeComponent(_cwd.text.trim())}',
    );
    if (selected is String && mounted && selected.isNotEmpty) {
      setState(() => _cwd.text = selected);
    }
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
    final model = _model;
    final agentId = _agentId ?? 'claude';
    setState(() {
      _submitting = true;
      _error = null;
    });
    final sessionId = await connection!.createSession(
      SessionSpecDto(
        agentId: agentId,
        cwd: cwd,
        permissionMode: agentId == 'zcode' ? 'edit' : 'default',
        model: model,
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
        agentId: agentId,
        cwd: cwd,
        permissionMode: agentId == 'zcode' ? 'edit' : 'default',
        state: 'starting',
        lastSeq: -1,
        createdAt: now,
        updatedAt: now,
        model: model,
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
