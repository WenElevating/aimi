import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../icons/aimi_icons.dart';

/// 会话/连接状态的统一字形表达（design.md §2.3 三重编码：颜色 + 形状 + 动效）。
///
/// 原型用 `32px / 15px` 两级状态气泡；这里把"形状"与"动效"拆开，
/// 让看板行、会话 header、设置页共用同一套语义。
enum AimiStatusShape {
  /// 运行中：呼吸绿点 + 旋转环。
  running,

  /// 等待你（审批/提问）：琥珀点。
  waiting,

  /// 完成：灰色勾。
  done,

  /// 停止：灰色暂停。
  stopped,

  /// 失败：红叉。
  failed,

  /// 空闲/未知：灰点。
  idle,
}

/// 状态字形：圆形底 + 内部字形（或动效），颜色由调用方语义决定。
///
/// 不配文字（design.md §2.3「不配」）；需要文字时由调用方另加 sr-only 语义。
class AimiStatusGlyph extends StatelessWidget {
  /// @param shape - 语义形状
  /// @param size - 气泡边长（看板行 32、会话 header/设置页 16）
  /// @param color - 语义前景色（来自 token）
  const AimiStatusGlyph({
    super.key,
    required this.shape,
    this.size = 32,
    required this.color,
  });

  /// 语义形状。
  final AimiStatusShape shape;

  /// 气泡边长。
  final double size;

  /// 语义前景色（点/勾/环）。
  final Color color;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    // 原型 .status-bubble：32px 方块 + 10px 圆角（不是正圆），图标 16px、环 15px。
    final glyphSize = size * 0.5;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size >= 24 ? 10 : 5),
        color: _tint(ai),
      ),
      alignment: Alignment.center,
      child: switch (shape) {
        // spinner-ring：2px 环、缺一边（原型 border-right-color: transparent）。
        AimiStatusShape.running => SizedBox.square(
            dimension: glyphSize,
            child: CircularProgressIndicator(
              strokeWidth: size >= 24 ? 2 : 1.6,
              valueColor: AlwaysStoppedAnimation<Color>(color),
            ),
          ),
        AimiStatusShape.waiting => AimiBreathingDot(color: color, size: glyphSize * 0.7, halo: ai.amberSoft),
        AimiStatusShape.done => AimiIcon(data: AimiIcons.check, size: glyphSize, color: color),
        AimiStatusShape.stopped => AimiIcon(data: AimiIcons.pause, size: glyphSize, color: color),
        AimiStatusShape.failed => AimiIcon(data: AimiIcons.close, size: glyphSize, color: color),
        AimiStatusShape.idle => Container(
            width: glyphSize * 0.62,
            height: glyphSize * 0.62,
            decoration: BoxDecoration(shape: BoxShape.circle, color: color),
          ),
      },
    );
  }

  /// 气泡底：语义色的低饱和软底（绿/琥珀/红/灰各自一档）。
  Color _tint(AimiColors ai) => switch (shape) {
        AimiStatusShape.running => ai.greenSoft,
        AimiStatusShape.waiting => ai.amberSoft,
        AimiStatusShape.failed => ai.redSoft,
        AimiStatusShape.done || AimiStatusShape.stopped || AimiStatusShape.idle => ai.surface2,
      };
}

/// 呼吸点的动效形态。
enum AimiDotMotion {
  /// 整点透明度呼吸（app.css dot-breathe，运行/连接）。
  breathe,

  /// 光环扩散脉冲：点保持实色，软环 3px→5px 扩散同时淡出
  /// （app.css amber-pulse，等待用户处理）。
  pulse,
}

/// 呼吸点：运行/连接的活体信号（app.css `dot-breathe 2.8s`）。
///
/// reduced-motion 下只渲染静态点（design.md §3.8 关闭所有循环动画）。
class AimiBreathingDot extends StatefulWidget {
  /// @param color - 点色
  /// @param size - 直径
  /// @param halo - 软环色（原型 `0 0 0 3px <soft>`；null 不画环）
  /// @param motion - 动效形态（缺省透明度呼吸）
  const AimiBreathingDot({
    super.key,
    required this.color,
    this.size = 7,
    this.halo,
    this.motion = AimiDotMotion.breathe,
  });

