import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// 发送后到首 token 之间的「起势」行（design.md §3.9 / README §4.4）。
///
/// 规格逐字取自 prototypes/codex（app.css §.shimmer-* / @keyframes text-shimmer-sweep）：
/// - 只让文字本身发亮：基底浅灰、高光更浅，光带（元素宽 36%、100deg 斜角）以
///   2.4s **线性**周期从左外画入、完整扫过、右外画出；
/// - 5 句约 1.4s 一换，换句时整行压到 55% 再回满（100ms 各向），字形始终在，不闪没；
/// - 交棒：首个可见输出到达后整行 180ms 淡出并上移 3px（timeline 侧 [_ShimmerHandoff] 承接）；
/// - 不叠 spinner、不写"正在思考"、不显示假进度；
/// - reduced-motion 下只显示静态「正在准备回复…」，不循环、不扫光；
/// - 整行是装饰（读屏由 liveRegion 播报一次"正在准备回复"，不逐句朗读）。
class ShimmerLine extends StatefulWidget {
  /// @param phrases - 起势文案（缺省用原型五句）
  const ShimmerLine({super.key, this.phrases = defaultPhrases});

  /// 默认文案（原型 shimmer.html 的五句，逐字取自 README §4.4，末句交棒）。
  static const List<String> defaultPhrases = <String>[
    '正在把光标接上线…',
    '先翻翻 event bus 的抽屉…',
    '给 cursor 找条近路…',
    '快照和增量先碰个头…',
    '思路顺了，开始写…',
  ];

  /// 实际使用的文案序列。
  final List<String> phrases;

  @override
  State<ShimmerLine> createState() => _ShimmerLineState();
}

class _ShimmerLineState extends State<ShimmerLine>
    with TickerProviderStateMixin {
  /// 扫光周期（app.css：2.4s linear infinite）。
  static const Duration _sweepPeriod = Duration(milliseconds: 2400);

  /// 文案切换周期（README §4.4：约 1.4s 一句）。
  static const Duration _phrasePeriod = Duration(milliseconds: 1400);

  /// 换句压暗行程（.shimmer-text.swap：100ms 到 55%，再 100ms 回满）。
  static const Duration _swapPeriod = Duration(milliseconds: 200);

  late final AnimationController _sweep;
  late final AnimationController _swap;

  Timer? _phraseTimer;
  int _index = 0;
  bool? _reduceMotion;

  @override
  void initState() {
    super.initState();
    // 控制器在 initState 显式构造：late 惰性初始化若在 dispose 首次触发，
    // 停用的 vsync 查 TickerMode 会崩（deactivated ancestor）。
    _sweep = AnimationController(vsync: this, duration: _sweepPeriod);
    _swap = AnimationController(vsync: this, duration: _swapPeriod);
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
      _swap.stop();
      return;
    }
    _sweep.repeat();
    _scheduleNextPhrase();
  }

  @override
  void dispose() {
    _phraseTimer?.cancel();
    _sweep.dispose();
    _swap.dispose();
    super.dispose();
  }

  /// 按原型节奏递进文案；换句先压暗回满（swap），最后一句保持到首个可见输出到达。
  void _scheduleNextPhrase() {
    if (_reduceMotion == true || _index >= widget.phrases.length - 1) return;
    _phraseTimer = Timer(_phrasePeriod, () {
      if (!mounted || _reduceMotion == true) return;
      setState(() => _index++);
      _swap.forward(from: 0);
      _scheduleNextPhrase();
    });
  }

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final text = _reduceMotion == true ? '正在准备回复…' : widget.phrases[_index];
    // .shimmer-text：14/22、w500、-.005em——独立于 .agent-text（12px）的字阶。
    final style = tt.agent.copyWith(
      height: 22 / 14,
      fontWeight: FontWeight.w500,
      letterSpacing: -0.005 * 14,
    );

    return Semantics(
      liveRegion: true,
      label: '正在准备回复',
      child: ExcludeSemantics(
        child: Align(
          alignment: Alignment.centerLeft,
          child: Padding(
            padding: const EdgeInsets.only(top: 2),
            child: _reduceMotion == true
                ? Text(text, style: style.copyWith(color: ai.shimmerBase))
                : AnimatedBuilder(
                    animation: Listenable.merge([_sweep, _swap]),
                    builder: (context, _) => Opacity(
                      opacity: _swapOpacity(_swap.value),
                      child: _ShimmerText(
                        text: text,
                        progress: _sweep.value,
                        base: ai.shimmerBase,
                        highlight: ai.shimmerHi,
                        style: style,
                      ),
                    ),
                  ),
          ),
        ),
      ),
    );
  }

  /// 换句透明度：0-100ms 线性压到 55%，100-200ms 线性回满（其余时刻恒 1）。
  static double _swapOpacity(double value) {
    if (value < 0.5) return 1 - 0.45 * (value * 2);
    return 0.55 + 0.45 * ((value - 0.5) * 2);
  }
}

