import 'dart:async';

import 'package:flutter/material.dart';

/// 开屏（品牌入场；原型 opening v7「光带揭示」的克制实现，design.md §3.8）。
///
/// 规格与约束：
/// - 只在冷启动播一次、约 3.55s 内结束（3000ms 光带揭示 + 550ms 整屏淡出），
///   不承载任何信息、不阻塞装配——由宿主以覆盖层方式挂载，数据连接照常进行。
/// - 任意点击立即跳过（直接回调 [onDone]，不做退场动画——跳过就是要走）。
/// - `reduced-motion` 只渲染定格帧（字标全亮），短暂停留后自动交棒。
/// - 无品牌图资源时用「aimi」Inter 字标占位（原型既定口径）；冷黑径向底是
///   品牌时刻的固定材质，不随应用主题切换。粒子/泛光仅允许出现在本屏。
class OpeningScreen extends StatefulWidget {
  /// @param onDone - 开屏结束（播完/跳过/定格停留）后的交棒回调。
  const OpeningScreen({super.key, required this.onDone});

  final VoidCallback onDone;

  @override
  State<OpeningScreen> createState() => _OpeningScreenState();
}

class _OpeningScreenState extends State<OpeningScreen>
    with SingleTickerProviderStateMixin {
  /// 光带揭示 3000ms + 整屏淡出 550ms（原型 07 版时长）。
  static const int _revealMs = 3000;
  static const int _fadeOutMs = 550;

  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: _revealMs + _fadeOutMs),
  );

  /// 定格停留（reduced-motion）的自动交棒定时器。
  Timer? _holdTimer;

  /// reduced-motion 口径：不跑动画，只渲染定格帧。
  bool get _reduceMotion =>
      MediaQuery.maybeDisableAnimationsOf(context) ?? false;

  /// 动画装配只做一次；reduce-motion 是媒体查询派生值，读取必须在
  /// didChangeDependencies（initState 读 InheritedWidget 会被框架断言拦截）。
  bool _started = false;

  @override
  void initState() {
    super.initState();
    _controller.addStatusListener(_onStatus);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (_reduceMotion) {
      // 字标全亮定格，短暂停留后交棒（不跑任何动画）。
      _controller.value = _revealMs / (_revealMs + _fadeOutMs);
      _holdTimer = Timer(const Duration(milliseconds: 600), widget.onDone);
    } else {
      _controller.forward();
    }
  }

  @override
  void dispose() {
    _controller.removeStatusListener(_onStatus);
    _controller.dispose();
    _holdTimer?.cancel();
    super.dispose();
  }

  void _onStatus(AnimationStatus status) {
    if (status == AnimationStatus.completed && mounted) widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final reduceMotion = _reduceMotion;
    return GestureDetector(
      // 跳过即走：不播退场，直接交棒（点击意图明确，无需二次确认）。
      onTap: widget.onDone,
      behavior: HitTestBehavior.opaque,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, _) {
          final totalMs = _controller.value * (_revealMs + _fadeOutMs);
          // 光带行程：0..3000ms 从左外扫到右外（两端各留一拍由曲线自然形成）。
          final bandT = (totalMs / _revealMs).clamp(0.0, 1.0);
          final bandCenter = -0.3 + bandT * 1.6;
          // 整屏淡出：3000ms 后整层透明交棒。
          final fade = ((totalMs - _revealMs) / _fadeOutMs).clamp(0.0, 1.0);
          return Opacity(
            opacity: reduceMotion ? 1 : 1 - fade,
            child: ColoredBox(
              color: const Color(0xFF040508),
              child: DecoratedBox(
                decoration: const BoxDecoration(
                  gradient: RadialGradient(
                    center: Alignment(0, -0.3),
                    radius: 1.3,
                    colors: [Color(0xFF0C0E15), Color(0xFF040508)],
                  ),
                ),
                child: Center(child: _Wordmark(bandCenter: bandCenter)),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// 「aimi」字标：CustomPainter 双层绘制——底层暗字常驻，亮字仅在光带矩形内
/// 经几何裁剪（clipRect）显现，光带完全离场后整体切全亮。
///
/// why 不用 ShaderMask：着色器蒙版在真机（三星）与模拟器、乃至测试渲染器上
/// 都会在字标下缘稳定渲染出一条与字标等宽的实心黄条（1.3.6 反馈 #8d81bf①，
/// 像素采样测试可复现）；纯几何裁剪不经过着色器合成，无该伪影类。
class _Wordmark extends StatelessWidget {
  const _Wordmark({required this.bandCenter});

  /// 光带中心（相对宽度，-0.3..1.3；≥1.45 视为已完全揭示）。
  final double bandCenter;

  static const _bandWidth = 0.22;

  static const _style = TextStyle(
    fontFamily: 'Inter',
    fontSize: 64,
    height: 1.2,
    fontWeight: FontWeight.w600,
    letterSpacing: -1.2,
    color: Color(0xFFF4F4F4),
  );

  @override
  Widget build(BuildContext context) {
    final brightTp = TextPainter(
      text: const TextSpan(text: 'aimi', style: _style),
      textDirection: TextDirection.ltr,
    )..layout();
    final dimTp = TextPainter(
      text: const TextSpan(
        text: 'aimi',
        // 底层暗字：原型「未扫到的留 5% 暗字」——前段不是空屏。
        style: TextStyle(
          fontFamily: 'Inter',
          fontSize: 64,
          height: 1.2,
          fontWeight: FontWeight.w600,
          letterSpacing: -1.2,
          color: Color(0x0DF4F4F4),
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    return CustomPaint(
      size: Size(brightTp.width, brightTp.height),
      painter: _WordmarkPainter(
        brightTp: brightTp,
        dimTp: dimTp,
        bandCenter: bandCenter,
      ),
    );
  }
}

/// 字标绘制器：暗字全幅 + 亮字裁剪到光带矩形；[bandCenter] ≥ 1.45 全亮。
class _WordmarkPainter extends CustomPainter {
  _WordmarkPainter({
    required this.brightTp,
    required this.dimTp,
    required this.bandCenter,
  });

  final TextPainter brightTp;
  final TextPainter dimTp;
  final double bandCenter;

  @override
  void paint(Canvas canvas, Size size) {
    dimTp.paint(canvas, Offset.zero);
    if (bandCenter >= 1.45) {
      brightTp.paint(canvas, Offset.zero);
      return;
    }
    const half = _Wordmark._bandWidth / 2;
    final left = ((bandCenter - half).clamp(0.0, 1.0)) * size.width;
    final right = ((bandCenter + half).clamp(0.0, 1.0)) * size.width;
    if (right <= left) return;
    canvas
      ..save()
      ..clipRect(Rect.fromLTRB(left, 0, right, size.height));
    brightTp.paint(canvas, Offset.zero);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_WordmarkPainter oldDelegate) =>
      oldDelegate.bandCenter != bandCenter;
}