  /// 点色。
  final Color color;

  /// 软环色（通常是同色系的 soft 底）。
  final Color? halo;

  /// 直径。
  final double size;

  /// 动效形态。
  final AimiDotMotion motion;

  @override
  State<AimiBreathingDot> createState() => _AimiBreathingDotState();
}

class _AimiBreathingDotState extends State<AimiBreathingDot> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    // 脉冲用 amber-pulse 周期（2.4s），呼吸用 dot-breathe 周期（2.8s）。
    duration: widget.motion == AimiDotMotion.pulse
        ? AimiMotion.amberPulse
        : AimiMotion.breathe,
  );

  @override
  void initState() {
    super.initState();
    _controller.repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    final dot = Container(
      width: widget.size,
      height: widget.size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: widget.color,
        boxShadow: widget.halo == null ? null : AimiShadow.halo(widget.halo!),
      ),
    );
    if (reduceMotion) return dot;
    // 脉冲形态：点实色不动，软环扩散并淡出（无环时退回呼吸形态）。
    if (widget.motion == AimiDotMotion.pulse && widget.halo != null) {
      return AnimatedBuilder(
        animation: _controller,
        builder: (context, _) {
          final v = _controller.value;
          return Container(
            width: widget.size,
            height: widget.size,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: widget.color,
              boxShadow: <BoxShadow>[
                BoxShadow(
                  color: widget.halo!.withValues(alpha: widget.halo!.a * (1 - v)),
                  spreadRadius: 3 + 2 * v,
                ),
              ],
            ),
          );
        },
      );
    }
    return FadeTransition(
      opacity: Tween<double>(begin: 0.55, end: 1).animate(
        CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
      ),
      child: dot,
    );
  }
}

/// 展开内容的一次性入场（原型 `tool-body-in`：淡入 + 轻微下落 160ms）。
///
/// 原型明确不做高度补间——时间线里高度突变更稳；收起由调用方直接移除节点（即时，
/// 与原型的 `body.hidden = true` 同口径）。reduced-motion 下跳过动画直接呈现终态。
class AimiBodyIn extends StatelessWidget {
  /// @param child - 展开后才挂载的内容（每次挂载播放一次入场）
  const AimiBodyIn({super.key, required this.child});

  /// 入场内容。
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (reduceMotion) return child;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: AimiMotion.bodyIn,
      curve: AimiMotion.ease,
      builder: (context, value, child) => Opacity(
        opacity: value,
        child: Transform.translate(
          offset: Offset(0, -3 * (1 - value)),
          child: child,
        ),
      ),
      child: child,
    );
  }
}

/// 机器声文本：恒用 JetBrainsMono（命令/路径/计数/ID），颜色取调用方语义。
class AimiMono extends StatelessWidget {
  /// @param text - 机器声内容
  /// @param style - 字号档位（缺省 mono）
  /// @param color - 颜色（缺省 ink-2）
  const AimiMono(this.text, {super.key, this.style, this.color, this.maxLines = 1});

  /// 机器声内容。
  final String text;

  /// 字号档位；缺省 `tt.mono`。
  final TextStyle? style;

  /// 颜色；缺省 `ink2`。
  final Color? color;

  /// 最大行数（列表/卡片内单行截断）。
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    final tt = context.tt;
    return Text(
      text,
      maxLines: maxLines,
      overflow: TextOverflow.ellipsis,
      style: (style ?? tt.mono).copyWith(color: color ?? context.ai.ink2),
    );
  }
}

