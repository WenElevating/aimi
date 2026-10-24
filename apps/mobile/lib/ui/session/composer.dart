import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme.dart';
import '../../data/cache/session_mirror.dart';
import '../../data/protocol/frame_dto.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';

/// composer 的四态（design.md §3.1，单主按钮随状态切换）。
enum ComposerMode {
  /// 运行中 + 输入为空 → 主按钮 = 打断。
  interrupt,

  /// 运行中 + 输入非空 → 主按钮 = 发送（点击进入待发胶囊）。
  sendWhileRunning,

  /// 存在待发消息 → 主按钮 = 打断；胶囊上有 ↑ / 垃圾桶。
  queued,

  /// 空闲 → 主按钮 = 发送（立即发送）。
  sendIdle,
}

/// 派生 composer 当前状态（纯函数，便于单测四态转换）。
///
/// - 会话处于运行/启动中且输入为空 → [ComposerMode.interrupt]
/// - 会话处于运行/启动中且输入非空 → [ComposerMode.sendWhileRunning]
/// - 有待发消息 → [ComposerMode.queued]（优先级高于输入非空：待发消息需要被看见）
/// - 其余（空闲/终态）→ [ComposerMode.sendIdle]
ComposerMode composerModeOf({
  required bool running,
  required bool hasText,
  required bool hasQueued,
}) {
  if (hasQueued) return ComposerMode.queued;
  if (running) return hasText ? ComposerMode.sendWhileRunning : ComposerMode.interrupt;
  return ComposerMode.sendIdle;
}

/// 模型清单项（原型 model.html 三条；名字 + 一行差异）。
class AimiModelOption {
  /// @param name - chip 上显示的名字
  /// @param detail - picker 行的一行差异说明
  /// @param value - 传给 `configure.model` 的值；null = 跟随 CLI 默认
  const AimiModelOption({required this.name, required this.detail, this.value});

  /// 显示名。
  final String name;

  /// 一行差异（picker 里唯一允许的说明文字）。
  final String detail;

  /// 协议值。
  final String? value;
}

/// 内置回退模型清单（服务端未下发 agents 投影时使用；与服务端回退清单逐字一致）。
const List<AimiModelOption> aimiModelOptions = <AimiModelOption>[
  AimiModelOption(name: 'Opus 4.6', detail: '最强推理，适合复杂重构', value: 'opus'),
  AimiModelOption(name: 'Sonnet 4.6', detail: '均衡，适合多数任务', value: 'sonnet'),
  AimiModelOption(name: 'Haiku 4.5', detail: '最快，适合小改动', value: 'haiku'),
];

/// 服务端下发的模型清单 → picker 选项；未下发/空清单回退内置三条。
List<AimiModelOption> modelOptionsFromCaps(List<AgentModelOptionDto>? models) {
  if (models == null || models.isEmpty) return aimiModelOptions;
  return <AimiModelOption>[
    for (final model in models)
      AimiModelOption(name: model.name, detail: model.detail ?? '', value: model.value),
  ];
}

/// 协议值 → picker 显示名：优先清单内匹配；未匹配（自定义值/CLI 实测名）剥 `[...]` 后缀后原样展示。
String modelDisplayName(String? value, List<AimiModelOption> options) {
  if (value == null || value.isEmpty) return '默认';
  for (final option in options) {
    if (option.value == value) return option.name;
  }
  final bracket = value.indexOf('[');
  return bracket > 0 ? value.substring(0, bracket) : value;
}

