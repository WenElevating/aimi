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

/// 呼吸点：运行/连接的活体信号（app.css `dot-breathe 2.8s`）。
///
/// reduced-motion 下只渲染静态点（design.md §3.8 关闭所有循环动画）。
class AimiBreathingDot extends StatefulWidget {
  /// @param color - 点色
  /// @param size - 直径
  /// @param halo - 软环色（原型 `0 0 0 3px <soft>`；null 不画环）
  const AimiBreathingDot({super.key, required this.color, this.size = 7, this.halo});

  /// 点色。
  final Color color;

  /// 软环色（通常是同色系的 soft 底）。
  final Color? halo;

  /// 直径。
  final double size;

  @override
  State<AimiBreathingDot> createState() => _AimiBreathingDotState();
}

class _AimiBreathingDotState extends State<AimiBreathingDot> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AimiMotion.breathe,
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
    return FadeTransition(
      opacity: Tween<double>(begin: 0.55, end: 1).animate(
        CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
      ),
      child: dot,
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
  /// @param color - 覆盖底色（缺省 surface）
  const AimiSurface({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AimiSpace.s3),
    this.radius = AimiRadius.card,
    this.floating = false,
    this.frosted = false,
    this.color,
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

  /// 覆盖底色。
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final shape = BorderRadius.all(radius);
    final surface = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color ?? (frosted ? ai.surface : ai.surfaceSolid),
        borderRadius: shape,
        border: Border.all(color: ai.line),
        boxShadow: floating ? AimiShadow.float(dark) : AimiShadow.card(dark),
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
          boxShadow: floating ? AimiShadow.float(dark) : AimiShadow.card(dark),
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
/// 而不是 Material 的水波。`reduced-motion` 下关闭缩放（只保留点击语义）。
///
/// 用法：替换需要「按下去有回弹」的 InkWell（行卡、主按钮、picker 行、sheet 按钮）。
class AimiPressable extends StatefulWidget {
  /// @param child - 内容
  /// @param onTap - 点击回调；null 表示禁用（不缩放、不响应）
  /// @param scale - 按下时缩放比例（行卡 .995、圆形按钮 .94）
  /// @param borderRadius - 水波/裁剪圆角
  /// @param splash - 是否显示水波（图标按钮通常关掉，只靠缩放与底色）
  /// @param pressedColor - 按下时叠加的底色（原型 icon-button 用 surface-3）
  const AimiPressable({
    super.key,
    required this.child,
    this.onTap,
    this.scale = 0.995,
    this.borderRadius,
    this.splash = true,
    this.pressedColor,
  });

  /// 内容。
  final Widget child;

  /// 点击回调。
  final VoidCallback? onTap;

  /// 按下缩放比例。
  final double scale;

  /// 圆角（水波与裁剪）。
  final BorderRadius? borderRadius;

  /// 是否显示水波。
  final bool splash;

  /// 按下底色。
  final Color? pressedColor;

  @override
  State<AimiPressable> createState() => _AimiPressableState();
}

class _AimiPressableState extends State<AimiPressable> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null;
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    final active = _pressed && enabled;
    final scale = active && !reduceMotion ? widget.scale : 1.0;
    final radius = widget.borderRadius;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: enabled ? (_) => setState(() => _pressed = true) : null,
      onTapCancel: enabled ? () => setState(() => _pressed = false) : null,
      onTapUp: enabled
          ? (_) {
              setState(() => _pressed = false);
              widget.onTap?.call();
            }
          : null,
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
          child: radius == null ? widget.child : ClipRRect(borderRadius: radius, child: widget.child),
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
        child: InkWell(
          onTap: onPressed,
          customBorder: shape,
          borderRadius: shape is RoundedRectangleBorder ? (shape as RoundedRectangleBorder).borderRadius.resolve(TextDirection.ltr) : null,
          child: SizedBox(
            // 热区：视觉小可以，触控不能小。
            width: math.max(boxSize, 44),
            height: math.max(boxSize, 44),
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

/// 把毫秒时间戳格式化为 `HH:mm`（断线横幅「上次同步 16:38」用）。
String formatClock(int epochMs) {
  final t = DateTime.fromMillisecondsSinceEpoch(epochMs);
  return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
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