/// 卡片表面：统一圆角 + 1px 发丝线 + 纵深。
///
/// 纵深两级（tokens.css）：
/// - 默认 `shadow-card`（`0 1px 2px .035` + `0 6px 20px .035`）——原型里**每张卡**都有，
///   缺了它卡片就读成平铺色块；
/// - `floating: true` 用 `shadow-float`（大软阴影），只给 composer/picker/sheet/胶囊。
/// `frosted: true` 额外叠半透明表面 + 背景模糊（原型 `backdrop-filter` 口径）。
class AimiSurface extends StatelessWidget {
  /// @param child - 卡内容
  /// @param padding - 内边距
  /// @param radius - 圆角半径（token）
  /// @param floating - 是否使用浮层软阴影
  /// @param frosted - 是否启用磨砂（半透明 + 背景模糊）
  /// @param shadow - 是否绘制阴影（false 用于贴平面的舱体，如 composer）
  /// @param color - 覆盖底色（缺省 surface）
  /// @param gradient - 覆盖渐变（失败工具卡红渐变用；设置后压过 [color]）
  /// @param borderColor - 覆盖边线色（缺省 line）
  const AimiSurface({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AimiSpace.s3),
    this.radius = AimiRadius.card,
    this.floating = false,
    this.frosted = false,
    this.shadow = true,
    this.color,
    this.gradient,
    this.borderColor,
  });

  /// 卡内容。
  final Widget child;

  /// 内边距。
  final EdgeInsetsGeometry padding;

  /// 圆角半径。
  final Radius radius;

  /// 浮层软阴影（--shadow-float）。
  final bool floating;

  /// 磨砂表面（--surface 半透明 + backdrop blur 24 / saturate 1.2）。
  final bool frosted;

  /// 是否绘制阴影；贴平面的舱体（浅灰输入舱等）传 false 保持纯平。
  final bool shadow;

  /// 覆盖底色。
  final Color? color;

  /// 覆盖渐变（渐变语义状态卡用；设置后压过 [color]）。
  final Gradient? gradient;

  /// 覆盖边线色。
  final Color? borderColor;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final shape = BorderRadius.all(radius);
    final surface = Container(
      padding: padding,
      decoration: BoxDecoration(
        // 渐变语义卡（如失败工具卡）不给纯色底，避免盖住渐变首停。
        color: gradient != null
            ? null
            : (color ?? (frosted ? ai.surface : ai.surfaceSolid)),
        gradient: gradient,
        borderRadius: shape,
        border: Border.all(color: borderColor ?? ai.line),
        boxShadow: !shadow
            ? null
            : (floating ? AimiShadow.float(dark) : AimiShadow.card(dark)),
      ),
      child: child,
    );
    if (!frosted) return surface;
    // 磨砂：只模糊卡片背后的内容；系统关闭透明度时退回实心面（无损降级）。
    final reduceTransparency = MediaQuery.maybeOf(context)?.highContrast ?? false;
    if (reduceTransparency) {
      return Container(
        decoration: BoxDecoration(
          color: ai.surfaceSolid,
          borderRadius: shape,
          border: Border.all(color: ai.line),
          boxShadow: !shadow
              ? null
              : (floating ? AimiShadow.float(dark) : AimiShadow.card(dark)),
        ),
        child: Padding(padding: padding, child: child),
      );
    }
    return ClipRRect(
      borderRadius: shape,
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 24, sigmaY: 24),
        child: surface,
      ),
    );
  }
}

/// 阴影 token：与 tokens.css 的 `--shadow-card` / `--shadow-float` / `--shadow-sheet` 对齐。
abstract final class AimiShadow {
  /// 卡片纵深（每张卡默认都有；明暗两套透明度）。
  static List<BoxShadow> card(bool dark) => <BoxShadow>[
        BoxShadow(
          color: Colors.black.withValues(alpha: dark ? 0.22 : 0.035),
          blurRadius: 2,
          offset: const Offset(0, 1),
        ),
        BoxShadow(
          color: Colors.black.withValues(alpha: dark ? 0.32 : 0.035),
          blurRadius: 20,
          offset: const Offset(0, 6),
        ),
      ];