/// 会话输入区：浮动卡 + 输入井 + 模型/权限两个独立入口 + 单主按钮 + 待发胶囊。
///
/// 输入框 focus 不改变填充色（design.md §4.0）；主按钮只有一个，随状态切换。
class Composer extends StatefulWidget {
  /// @param controller - 输入文本
  /// @param running - 会话是否运行/启动中
  /// @param queued - 当前待发消息（无则 null）
  /// @param model - 当前模型协议值（null = CLI 默认）
  /// @param permissionMode - 当前权限档位协议值
  /// @param onSend - 立即发送（空闲态）
  /// @param onQueue - 入待发队列（运行中发送）
  /// @param onInterrupt - 打断
  /// @param onSendQueued - 打断并立即发送待发消息
  /// @param onCancelQueued - 删除待发消息
  /// @param onConfigure - 模型/权限变更（走 configure 帧）
  /// @param focusNode - 外部可控焦点（失败行「续接」用）
  /// @param modelOptions - 模型 picker 选项（服务端下发清单；缺省内置回退三条）
  /// @param permissionCeiling - 服务端权限上限（权限 picker 只展示不超过该档位的项；null=全开）
  const Composer({
    super.key,
    required this.controller,
    required this.running,
    required this.queued,
    required this.model,
    required this.permissionMode,
    required this.onSend,
    required this.onQueue,
    required this.onInterrupt,
    required this.onSendQueued,
    required this.onCancelQueued,
    required this.onConfigure,
    this.focusNode,
    this.enabled = true,
    this.modelOptions = aimiModelOptions,
    this.permissionCeiling,
  });

  /// 输入文本控制器。
  final TextEditingController controller;

  /// 会话是否运行/启动中（决定主按钮语义）。
  final bool running;

  /// 待发消息。
  final OutgoingMessage? queued;

  /// 当前模型协议值。
  final String? model;

  /// 当前权限档位协议值。
  final String permissionMode;

  /// 立即发送（空闲态）。
  final void Function(String text) onSend;

  /// 入待发队列（运行中）。
  final void Function(String text) onQueue;

  /// 打断当前回合。
  final VoidCallback onInterrupt;

  /// 打断并立即发送待发消息。
  final VoidCallback onSendQueued;

  /// 删除待发消息。
  final VoidCallback onCancelQueued;

  /// 模型/权限变更。
  final void Function({String? model, String? permissionMode}) onConfigure;

  /// 外部焦点控制。
  final FocusNode? focusNode;

  /// 模型 picker 选项（服务端下发；缺省内置回退）。
  final List<AimiModelOption> modelOptions;

  /// 服务端权限上限（null=未下发，全档位开放）。
  final String? permissionCeiling;

