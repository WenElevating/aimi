import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// 发送后到首 token 之间的「起势」行（design.md §3.9 / README §4.4）。
///
/// 实现要点：
/// - 只让文字本身发亮：底色浅灰、高光提亮，2.4s 一轮柔光带扫过整行；
/// - 4-5 句、约 1.4s 一换，最后一句交棒（"思路顺了，开始写…"）；
/// - 不叠 spinner、不写"正在思考"、不显示假进度；
/// - reduced-motion 下只显示一句静态「正在准备回复…」；
/// - 整行是装饰（读屏由会话页的 liveRegion 播报，不逐句朗读）。
class ShimmerLine extends StatefulWidget {
  /// @param phrases - 起势文案（缺省用原型五句）
  const ShimmerLine({super.key, this.phrases = defaultPhrases});

  /// 默认文案（原型 shimmer.html 的五句，末句交棒）。
  static const List<String> defaultPhrases = <String>[
    '正在把光标接上线…',
    '先翻翻上下文…',
    '给问题找条近路…',
    '快照和增量先碰个头…',
    '思路顺了，开始写…',
  ];

  /// 实际使用的文案序列。
  final List<String> phrases;

  @override
  State<ShimmerLine> createState() => _ShimmerLineState();
}

class _ShimmerLineState extends State<ShimmerLine> with SingleTickerProviderStateMixin {
  /// 文案切换周期（README §4.4：约 1.4s 一句）。
  static const Duration _phrasePeriod = Duration(milliseconds: 1400);

  /// 扫光周期（README §4.4：2.4s 一轮，两端各留约 0.5s 停顿）。
  static const Duration _sweepPeriod = Duration(milliseconds: 2400);

  late final AnimationController _sweep = AnimationController(
    vsync: this,
    duration: _sweepPeriod,
  );

  Timer? _phraseTimer;
  int _index = 0;
  bool? _reduceMotion;

  @override
  void initState() {
    super.initState();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (reduceMotion == _reduceMotion) return;
    _reduceMotion = reduceMotion;
    if (reduceMotion) {
      _phraseTimer?.cancel();
      _phraseTimer = null;
      _sweep.stop();
      return;
    }
    _sweep.repeat();
    _scheduleNextPhrase();
  }

  @override
  void dispose() {
    _phraseTimer?.cancel();
    _sweep.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final text = _reduceMotion == true ? '正在准备回复…' : widget.phrases[_index];

    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.only(top: 2),
        child: ExcludeSemantics(
          child: _reduceMotion == true
              ? Text(text, style: tt.agent.copyWith(color: ai.shimmerBase))
              : AnimatedBuilder(
                  animation: _sweep,
                  builder: (context, _) => _ShimmerText(
                    text: text,
                    progress: _sweep.value,
                    base: ai.shimmerBase,
                    highlight: ai.shimmerHi,
                    style: tt.agent,
                  ),
                ),
        ),
      ),
    );
  }

  /// 按原型节奏递进文案；最后一句保持到首个可见输出到达。
  void _scheduleNextPhrase() {
    if (_reduceMotion == true || _index >= widget.phrases.length - 1) return;
    _phraseTimer = Timer(_phrasePeriod, () {
      if (!mounted || _reduceMotion == true) return;
      setState(() => _index++);
      _scheduleNextPhrase();
    });
  }
}

/// 单行扫光文字：基底灰 + 高光副本经移动渐变遮罩透出（mask 而非 blur/glow）。
///
/// 与原型一致：光带完整扫过整行（含两端留白），两端各有停顿，
/// 只提亮不压暗；不引入新颜色。
class _ShimmerText extends StatelessWidget {
  const _ShimmerText({
    required this.text,
    required this.progress,
    required this.base,
    required this.highlight,
    required this.style,
  });

  /// 当前文案。
  final String text;

  /// 0..1 的扫光进度。
  final double progress;

  /// 底色。
  final Color base;

  /// 高光色。
  final Color highlight;

  /// 字阶（大小/行高）。
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    // 停顿：进度前 20% 与后 20% 光带停在两端外侧（不闪、不跳）。
    final t = Curves.easeInOut.transform(((progress - 0.2) / 0.6).clamp(0.0, 1.0));
    // 光带中心从 -30% 走到 130%，配 24% 宽度，使整行都被完整扫过。
    final center = -0.3 + 1.6 * t;
    return Stack(
      children: [
        Text(text, style: style.copyWith(color: base)),
        ShaderMask(
          blendMode: BlendMode.srcOver,
          shaderCallback: (rect) => LinearGradient(
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
            colors: <Color>[
              Colors.transparent,
              highlight,
              Colors.transparent,
            ],
            stops: <double>[
              (center - 0.12).clamp(0.0, 1.0),
              center.clamp(0.0, 1.0),
              (center + 0.12).clamp(0.0, 1.0),
            ],
          ).createShader(rect),
          child: Text(text, style: style.copyWith(color: highlight)),
        ),
      ],
    );
  }
}

/// 待发胶囊的滑入动画包装（180ms 上升淡入，design.md §3.8 操作反馈）。
class AimiSlideIn extends StatelessWidget {
  /// @param child - 要滑入的内容
  const AimiSlideIn({super.key, required this.child});

  /// 内容。
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (reduceMotion) return child;
    return TweenAnimationBuilder<double>(
      key: ValueKey<Object>(child.hashCode),
      tween: Tween<double>(begin: 0, end: 1),
      duration: AimiMotion.fast,
      curve: AimiMotion.ease,
      builder: (context, value, built) => Opacity(
        opacity: value,
        child: Transform.translate(offset: Offset(0, 6 * (1 - value)), child: built),
      ),
      child: child,
    );
  }
}