  /// 浮层软阴影（composer / picker / 胶囊）。
  static List<BoxShadow> float(bool dark) => <BoxShadow>[
        BoxShadow(
          color: Colors.black.withValues(alpha: dark ? 0.48 : 0.16),
          blurRadius: 58,
          offset: const Offset(0, 18),
        ),
        BoxShadow(
          color: Colors.black.withValues(alpha: dark ? 0.18 : 0.05),
          blurRadius: 8,
          offset: const Offset(0, 2),
        ),
      ];

  /// sheet 顶部投影（向上投，原型 `0 -18px 60px`）。
  static List<BoxShadow> sheet(bool dark) => <BoxShadow>[
        BoxShadow(
          color: Colors.black.withValues(alpha: dark ? 0.5 : 0.18),
          blurRadius: 60,
          offset: const Offset(0, -18),
        ),
      ];

  /// 呼吸点/状态点的软环（原型 `box-shadow: 0 0 0 3px <soft>`）。
  static List<BoxShadow> halo(Color soft) => <BoxShadow>[
        BoxShadow(color: soft, spreadRadius: 3),
      ];
}

/// 统一按压反馈：原型用 `transform: scale(.995)` / `scale(.94)` + 140ms 过渡，
/// 而不是 Material 的水波。`reduced-motion` 下关闭缩放（只保留底色反馈）。
///
/// 触摸反馈由 Listener 指针事件驱动（不是手势竞技场）：按住滑出组件边界高亮
/// 即淡出、滑回边界内高亮重现（GestureDetector 的 onTapDown/Cancel 做不到
/// 「滑回重现」——手势取消后不会重新触发）；鼠标悬停（MouseRegion）与按压
/// 共用同一视觉态。tap 语义仍归 GestureDetector：滑出边界后松手不算点击。
///
/// 用法：替换需要「按下去有回弹」的 InkWell（行卡、主按钮、picker 行、sheet 按钮）。
/// 子树自带不透明底的面板（审批卡/提问卡）用 [overlayColor]（水洗画在内容上），
/// 透明内容的行/钮用 [pressedColor]（底色画在内容下）。
class AimiPressable extends StatefulWidget {
  /// @param child - 内容
  /// @param onTap - 点击回调；null 表示禁用（不缩放、不响应）
  /// @param scale - 按下时缩放比例（行卡 .995、圆形按钮 .94）
  /// @param borderRadius - 高亮/裁剪圆角
  /// @param pressedColor - 按下时叠加的底色（画在 child 之下；原型 icon-button 用 surface-3）
  /// @param overlayColor - 按下时叠加的覆盖色（画在 child 之上；自带不透明底的卡面用）
  const AimiPressable({
    super.key,
    required this.child,
    this.onTap,
    this.scale = 0.995,
    this.borderRadius,
    this.pressedColor,
    this.overlayColor,
  });

  /// 内容。
  final Widget child;

  /// 点击回调。
  final VoidCallback? onTap;

  /// 按下缩放比例。
  final double scale;

  /// 圆角（高亮与裁剪）。
  final BorderRadius? borderRadius;

  /// 按下底色（child 之下）。
  final Color? pressedColor;

  /// 按下覆盖色（child 之上）。
  final Color? overlayColor;

  @override
  State<AimiPressable> createState() => _AimiPressableState();
}

class _AimiPressableState extends State<AimiPressable> {
  bool _pressed = false;
  bool _hovered = false;

  bool get _enabled => widget.onTap != null;

  /// 指针全局坐标是否落在本组件渲染框内（滑入滑出的判定基准）。
  bool _containsGlobal(Offset global) {
    final box = context.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return false;
    return (box.localToGlobal(Offset.zero) & box.size).contains(global);
  }

  /// 指针事件只驱动视觉状态；tap 语义由 GestureDetector 承担（见类注释）。
  void _handlePointerDown(PointerDownEvent event) => _setPressed(true);