  /// 是否可交互（断线/等待态禁用）。
  final bool enabled;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  late final FocusNode _focus = widget.focusNode ?? FocusNode();
  bool _ownsFocus = false;
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    _ownsFocus = widget.focusNode == null;
    _hasText = widget.controller.text.trim().isNotEmpty;
    widget.controller.addListener(_onTextChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onTextChanged);
    if (_ownsFocus) _focus.dispose();
    super.dispose();
  }

  /// 文本变化只用于重算主按钮语义（四态之一），不触发其它副作用。
  void _onTextChanged() {
    final hasText = widget.controller.text.trim().isNotEmpty;
    if (hasText != _hasText) setState(() => _hasText = hasText);
  }

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final mode = composerModeOf(
      running: widget.running,
      hasText: _hasText,
      hasQueued: widget.queued != null,
    );
    return AimiSurface(
      radius: AimiRadius.composer,
      floating: true,
      frosted: true,
      padding: const EdgeInsets.fromLTRB(10, 8, 8, 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (widget.queued != null) ...[
            _QueuedCapsule(
              message: widget.queued!,
              onSendNow: widget.onSendQueued,
              onDelete: widget.onCancelQueued,
            ),
            const SizedBox(height: AimiSpace.s2),
          ],
          TextField(
            controller: widget.controller,
            focusNode: _focus,
            enabled: widget.enabled,
            minLines: 1,
            maxLines: 5,
            textInputAction: TextInputAction.send,
            onSubmitted: (_) => _primary(mode),
            style: context.tt.agent.copyWith(color: ai.ink),
            decoration: InputDecoration(
              // 输入井内层：比 composer 卡再深一档，focus 不变填充。
              filled: true,
              fillColor: ai.inputBg,
              hintText: '继续派活…',
              hintStyle: context.tt.agent.copyWith(color: ai.ink3),
              contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              border: OutlineInputBorder(
                borderRadius: const BorderRadius.all(AimiRadius.inputWell),
                borderSide: BorderSide(color: ai.inputLine),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: const BorderRadius.all(AimiRadius.inputWell),
                borderSide: BorderSide(color: ai.inputLine),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: const BorderRadius.all(AimiRadius.inputWell),
                borderSide: BorderSide(color: ai.lineStrong),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              _ModelChip(
                label: modelDisplayName(widget.model, widget.modelOptions),
                onTap: widget.enabled ? _openModelPicker : null,
              ),
              const SizedBox(width: 4),
              _PermissionButton(
                mode: widget.permissionMode,
                onTap: widget.enabled ? _openPermissionPicker : null,
              ),
              const Spacer(),
              _PrimaryButton(mode: mode, onPressed: widget.enabled ? () => _primary(mode) : null),
            ],
          ),
        ],
      ),
    );
  }

  /// 主按钮语义（单按钮状态机）。
  void _primary(ComposerMode mode) {
    switch (mode) {
      case ComposerMode.interrupt:
      case ComposerMode.queued:
        widget.onInterrupt();
      case ComposerMode.sendWhileRunning:
        final text = widget.controller.text.trim();
        if (text.isEmpty) return;
        widget.onQueue(text);
        widget.controller.clear();
      case ComposerMode.sendIdle:
        final text = widget.controller.text.trim();
        if (text.isEmpty) return;
        widget.onSend(text);
        widget.controller.clear();
    }
  }

  /// 打开模型 picker（composer 上方浮出，选中即关）；选项来自服务端下发清单（回退内置三条）。
  Future<void> _openModelPicker() async {
    final selected = await showAimiPicker<AimiModelOption>(
      context: context,
      title: '模型',
      options: [
        for (final option in widget.modelOptions)
          AimiPickerOption(
            label: option.name,
            detail: option.detail,
            checked: option.value == widget.model,
            value: option,
          ),
      ],
    );
    if (selected == null || !mounted) return;
    widget.onConfigure(model: selected.value);
  }

  /// 打开权限 picker（上限内档位，保守→放开，选中即关）。
  Future<void> _openPermissionPicker() async {
    final current = AimiPermTier.fromMode(widget.permissionMode);
    final selected = await showAimiPicker<AimiPermTier>(
      context: context,
      title: '权限',
      options: [
        for (final tier in AimiPermTier.allowed(widget.permissionCeiling))
          AimiPickerOption(
            label: tier.label,
            leading: _permIcon(tier),
            leadingBg: context.ai.permBg(tier),
            leadingInk: context.ai.permInk(tier),
            checked: tier == current,
            value: tier,
          ),
      ],
    );
    if (selected == null || !mounted) return;
    widget.onConfigure(permissionMode: selected.mode);
  }

  /// 权限档位 → 固定字形（锁/铅笔/钥匙，design.md §4.4）。
  static AimiIconData _permIcon(AimiPermTier tier) => switch (tier) {
        AimiPermTier.ask => AimiIcons.lock,
        AimiPermTier.autoEdits => AimiIcons.pen,
        AimiPermTier.full => AimiIcons.key,
      };
}

/// 模型 chip：名字 + chevron（收起时只有名字；名字由调用方按清单/实测值解析）。
class _ModelChip extends StatelessWidget {
  const _ModelChip({required this.label, this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return InkWell(
      onTap: onTap,
      borderRadius: const BorderRadius.all(AimiRadius.pill),
      child: Container(
        height: 30,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(
          color: ai.surface2,
          borderRadius: const BorderRadius.all(AimiRadius.pill),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(label, style: tt.micro.copyWith(color: ai.ink2)),
            const SizedBox(width: 3),
            AimiIcon(data: AimiIcons.chevronDown, size: 12, color: ai.ink3),
          ],
        ),
      ),
    );
  }
}

/// 权限圆钮：30px，字形 + 底色同步随档位变化；只给图标，不给文字。
class _PermissionButton extends StatelessWidget {
  const _PermissionButton({required this.mode, this.onTap});

