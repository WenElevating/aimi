import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme.dart';
import '../../data/cache/session_mirror.dart';
import '../../data/protocol/frame_dto.dart';
import '../../domain/model_options.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';
import 'shimmer_line.dart';

export '../../domain/model_options.dart';

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
  if (running) {
    return hasText ? ComposerMode.sendWhileRunning : ComposerMode.interrupt;
  }
  return ComposerMode.sendIdle;
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
  /// @param permissionCeiling - 旧服务端权限上限（未提供时只展示默认档）
  /// @param permissionOptions - 服务端当前会话能力目录，优先于旧版上限
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
    this.inputEnabled,
    this.modelEnabled = true,
    this.modelOptions = aimiModelOptions,
    this.permissionCeiling,
    this.permissionOptions,
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

  /// 旧服务端权限上限（null=仅默认模式，不推断允许提权）。
  final String? permissionCeiling;

  /// 当前会话的服务端权限能力目录，空列表表示无可切换模式。
  final List<PermissionModeDescriptorDto>? permissionOptions;

  /// 配置类入口（模型/权限 picker）是否可交互（断线禁用）。
  final bool enabled;

  /// 输入与主按钮是否可用；缺省跟随 [enabled]。离线入队场景下调用方传
  /// true——文本先落本地离线队列，连接恢复后由补发服务送出，因此输入
  /// 不应被断线禁用；打断语义离线时由会话页给出「未连接」提示。
  final bool? inputEnabled;

  /// 配置回执尚未返回时仅禁用模型入口，不影响发送或权限操作。
  final bool modelEnabled;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  late final FocusNode _focus = widget.focusNode ?? FocusNode();
  bool _ownsFocus = false;
  bool _hasText = false;

  /// 输入与主按钮的生效开关（显式 inputEnabled 优先于 enabled）。
  bool get _inputEnabled => widget.inputEnabled ?? widget.enabled;

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
      // 参考图风格：白纸画布上的浅灰平舱——surface2 底、无描边、无浮影、
      // 不再磨砂（单层容器，原型 composer-flat：卡即输入区）。
      floating: false,
      frosted: false,
      shadow: false,
      color: ai.surface2,
      borderColor: Colors.transparent,
      padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (widget.queued != null) ...[
            // 待发胶囊滑入（原型 queue-in：180ms 上升淡入）。
            AimiSlideIn(
              child: _QueuedCapsule(
                message: widget.queued!,
                onSendNow: widget.onSendQueued,
                onDelete: widget.onCancelQueued,
              ),
            ),
            const SizedBox(height: AimiSpace.s2),
          ],
          TextField(
            controller: widget.controller,
            focusNode: _focus,
            enabled: _inputEnabled,
            minLines: 1,
            maxLines: 5,
            textInputAction: TextInputAction.send,
            onSubmitted: (_) => _primary(mode),
            style: context.tt.agent.copyWith(color: ai.ink),
            decoration: InputDecoration(
              // 输入直接落在卡面：无井底、无边框，focus 靠光标表达
              //（design.md §4.0——focus 不改填充、不做按钮式跳变）。
              filled: false,
              hintText: '继续派活…',
              hintStyle: context.tt.agent.copyWith(color: ai.ink3),
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 14,
                vertical: 10,
              ),
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
            ),
          ),
          const SizedBox(height: 2),
          Row(
            children: [
              _ModelChip(
                label: modelDisplayName(widget.model, widget.modelOptions),
                onTap: widget.enabled && widget.modelEnabled
                    ? _openModelPicker
                    : null,
              ),
              const SizedBox(width: 4),
              _PermissionButton(
                mode: widget.permissionMode,
                label: _permissionLabel,
                onTap: widget.enabled ? _openPermissionPicker : null,
              ),
              const Spacer(),
              _PrimaryButton(
                mode: mode,
                onPressed: _inputEnabled ? () => _primary(mode) : null,
              ),
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

  /// 只在旧服务端回退到已知三档；缺省上限只能展示默认档。
  List<PermissionModeDescriptorDto> get _permissions {
    final descriptors = widget.permissionOptions;
    if (descriptors != null) return descriptors;
    final tiers = widget.permissionCeiling == null
        ? const [AimiPermTier.ask]
        : AimiPermTier.allowed(widget.permissionCeiling);
    return [
      for (final tier in tiers)
        PermissionModeDescriptorDto(
          id: tier.mode,
          name: tier.label,
          description: '',
          availability: 'available',
        ),
    ];
  }

  /// 采用当前服务端名称；陌生模式展示原始标识，不推断其权限含义。
  String get _permissionLabel =>
      _permissions
          .where((mode) => mode.id == widget.permissionMode)
          .firstOrNull
          ?.name ??
      switch (widget.permissionMode) {
        'default' => '每次询问',
        'acceptEdits' => '自动编辑',
        'bypassPermissions' => '完全放行',
        _ => widget.permissionMode,
      };

  /// 按适配器目录展示说明、可用性和不可用原因；未知能力允许显式申请。
  Future<void> _openPermissionPicker() async {
    final selected = await showAimiPicker<PermissionModeDescriptorDto>(
      context: context,
      title: '权限',
      options: [
        for (final mode in _permissions)
          AimiPickerOption(
            label: mode.name,
            detail: [
              mode.description,
              if (mode.reason != null) mode.reason!,
              if (mode.availability == 'unknown' && mode.reason == null)
                '需由 agent 确认',
            ].where((text) => text.isNotEmpty).join(' · '),
            leading: _permissionIcon(mode.id),
            checked: mode.id == widget.permissionMode,
            disabled: mode.availability == 'unavailable',
            value: mode,
          ),
      ],
    );
    if (selected == null || !mounted) return;
    widget.onConfigure(permissionMode: selected.id);
  }
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
        // 参考图风格：灰舱内裸文字（不再垫同色 surface2 底，按压反馈交给
        // InkWell 的 pill 涟漪）。
        decoration: const BoxDecoration(
          borderRadius: BorderRadius.all(AimiRadius.pill),
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

/// 仅已知模式使用既有图标，其余模式以通用滑块表示，避免误判安全等级。
AimiIconData _permissionIcon(String mode) => switch (mode) {
  'default' => AimiIcons.lock,
  'acceptEdits' => AimiIcons.pen,
  'bypassPermissions' => AimiIcons.key,
  _ => AimiIcons.more,
};

/// 权限圆钮：30px，字形 + 底色同步随档位变化；只给图标，不给文字。
class _PermissionButton extends StatelessWidget {
  const _PermissionButton({
    required this.mode,
    required this.label,
    this.onTap,
  });

  final String mode;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tier = AimiPermTier.fromMode(mode);
    return Semantics(
      button: true,
      label: '权限：$label',
      child: Tooltip(
        message: '权限：$label',
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
                  // 每次询问档不再垫底：permDefaultBg 与灰舱同色（会隐形），
                  // 无底即「中性档」的语义；蓝/红档保留 soft 底以示区别。
                  color: tier == AimiPermTier.ask
                      ? Colors.transparent
                      : ai.permBg(tier),
                  // full 态用 1px 内描边（原型 inset 0 0 0 1px perm-full-line）。
                  border: tier == AimiPermTier.full
                      ? Border.all(color: ai.permFullLine)
                      : Border.all(color: Colors.transparent),
                ),
                alignment: Alignment.center,
                child: AimiIcon(
                  data: _permissionIcon(mode),
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
    final isInterrupt =
        mode == ComposerMode.interrupt || mode == ComposerMode.queued;
    final label = isInterrupt ? '打断' : '发送';
    return Semantics(
      button: true,
      label: label,
      child: Tooltip(
        message: label,
        child: AimiPressable(
          onTap: onPressed,
          scale: 0.94,
          borderRadius: BorderRadius.circular(24),
          child: SizedBox(
            width: 44,
            height: 44,
            child: Center(
              child: Container(
                // 38px 纯黑（暗色反白）：整屏唯一的重色锚点，视线有落点
                //（原型 composer-flat send 38）。
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: onPressed == null ? ai.surface3 : ai.primaryBtnBg,
                ),
                alignment: Alignment.center,
                child: AimiIcon(
                  data: isInterrupt ? AimiIcons.pause : AimiIcons.arrowUp,
                  size: 18,
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
        // 白底胶囊：灰舱内浮起一层（surface2 舱内同色胶囊不可见），无描边。
        decoration: BoxDecoration(
          color: ai.surfaceSolid,
          borderRadius: const BorderRadius.all(AimiRadius.pill),
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
/// 传 [anchorKey] 时面板锚定到该行下方（实机反馈：设置页下拉应跟在触发行
/// 下面，不是弹到屏幕底部）；行下方放不下时翻转到行上方。缺省仍从底部
/// 浮出（会话页 composer 的模型/权限 picker 用这个形态）。
Future<T?> showAimiPicker<T>({
  required BuildContext context,
  required String title,
  required List<AimiPickerOption<T>> options,
  GlobalKey? anchorKey,
}) {
  // 锚定坐标在弹层 pageBuilder 前解析（RenderBox 在源树里，dialog 挂载后
  // 源行仍在树内，但先取好可避免对时序的依赖）。
  // 非空化：闭包内无法提升可空局部，解析失败时回退底部形态（anchor 为 null）。
  final anchorContext = anchorKey?.currentContext;
  final ({double anchorTop, double anchorBottom, double anchorLeft})? anchor =
      switch (anchorContext?.findRenderObject()) {
        final RenderBox box? => (
          anchorTop: box.localToGlobal(Offset.zero).dy,
          anchorBottom: box.localToGlobal(Offset(0, box.size.height)).dy,
          anchorLeft: box.localToGlobal(Offset.zero).dx,
        ),
        _ => null,
      };
  final bottomGap = MediaQuery.viewInsetsOf(context).bottom + 96;
  return showGeneralDialog<T>(
    context: context,
    barrierDismissible: true,
    barrierLabel: '关闭',
    barrierColor: Colors.transparent,
    // 原型 picker-in：180ms 淡入 + 轻微上移（约 6px）。
    transitionDuration: const Duration(milliseconds: 180),
    pageBuilder: (dialogContext, _, _) {
      final ai = dialogContext.ai;
      final surface = Material(
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
              Flexible(
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      for (final option in options)
                        _PickerRow<T>(
                          option: option,
                          onTap: () =>
                              Navigator.of(dialogContext).pop(option.value),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      );
      if (anchor != null) {
        // 锚定形态：LayoutBuilder 里量出面板实际高度再决定行下/行上，避免
        // 固定高度假设在选项换行时翻转错误。
        return Align(
          alignment: Alignment.topCenter,
          child: CustomSingleChildLayout(
            delegate: _AnchorLayout(
              anchorTop: anchor.anchorTop,
              anchorBottom: anchor.anchorBottom,
              horizontal: anchor.anchorLeft,
            ),
            child: surface,
          ),
        );
      }
      return Align(
        alignment: Alignment.bottomCenter,
        child: Padding(
          padding: EdgeInsets.only(left: 12, right: 12, bottom: bottomGap),
          child: surface,
        ),
      );
    },
    transitionBuilder: (context, animation, _, child) {
      final curved = CurvedAnimation(parent: animation, curve: AimiMotion.ease);
      return FadeTransition(
        opacity: curved,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0, 0.02),
            end: Offset.zero,
          ).animate(curved),
          child: child,
        ),
      );
    },
  );
}

/// 锚定行下方的布局：默认面板顶 = 行底 + 8；行下放不下（可用空间不足面板高
/// + 16）则面板底 = 行顶 - 8。水平跟随触发行左缘，右侧留 12 屏边距。
class _AnchorLayout extends SingleChildLayoutDelegate {
  _AnchorLayout({
    required this.anchorTop,
    required this.anchorBottom,
    required this.horizontal,
  });

  final double anchorTop;
  final double anchorBottom;
  final double horizontal;

  @override
  Offset getPositionForChild(Size size, Size childSize) {
    final spaceBelow = size.height - anchorBottom;
    final fitsBelow = childSize.height + 16 <= spaceBelow;
    final top = fitsBelow ? anchorBottom + 8 : anchorTop - childSize.height - 8;
    return Offset(horizontal, top.clamp(8.0, double.infinity));
  }

  @override
  BoxConstraints getConstraintsForChild(BoxConstraints constraints) =>
      BoxConstraints(
        maxWidth: constraints.maxWidth - horizontal - 12,
        maxHeight: constraints.maxHeight - 16,
      );

  @override
  bool shouldRelayout(_AnchorLayout oldDelegate) =>
      anchorTop != oldDelegate.anchorTop ||
      anchorBottom != oldDelegate.anchorBottom ||
      horizontal != oldDelegate.horizontal;
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
                        Text(
                          option.label,
                          style: tt.row.copyWith(
                            fontWeight: FontWeight.w500,
                            color: ai.ink,
                          ),
                        ),
                        if (option.detail != null) ...[
                          const SizedBox(height: 1),
                          Text(
                            option.detail!,
                            style: tt.micro.copyWith(color: ai.ink3),
                          ),
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
    ..showSnackBar(
      SnackBar(
        content: Text(message),
        // 原型 toast 1600ms 自动消失（默认 4s 对复制提示太久）。
        duration: const Duration(milliseconds: 1600),
      ),
    );
}