  void _handlePointerMove(PointerMoveEvent event) =>
      _setPressed(_containsGlobal(event.position));

  void _handlePointerUp(PointerUpEvent event) => _setPressed(false);

  void _handlePointerCancel(PointerCancelEvent event) => _setPressed(false);

  void _setPressed(bool value) {
    if (_pressed == value) return;
    setState(() => _pressed = value);
  }

  @override
  Widget build(BuildContext context) {
    final enabled = _enabled;
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    final active = (_pressed || _hovered) && enabled;
    final scale = active && !reduceMotion ? widget.scale : 1.0;
    final radius = widget.borderRadius;
    return MouseRegion(
      onEnter: enabled ? (event) => setState(() => _hovered = true) : null,
      onExit: enabled ? (event) => setState(() => _hovered = false) : null,
      child: Listener(
        onPointerDown: enabled ? _handlePointerDown : null,
        onPointerMove: enabled ? _handlePointerMove : null,
        onPointerUp: enabled ? _handlePointerUp : null,
        onPointerCancel: enabled ? _handlePointerCancel : null,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onTap,
          child: AnimatedScale(
            scale: scale,
            duration: AimiMotion.fast,
            curve: AimiMotion.ease,
            child: AnimatedContainer(
              duration: AimiMotion.fast,
              curve: AimiMotion.ease,
              decoration: BoxDecoration(
                borderRadius: radius,
                color: active ? widget.pressedColor : null,
              ),
              // 覆盖水洗画在 child 之上：子树自带不透明底时 pressedColor 会被盖住。
              foregroundDecoration: widget.overlayColor == null
                  ? null
                  : BoxDecoration(
                      borderRadius: radius,
                      color: active ? widget.overlayColor : null,
                    ),
              child: radius == null ? widget.child : ClipRRect(borderRadius: radius, child: widget.child),
            ),
          ),
        ),
      ),
    );
  }
}

/// 页面背景：画布顶部到画布的中性渐变（tokens.css `.screen` 口径）。
class AimiPageBackground extends StatelessWidget {
  /// @param child - 页面内容
  const AimiPageBackground({super.key, required this.child});

  /// 页面内容。
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: <Color>[ai.canvasTop, ai.canvas],
          stops: const <double>[0, 0.32],
        ),
      ),
      child: child,
    );
  }
}

/// 带最小热区的纯图标按钮（视觉 30-34px，热区 ≥44；design.md §7）。
///
/// [semanticLabel] 必填：纯图标按钮必须有可访问名称。
class AimiIconButton extends StatelessWidget {
  /// @param icon - 图标数据
  /// @param semanticLabel - 可访问名称（同时作为 tooltip）
  /// @param onPressed - 点击回调；null 表示禁用
  /// @param background - 底色（胶囊/圆底）
  /// @param foreground - 图标色
  /// @param boxSize - 视觉方块边长
  /// @param shape - 圆角（缺省圆形）
  const AimiIconButton({
    super.key,
    required this.icon,
    required this.semanticLabel,
    required this.onPressed,
    this.background,
    this.foreground,
    this.boxSize = 30,
    this.shape = const CircleBorder(),
    this.iconSize = 15,
    this.hitSize = 40,
  });

  /// 图标数据。
  final AimiIconData icon;

  /// 可访问名称。
  final String semanticLabel;

  /// 点击回调。
  final VoidCallback? onPressed;

  /// 底色。
  final Color? background;

  /// 图标色。
  final Color? foreground;

  /// 视觉方块边长。
  final double boxSize;

  /// 形状（默认圆形）。
  final ShapeBorder shape;

  /// 图标尺寸。
  final double iconSize;