  final String mode;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tier = AimiPermTier.fromMode(mode);
    return Semantics(
      button: true,
      label: '权限：${tier.label}',
      child: Tooltip(
        message: '权限：${tier.label}',
        child: InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: SizedBox(
            width: 44,
            height: 44,
            child: Center(
              child: Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: ai.permBg(tier),
                  // full 态用 1px 内描边（原型 inset 0 0 0 1px perm-full-line）。
                  border: tier == AimiPermTier.full
                      ? Border.all(color: ai.permFullLine)
                      : Border.all(color: Colors.transparent),
                ),
                alignment: Alignment.center,
                child: AimiIcon(
                  data: switch (tier) {
                    AimiPermTier.ask => AimiIcons.lock,
                    AimiPermTier.autoEdits => AimiIcons.pen,
                    AimiPermTier.full => AimiIcons.key,
                  },
                  size: 15,
                  color: ai.permInk(tier),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 主按钮：唯一的主操作，按四态切换字形（发送 ↑ / 打断 pause）。
class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({required this.mode, this.onPressed});

  final ComposerMode mode;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final isInterrupt = mode == ComposerMode.interrupt || mode == ComposerMode.queued;
    final label = isInterrupt ? '打断' : '发送';
    return Semantics(
      button: true,
      label: label,
      child: Tooltip(
        message: label,
        child: AimiPressable(
          onTap: onPressed,
          scale: 0.94,
          borderRadius: BorderRadius.circular(22),
          child: SizedBox(
            width: 44,
            height: 44,
            child: Center(
              child: Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: onPressed == null ? ai.surface3 : ai.primaryBtnBg,
                ),
                alignment: Alignment.center,
                child: AimiIcon(
                  data: isInterrupt ? AimiIcons.pause : AimiIcons.arrowUp,
                  size: 16,
                  color: onPressed == null ? ai.ink4 : ai.primaryBtnInk,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 待发胶囊：44px pill，左时钟 + 单行文本，右侧只有两个图标（↑ / 垃圾桶）。
class _QueuedCapsule extends StatelessWidget {
  const _QueuedCapsule({
    required this.message,
    required this.onSendNow,
    required this.onDelete,
  });

  final OutgoingMessage message;
  final VoidCallback onSendNow;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Semantics(
      liveRegion: true,
      label: '待发消息：${message.text}',
      child: Container(
        height: 44,
        padding: const EdgeInsets.only(left: 12, right: 2),
        decoration: BoxDecoration(
          color: ai.surface2,
          borderRadius: const BorderRadius.all(AimiRadius.pill),
          border: Border.all(color: ai.line),
        ),
        child: Row(
          children: [
            AimiIcon(data: AimiIcons.clock, size: 13, color: ai.ink3),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                message.text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: tt.meta.copyWith(color: ai.ink2),
              ),
            ),
            AimiIconButton(
              icon: AimiIcons.arrowUp,
              semanticLabel: '打断当前回合并发送',
              onPressed: onSendNow,
              background: ai.amberSoft,
              foreground: ai.amberStrong,
              boxSize: 30,
              iconSize: 14,
            ),
            AimiIconButton(
              icon: AimiIcons.trash,
              semanticLabel: '删除待发消息',
              onPressed: onDelete,
              foreground: ai.ink3,
              boxSize: 30,
              iconSize: 14,
            ),
          ],
        ),
      ),
    );
  }
}

/// picker 选项：行 = 可选前导图标 + 标签 + 一行差异 + 选中勾。
class AimiPickerOption<T> {
  /// @param label - 行标签
  /// @param value - 选中后回传的值
  /// @param detail - 一行差异说明（模型清单用；权限清单不写解释）
  /// @param leading - 前导图标（权限三态用）
  /// @param leadingBg - 前导图标底色
  /// @param leadingInk - 前导图标前景
  /// @param checked - 是否为当前选中项
  /// @param disabled - 置灰不可选（如暂不可用的 agent）；detail 作置灰原因提示
  const AimiPickerOption({
    required this.label,
    required this.value,
    this.detail,
    this.leading,
    this.leadingBg,
    this.leadingInk,
    this.checked = false,
    this.disabled = false,
  });

  /// 行标签。
  final String label;

  /// 回传值。
  final T value;

  /// 一行差异说明。
  final String? detail;

  /// 前导图标。
  final AimiIconData? leading;

  /// 前导图标底色。
  final Color? leadingBg;

  /// 前导图标前景。
  final Color? leadingInk;

  /// 是否选中。
  final bool checked;

  /// 置灰不可选（原型 `.dd-item.disabled`）：整行 42% 透明度、不响应点击。
  final bool disabled;
}

/// 从 composer 上方浮出的轻量 picker：无遮罩、无关闭按钮、选中即关（design.md §3.5/§3.6）。
///
/// 用 [showModalBottomSheet] 会带遮罩与关闭钮，不符合原型；因此用
/// `showDialog` + 透明 barrier 的紧凑定位面板实现，点外部即取消。
Future<T?> showAimiPicker<T>({
  required BuildContext context,
  required String title,
  required List<AimiPickerOption<T>> options,
}) {
  return showGeneralDialog<T>(
    context: context,
    barrierDismissible: true,
    barrierLabel: '关闭',
    barrierColor: Colors.transparent,
    transitionDuration: AimiMotion.fast,
    pageBuilder: (dialogContext, _, _) {
      final ai = dialogContext.ai;
      return Align(
        alignment: Alignment.bottomCenter,
        child: Padding(
          padding: EdgeInsets.only(
            left: 12,
            right: 12,
            bottom: MediaQuery.viewInsetsOf(dialogContext).bottom + 96,
          ),
          child: Material(
            color: Colors.transparent,
            child: AimiSurface(
              radius: AimiRadius.picker,
              floating: true,
              color: ai.surfaceSolid,
              padding: const EdgeInsets.all(6),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(10, 6, 10, 4),
                    child: Text(
                      title,
                      style: dialogContext.tt.micro.copyWith(color: ai.ink3),
                    ),
                  ),
                  for (final option in options)
                    _PickerRow<T>(
                      option: option,
                      onTap: () => Navigator.of(dialogContext).pop(option.value),
                    ),
                ],
              ),
            ),
          ),
        ),
      );
    },
    transitionBuilder: (context, animation, _, child) {
      final curved = CurvedAnimation(parent: animation, curve: AimiMotion.ease);
      return FadeTransition(
        opacity: curved,
        child: SlideTransition(
          position: Tween<Offset>(begin: const Offset(0, 0.04), end: Offset.zero).animate(curved),
          child: child,
        ),
      );
    },
  );
}

/// picker 单行：标签 + 可选差异 + 选中勾；`aria-checked` 由 Semantics 暴露。
///
/// disabled 选项整行置灰且不可点（原型 `.dd-item.disabled` + hint「暂不可用」）。
class _PickerRow<T> extends StatelessWidget {
  const _PickerRow({required this.option, required this.onTap});

  final AimiPickerOption<T> option;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final dimmed = option.disabled;
    return Semantics(
      button: !dimmed,
      checked: option.checked,
      inMutuallyExclusiveGroup: true,
      child: Opacity(
        opacity: dimmed ? 0.42 : 1,
        child: InkWell(
          onTap: dimmed ? null : onTap,
          borderRadius: const BorderRadius.all(AimiRadius.row),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  if (option.leading != null) ...[
                    Container(
                      width: 32,
                      height: 32,
                      decoration: BoxDecoration(
                        color: option.leadingBg,
                        borderRadius: const BorderRadius.all(AimiRadius.well),
                      ),
                      alignment: Alignment.center,
                      child: AimiIcon(
                        data: option.leading!,
                        size: 15,
                        color: option.leadingInk ?? ai.ink2,
                      ),
                    ),
                    const SizedBox(width: 10),
                  ],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(option.label, style: tt.row.copyWith(fontWeight: FontWeight.w500, color: ai.ink)),
                        if (option.detail != null) ...[
                          const SizedBox(height: 1),
                          Text(option.detail!, style: tt.micro.copyWith(color: ai.ink3)),
                        ],
                      ],
                    ),
                  ),
                  if (option.checked)
                    AimiIcon(data: AimiIcons.check, size: 15, color: ai.accent),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 复制文本到剪贴板并给出统一提示（command well 的复制动作）。
///
/// [message] 覆盖提示文案；默认「命令已复制」，回合动作行等调用方
/// 传入自己的语境（如「已复制」），不影响既有调用方。
Future<void> copyToClipboard(
  BuildContext context,
  String text, {
  String message = '命令已复制',
}) async {
  await Clipboard.setData(ClipboardData(text: text));
  if (!context.mounted) return;
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}