/// 单行扫光文字：基底灰副本 + 高光副本经移动渐变遮罩透出（mask 而非 blur/glow）。
///
/// 与原型 @keyframes text-shimmer-sweep 同构：遮罩 300% 宽、带 36% 元素宽
/// （对应 stops 44%-56%），线性周期内带心从 -0.5 走到 1.5——两端各有一段
/// 带子在元素之外的"停顿"，读感是"一道光过去"，不是"某几个字变粗"；
/// 100deg 斜角只改变光带姿态，不引入模糊或硬边。
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

  /// 0..1 的扫光进度（线性）。
  final double progress;

  /// 底色。
  final Color base;

  /// 高光色。
  final Color highlight;

  /// 字阶（大小/行高/字重）。
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    // 带心：-0.5（左外）→ 1.5（右外），线性；带半宽 0.18（= 元素宽 36%）。
    final center = -0.5 + 2.0 * progress;
    final baseText = Text(
      text,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: style.copyWith(color: base),
    );
    return Stack(
      children: [
        baseText,
        ShaderMask(
          blendMode: BlendMode.srcOver,
          shaderCallback: (rect) => LinearGradient(
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
            transform: GradientRotation(math.pi / 18),
            colors: <Color>[Colors.transparent, highlight, Colors.transparent],
            stops: <double>[
              (center - 0.18).clamp(0.0, 1.0),
              center.clamp(0.0, 1.0),
              (center + 0.18).clamp(0.0, 1.0),
            ],
          ).createShader(rect),
          child: Text(
            text,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: style.copyWith(color: highlight),
          ),
        ),
      ],
    );
  }
}

/// 起势行的交棒：`show` 翻 false 时按原型 180ms 淡出并上移 3px
/// （app.css `.agent-start.out`），动画结束才离开树——不让 shimmer 闪没。
class ShimmerHandoff extends StatefulWidget {
  /// @param show - 当前回合是否处于"等待首 token"状态。
  const ShimmerHandoff({super.key, required this.show});

  /// 是否显示起势行。
  final bool show;

  @override
  State<ShimmerHandoff> createState() => _ShimmerHandoffState();
}

class _ShimmerHandoffState extends State<ShimmerHandoff>
    with SingleTickerProviderStateMixin {
  late final AnimationController _exit;

  /// 是否在树中；初始跟随 `show`——历史回合（show=false）不得渲染起势行。
  late bool _present = widget.show;

  @override
  void initState() {
    super.initState();
    // 同 _ShimmerLineState：避免 late 惰性构造在 dispose 期触发（停用 vsync 查
    // TickerMode 会崩 deactivated ancestor）。
    _exit = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 180),
    );
  }

  @override
  void didUpdateWidget(ShimmerHandoff oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.show) {
      // 新回合再次起势：清算退出动画并复位。
      if (_exit.isAnimating) _exit.stop();
      _exit.value = 0;
      if (!_present) setState(() => _present = true);
      return;
    }
    if (_present && !_exit.isAnimating && _exit.value == 0) {
      _exit.forward().whenComplete(() {
        if (mounted) setState(() => _present = false);
      });
    }
  }

  @override
  void dispose() {
    _exit.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_present) return const SizedBox.shrink();
    const line = ShimmerLine();
    if (widget.show || _exit.value == 0) return line;
    return AnimatedBuilder(
      animation: _exit,
      builder: (context, _) => Opacity(
        opacity: 1 - _exit.value,
        child: Transform.translate(
          offset: Offset(0, -3 * _exit.value),
          child: line,
        ),
      ),
    );
  }
}

/// 待发胶囊的滑入动画包装（180ms 上升淡入，design.md §3.8 操作反馈）。
class AimiSlideIn extends StatelessWidget {
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
        child: Transform.translate(
          offset: Offset(0, 6 * (1 - value)),
          child: built,
        ),
      ),
      child: child,
    );
  }
}