  /// 热区边长（原型 `.icon-button` 是 40×40；视觉与热区一致）。
  final double hitSize;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final enabled = onPressed != null;
    return Semantics(
      button: true,
      label: semanticLabel,
      enabled: enabled,
      child: Tooltip(
        message: semanticLabel,
        // AimiPressable 而非 InkWell：按钮常嵌在不透明卡/舱内，涟漪被遮挡；
        // 裸图标钮给 surface3 圆形按压底，带底色钮只靠缩放（与主按钮同族）。
        child: AimiPressable(
          onTap: onPressed,
          scale: 0.92,
          borderRadius: shape is CircleBorder
              ? BorderRadius.circular(math.max(boxSize, hitSize) / 2)
              : const BorderRadius.all(AimiRadius.well),
          pressedColor: background == null ? ai.surface3 : null,
          child: SizedBox(
            // 热区：视觉小可以，触控不能小。
            width: math.max(boxSize, hitSize),
            height: math.max(boxSize, hitSize),
            child: Center(
              child: Container(
                width: boxSize,
                height: boxSize,
                decoration: BoxDecoration(
                  shape: shape is CircleBorder ? BoxShape.circle : BoxShape.rectangle,
                  color: background,
                  borderRadius: shape is CircleBorder ? null : BorderRadius.all(AimiRadius.well),
                ),
                alignment: Alignment.center,
                child: AimiIcon(
                  data: icon,
                  size: iconSize,
                  color: enabled ? (foreground ?? ai.ink2) : ai.ink4,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 一次性延迟回调（避免每个调用点重复 `Timer` 与 dispose 样板）。
class AimiDelayed {
  AimiDelayed._();

  /// 在 [duration] 后执行 [action]；返回的 Timer 需由调用方在 dispose 时取消。
  static Timer run(Duration duration, VoidCallback action) => Timer(duration, action);
}

/// 顶部轻提示（原型 toast 的顶部形态）：从状态栏下滑入的 ink 底 pill，自动消失。
///
/// 与 SnackBar 的分工：SnackBar 从底部起、语义是"动作结果"；顶部提示不打断当前
/// 视线（如"已是最新版本"），且**不依赖 ScaffoldMessenger**——更新模态等浮层
/// 场景下 Scaffold 可能不在树内。重复调用时后一条顶掉前一条（同一时刻只展示一条）。
OverlayEntry? _activeTopToast;

/// 弹出顶部轻提示；[duration] 后自动淡出移除。返回的 OverlayEntry 已挂载（测试可等待）。
OverlayEntry showAimiTopToast(
  BuildContext context,
  String message, {
  Duration duration = const Duration(milliseconds: 2000),
}) {
  // 后弹顶掉先弹：先移除旧条目再挂新条目，避免叠影。
  _activeTopToast?.remove();
  _activeTopToast = null;
  final ai = context.ai;
  final tt = context.tt;
  final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
  late final OverlayEntry entry;
  entry = OverlayEntry(
    builder: (toastContext) => _TopToastView(
      message: message,
      background: ai.ink,
      // 前景取对面极性：ink 底上用 canvas 字，亮/暗两模式均保持对比（暗色曾取
      // ai.ink 与背景同色导致文字不可见，feedback #20261025-234028-2465ab）。
      foreground: ai.canvas,
      micro: tt.micro,
      pill: const BorderRadius.all(AimiRadius.pill),
      duration: duration,
      reduceMotion: reduceMotion,
      // 退场完成后由 entry 自身 remove（OverlayState 没有 remove API）。
      onDismissed: () {
        if (_activeTopToast == entry) _activeTopToast = null;
        if (entry.mounted) entry.remove();
      },
    ),
  );
  _activeTopToast = entry;
  Overlay.of(context, rootOverlay: true).insert(entry);
  return entry;
}

/// 顶部提示的视图：入场 180ms 下滑淡入，停留 [duration]，退场 180ms 上滑淡出。
class _TopToastView extends StatefulWidget {
  const _TopToastView({
    required this.message,
    required this.background,
    required this.foreground,
    required this.micro,
    required this.pill,
    required this.duration,
    required this.reduceMotion,
    required this.onDismissed,
  });

  final String message;
  final Color background;
  final Color foreground;
  final TextStyle micro;
  final BorderRadius pill;
  final Duration duration;
  final bool reduceMotion;
  final VoidCallback onDismissed;

  @override
  State<_TopToastView> createState() => _TopToastViewState();
}

class _TopToastViewState extends State<_TopToastView>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 180),
  );

  /// true=入场行程，false=退场行程（同一控制器反向跑）。
  bool _entering = true;

  Timer? _holdTimer;

  @override
  void initState() {
    super.initState();
    if (widget.reduceMotion) {
      _controller.value = 1;
    } else {
      _controller.forward();
    }
    _holdTimer = AimiDelayed.run(widget.duration, _dismiss);
  }

  @override
  void dispose() {
    _holdTimer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  /// 退场：反向播放完毕后回调摘除（reduce-motion 直接摘）。
  void _dismiss() {
    if (!mounted) return;
    _holdTimer?.cancel();
    _holdTimer = null;
    if (widget.reduceMotion) {
      widget.onDismissed();
      return;
    }
    setState(() => _entering = false);
    _controller.reverse().whenComplete(widget.onDismissed);
  }

  @override
  Widget build(BuildContext context) {
    final curved = CurvedAnimation(parent: _controller, curve: AimiMotion.ease);
    return Positioned(
      top: 0,
      left: 0,
      right: 0,
      child: SafeArea(
        child: Align(
          alignment: Alignment.topCenter,
          child: AnimatedBuilder(
            animation: curved,
            builder: (context, child) {
              final value = _entering ? curved.value : 1 - curved.value;
              return Opacity(
                opacity: value,
                child: Transform.translate(
                  offset: Offset(0, -12 * (1 - value)),
                  child: child,
                ),
              );
            },
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: 24),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
              decoration: BoxDecoration(
                color: widget.background,
                borderRadius: widget.pill,
                boxShadow: AimiShadow.float(
                  Theme.of(context).brightness == Brightness.dark,
                ),
              ),
              child: Text(
                widget.message,
                style: widget.micro.copyWith(color: widget.foreground),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 把毫秒时间戳格式化为 `HH:mm`（断线横幅「上次同步 16:38」用）。
String formatClock(int epochMs) {
  final t = DateTime.fromMillisecondsSinceEpoch(epochMs);
  return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}

/// 弹出可停留顶部通知（更新推送的可见面，feedback #20261025-234028-2465ab）。
///
/// 与 [showAimiTopToast] 的分工：toast 是「动作结果」短提示、自动消失；
/// 通知承载需要用户决策的内容——不自动消失，整条可点（[onTap]，通常进设置页），
/// 右侧关闭按钮，点击任一处即收起。同一时刻仅一条，且与 toast 同槽互斥
/// （后弹的顶掉先弹的，避免叠影）。配色由调用方经 [background]/[foreground]/
/// [border] 传入主题 token，明暗两模式自动适配。
OverlayEntry showAimiTopNotice(
  BuildContext context, {
  required String message,
  VoidCallback? onTap,
  Color? background,
  Color? foreground,
  Color? border,
}) {
  // 与 toast 同槽互斥：先移除旧条目再挂新条目。
  _activeTopToast?.remove();
  _activeTopToast = null;
  final ai = context.ai;
  final tt = context.tt;
  final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
  late final OverlayEntry entry;
  entry = OverlayEntry(
    builder: (noticeContext) => _TopNoticeView(
      message: message,
      onTap: onTap,
      background: background ?? ai.greenSoft,
      foreground: foreground ?? ai.ink,
      border: border ?? ai.line,
      micro: tt.micro,
      reduceMotion: reduceMotion,
      onDismissed: () {
        if (_activeTopToast == entry) _activeTopToast = null;
        if (entry.mounted) entry.remove();
      },
    ),
  );
  _activeTopToast = entry;
  Overlay.of(context, rootOverlay: true).insert(entry);
  return entry;
}

/// 可停留顶部通知的视图：入场 180ms 下滑淡入；无停留计时，只有显式关闭。
class _TopNoticeView extends StatefulWidget {
  const _TopNoticeView({
    required this.message,
    required this.onTap,
    required this.background,
    required this.foreground,
    required this.border,
    required this.micro,
    required this.reduceMotion,
    required this.onDismissed,
  });

  final String message;
  final VoidCallback? onTap;
  final Color background;
  final Color foreground;
  final Color border;
  final TextStyle micro;
  final bool reduceMotion;
  final VoidCallback onDismissed;

  @override
  State<_TopNoticeView> createState() => _TopNoticeViewState();
}

class _TopNoticeViewState extends State<_TopNoticeView>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 180),
  );

  @override
  void initState() {
    super.initState();
    if (widget.reduceMotion) {
      _controller.value = 1;
    } else {
      _controller.forward();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// 收起：反向行程完毕后摘除（reduce-motion 直接摘）。
  void _close() {
    if (!mounted) return;
    if (widget.reduceMotion) {
      widget.onDismissed();
      return;
    }
    _controller.reverse().whenComplete(widget.onDismissed);
  }

  @override
  Widget build(BuildContext context) {
    final curved = CurvedAnimation(parent: _controller, curve: AimiMotion.ease);
    // Positioned 左右夹紧给出行宽；Padding 取代 Align 的 margin——行内
    // Expanded 需要有界宽。Material(transparency)：Overlay 条目不在应用的
    // Material 子树内，垫一层兜住文本墨水语境（按压反馈不依赖它——
    // AimiPressable 走 GestureDetector，无 Material 祖先要求）。
    return Positioned(
      top: 0,
      left: 0,
      right: 0,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: AnimatedBuilder(
            animation: curved,
            builder: (context, child) {
              return Opacity(
                opacity: curved.value,
                child: Transform.translate(
                  offset: Offset(0, -12 * (1 - curved.value)),
                  child: child,
                ),
              );
            },
            child: Material(
              type: MaterialType.transparency,
              child: Container(
                decoration: BoxDecoration(
                  color: widget.background,
                  borderRadius: const BorderRadius.all(AimiRadius.pill),
                  border: Border.all(color: widget.border),
                  boxShadow: AimiShadow.float(
                    Theme.of(context).brightness == Brightness.dark,
                  ),
                ),
                child: Row(
                  children: [
                    // 整条可点（文字区吸收点击）；关闭热区在 AimiIconButton 内补足 44。
                    Expanded(
                      child: AimiPressable(
                        onTap: widget.onTap != null
                            ? () {
                                widget.onTap!();
                                _close();
                              }
                            : null,
                        borderRadius: const BorderRadius.all(AimiRadius.pill),
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 9, 0, 9),
                          child: Text(
                            widget.message,
                            style: widget.micro.copyWith(
                              color: widget.foreground,
                            ),
                          ),
                        ),
                      ),
                    ),
                    AimiIconButton(
                      icon: AimiIcons.close,
                      semanticLabel: '关闭通知',
                      onPressed: _close,
                      foreground: widget.foreground,
                      boxSize: 36,
                      iconSize: 13,
                    ),
                    const SizedBox(width: 4),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 把毫秒时间戳转成「刚刚 / N 分钟前」这类相对时间文案（看板行右侧、待批卡）。
///
/// [now] 只供测试注入时钟，缺省取当前时间；传入早于 [millis] 的时刻时各档均不命中，按「刚刚」返回。
String relativeTimeLabel(int millis, {DateTime? now}) {
  final at = DateTime.fromMillisecondsSinceEpoch(millis);
  final diff = (now ?? DateTime.now()).difference(at);
  if (diff.inSeconds < 60) return '刚刚';
  if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
  if (diff.inHours < 24) return '${diff.inHours} 小时前';
  return '${diff.inDays} 天前';
}
