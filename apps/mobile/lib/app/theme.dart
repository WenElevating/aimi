import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// aimi 设计 token 的唯一来源：色彩取自 `prototypes/codex/assets/tokens.css`
/// 的明暗两套 CSS 变量，字阶/圆角/间距/动效取自同文件与 `design.md` §4。
///
/// 使用约定：
/// - 颜色一律经 `context.ai`（[AimiColors]）取用，禁止在 UI 层出现裸 `Color(0x…)`；
/// - 文本样式经 `context.tt`（[AimiText]）取语义档位，禁止散落 fontSize；
/// - mono（JetBrainsMono）只用于机器声：命令、路径、diff、事件数、ID。
extension AimiThemeContext on BuildContext {
  /// 语义色板（含明暗两套，由 [ThemeExtension] 机制随主题切换）。
  ///
  /// 兜底：未装配 aimi 主题（部分测试用裸 `MaterialApp`）时按当前亮度返回对应色板，
  /// 让组件在缺主题的宿主里仍可渲染，而不是抛空值异常。
  AimiColors get ai =>
      Theme.of(this).extension<AimiColors>() ??
      (Theme.of(this).brightness == Brightness.dark
          ? AimiColors.dark
          : AimiColors.light);

  /// 语义字阶（不随明暗变化，只随档位）。
  AimiText get tt => Theme.of(this).extension<AimiText>() ?? AimiText.build();
}

/// 圆角 token（tokens.css --radius-*）。
abstract final class AimiRadius {
  /// command/diff 井（--radius-well）。
  static const well = Radius.circular(10);

  /// 工具卡（--radius-row）。
  static const row = Radius.circular(14);

  /// 会话卡/设置卡（--radius-card）。
  static const card = Radius.circular(16);

  /// composer 外卡（--radius-composer）。
  static const composer = Radius.circular(24);

  /// 底部 sheet 顶部（--radius-sheet）。
  static const sheet = Radius.circular(28);

  /// pill 按钮/chip/胶囊。
  static const pill = Radius.circular(999);

  /// 输入井内层（app.css:447）。
  static const inputWell = Radius.circular(18);

  /// 模型/权限 picker（app.css:579）。
  static const picker = Radius.circular(22);
}

/// 间距 token（--space-1..7，4/8 网格）。
abstract final class AimiSpace {
  /// 4。
  static const s1 = 4.0;

  /// 8。
  static const s2 = 8.0;

  /// 12（卡片内边距）。
  static const s3 = 12.0;

  /// 16（页面左右）。
  static const s4 = 16.0;

  /// 20（页面左右上限）。
  static const s5 = 20.0;

  /// 24。
  static const s6 = 24.0;

  /// 32。
  static const s7 = 32.0;

  /// 卡片间距（README §4：7-8）。
  static const cardGap = 7.0;

  // ---- 页面级节奏（逐字取自 app.css，避免"全屏 16px 一套"） ----

  /// 看板 header 左内边距（`.app-header` padding-left 20）。
  static const headerLeft = 20.0;

  /// 原型 statusbar 高 44（含 6 顶部内边距）；Android 系统状态栏 ≈24dp，
  /// 差额由 header 顶部 padding 补齐，使标题基线落在原型位置。
  static const statusbarCompensation = 20.0;

  /// 看板 header 右内边距（`.app-header` padding-right 18）。
  static const headerRight = 18.0;

  /// 会话页左右内边距（`.timeline` 18）。
  static const sessionPageH = 18.0;

  /// 时间线底部留白（`.timeline` padding-bottom 126：给 composer 让位）。
  static const timelineBottom = 126.0;

  /// 筛选 chip 行上内边距（`.chips` padding-top 14）。
  static const chipRowTop = 14.0;

  /// 会话行内边距（`.session` padding 9 12）。
  static const rowPadV = 9.0;

  /// 会话行内边距水平分量。
  static const rowPadH = 12.0;

  /// 会话行最小高度（`.session` min-height 60）。
  static const rowMinHeight = 60.0;

  /// 设置分组之间的间距（`.set-group` margin-top 24）。
  static const groupGap = 24.0;

  /// 设置行最小高度（`.set-row` min-height 48）。
  static const setRowHeight = 48.0;
}

/// 动效 token（--duration-fast / --ease-standard 与 app.css 关键帧周期）。
abstract final class AimiMotion {
  /// 快速反馈时长（140ms）。
  static const fast = Duration(milliseconds: 140);

  /// 展开内容入场时长（app.css tool-body-in 160ms：淡入+下落，不做高度补间）。
  static const bodyIn = Duration(milliseconds: 160);

  /// 标准缓动 cubic-bezier(.2,.8,.2,1) 的近似 Flutter 曲线。
  static const ease = Curves.easeOutCubic;

  /// 呼吸点周期（app.css dot-breathe 2.8s）。
  static const breathe = Duration(milliseconds: 2800);

  /// 琥珀脉冲周期（app.css amber-pulse 2.4s）。
  static const amberPulse = Duration(milliseconds: 2400);

  /// 流式光标闪烁（app.css blink 1.05s step-end）。
  static const caretBlink = Duration(milliseconds: 1050);
}

/// 权限三态：字形 + 底色 + 可访问标签同步变化的档位枚举
/// （design.md §3.6；与服务端 permissionMode 一一对应）。
enum AimiPermTier {
  /// 每次询问（锁、中性底、default）。
  ask('default', '每次询问'),

  /// 自动编辑（铅笔、蓝底、acceptEdits）。
  autoEdits('acceptEdits', '自动编辑'),

  /// 完全放行（钥匙、红底、bypassPermissions）；永不作为默认档。
  full('bypassPermissions', '完全放行');

  const AimiPermTier(this.mode, this.label);

  /// 服务端协议的 permissionMode 值。
  final String mode;

  /// 中文档位标签（picker 行与 aria 标签共用）。
  final String label;

  /// 从服务端 mode 映射档位；plan/未知视同每次询问（最接近的保守档）。
  static AimiPermTier fromMode(String? mode) => switch (mode) {
    'acceptEdits' => AimiPermTier.autoEdits,
    'bypassPermissions' => AimiPermTier.full,
    _ => AimiPermTier.ask,
  };

  /// 协议档位序（default < plan < acceptEdits < bypassPermissions；与服务端 PERMISSION_RANK 同源）。
  static int rankOf(String mode) => switch (mode) {
    'default' => 0,
    'plan' => 1,
    'acceptEdits' => 2,
    'bypassPermissions' => 3,
    _ => 0,
  };

  /// 服务端权限上限内的可选档位；`ceiling` null（未下发/旧服务端）时全档位开放。
  static List<AimiPermTier> allowed(String? ceiling) {
    final limit = ceiling == null ? 3 : rankOf(ceiling);
    return <AimiPermTier>[
      for (final tier in AimiPermTier.values)
        if (rankOf(tier.mode) <= limit) tier,
    ];
  }
}

/// 语义色板 ThemeExtension：字段名与 tokens.css CSS 变量一一对应，
/// 值逐字取自 light / dark 两套主题（禁止凭感觉调色）。
///
/// 语义只承担状态（design.md §4.3）：绿=运行/连接，琥珀=等待/需要你，
/// 红=失败/拒绝/完全放行，灰=完成/停止/每次询问，蓝(低饱和)=自动编辑。
@immutable
class AimiColors extends ThemeExtension<AimiColors> {
  /// 构建一套完整语义色板。
  const AimiColors({
    required this.canvas,
    required this.canvasTop,
    required this.surface,
    required this.surfaceSolid,
    required this.surface2,
    required this.surface3,
    required this.ink,
    required this.ink2,
    required this.ink3,
    required this.ink4,
    required this.line,
    required this.lineStrong,
    required this.accent,
    required this.green,
    required this.greenSoft,
    required this.amber,
    required this.amberStrong,
    required this.amberSoft,
    required this.amberLine,
    required this.red,
    required this.redSoft,
    required this.redDeep,
    required this.redLine,
    required this.primaryBtnBg,
    required this.primaryBtnInk,
    required this.secondaryBtnBg,
    required this.bubbleUserBg,
    required this.bubbleUserInk,
    required this.bubbleUserLine,
    required this.shimmerBase,
    required this.shimmerHi,
    required this.permDefaultBg,
    required this.permDefaultInk,
    required this.permAutoBg,
    required this.permAutoInk,
    required this.permFullBg,
    required this.permFullInk,
    required this.permFullLine,
    required this.inputBg,
    required this.inputLine,
    required this.scrim,
    required this.codeBg,
    required this.codeInk,
    required this.diffAddBg,
    required this.diffAddInk,
    required this.diffDelBg,
    required this.diffDelInk,
  });

  /// 页面画布（--bg）。
  final Color canvas;

  /// 画布顶部渐变起点（--bg-top）。
  final Color canvasTop;

  /// 卡片表面（--surface，带透明度）。
  final Color surface;

  /// 不透明卡面（--surface-solid；picker/浮层用，避免透出底层）。
  final Color surfaceSolid;

  /// 井/chip 基色（--surface-2）。
  final Color surface2;

  /// 按压态（--surface-3）。
  final Color surface3;

  /// 主文本（--ink）。
  final Color ink;

  /// 次级文本（--ink-2）。
  final Color ink2;

  /// 元信息（--ink-3）。
  final Color ink3;

  /// 最弱层级（--ink-4）。
  final Color ink4;

  /// 发丝线（--line）。
  final Color line;

  /// 强发丝线（--line-strong）。
  final Color lineStrong;

  /// 品牌电压色（--accent）：只出现在焦点、选中、少量链接，不进主 CTA。
  final Color accent;

  /// 运行/连接（--green）。
  final Color green;

  /// 运行软底（--green-soft）。
  final Color greenSoft;

  /// 等待/需要你（--amber）。
  final Color amber;

  /// 琥珀强档（--amber-strong；重连横幅文本）。
  final Color amberStrong;

  /// 琥珀软底（--amber-soft）。
  final Color amberSoft;

  /// 琥珀边线（--amber-line）。
  final Color amberLine;

  /// 失败/拒绝（--red）。
  final Color red;

  /// 失败原因文本专用暗红：比 [red] 更暗更沉，避免被读成正常模型输出
  /// （亮色主题取暗红、暗色主题压掉荧光感——两档都明显区别于 ink 正文）。
  final Color redDeep;

  /// 失败软底（--red-soft）。
  final Color redSoft;

  /// 失败边线（--red-line）：失败工具卡描边等低噪音红色边界。
  final Color redLine;

  /// 主按钮底（--primary-btn-bg：浅色黑底、深色白底）。
  final Color primaryBtnBg;

  /// 主按钮字（--primary-btn-ink）。
  final Color primaryBtnInk;

  /// 次按钮底（--secondary-btn-bg）。
  final Color secondaryBtnBg;

  /// 用户气泡底（--bubble-user-bg；只比画布强一档）。
  final Color bubbleUserBg;

  /// 用户气泡字（--bubble-user-ink）。
  final Color bubbleUserInk;

  /// 用户气泡发丝线（--bubble-user-line）。
  final Color bubbleUserLine;

  /// 起势行底色（--shimmer-base）。
  final Color shimmerBase;

  /// 起势扫光高亮（--shimmer-hi）。
  final Color shimmerHi;

  /// 权限·每次询问底（--perm-default-bg）。
  final Color permDefaultBg;

  /// 权限·每次询问字（--perm-default-ink）。
  final Color permDefaultInk;

  /// 权限·自动编辑底（--perm-auto-bg）。
  final Color permAutoBg;

  /// 权限·自动编辑字（--perm-auto-ink）。
  final Color permAutoInk;

  /// 权限·完全放行底（--perm-full-bg）。
  final Color permFullBg;

  /// 权限·完全放行字（--perm-full-ink）。
  final Color permFullInk;

  /// 权限·完全放行内描边（--perm-full-line）。
  final Color permFullLine;

  /// 输入井底（--input-bg；focus 不变填充色）。
  final Color inputBg;

  /// 输入井线（--input-line）。
  final Color inputLine;

  /// sheet 遮罩（--scrim）。
  final Color scrim;

  /// 代码井底（--code-bg）。
  final Color codeBg;

  /// 代码井字（--code-ink）。
  final Color codeInk;

  /// diff 新增底（--diff-add-bg）。
  final Color diffAddBg;

  /// diff 新增字（--diff-add-ink）。
  final Color diffAddInk;

  /// diff 删除底（--diff-del-bg）。
  final Color diffDelBg;

  /// diff 删除字（--diff-del-ink）。
  final Color diffDelInk;

  /// 按权限档位取底色。
  Color permBg(AimiPermTier tier) => switch (tier) {
    AimiPermTier.ask => permDefaultBg,
    AimiPermTier.autoEdits => permAutoBg,
    AimiPermTier.full => permFullBg,
  };

  /// 按权限档位取前景色。
  Color permInk(AimiPermTier tier) => switch (tier) {
    AimiPermTier.ask => permDefaultInk,
    AimiPermTier.autoEdits => permAutoInk,
    AimiPermTier.full => permFullInk,
  };

  /// tokens.css light 主题全量色板（逐字对照）。
  ///
  /// 画布提暖（#F4F4F6 冷灰 → #F8F8F6 暖近白）：层级反转——灰气泡与
  /// 白卡真正「浮」在纸上，整屏不再蒙灰雾（原型 session-quality 右屏）。
  static final AimiColors light = AimiColors(
    canvas: const Color(0xFFF8F8F6),
    canvasTop: const Color(0xFFFBFBF9),
    surface: const Color.fromRGBO(255, 255, 255, 0.97),
    surfaceSolid: const Color(0xFFFFFFFF),
    surface2: const Color(0xFFF2F2F6),
    surface3: const Color(0xFFE9E9EE),
    ink: const Color(0xFF171717),
    ink2: const Color(0xFF6E6E73),
    ink3: const Color(0xFF8E8E93),
    ink4: const Color(0xFFAEAEB2),
    line: const Color.fromRGBO(0, 0, 0, 0.055),
    lineStrong: const Color.fromRGBO(0, 0, 0, 0.09),
    accent: const Color(0xFF5B5BD6),
    green: const Color(0xFF248A3D),
    greenSoft: const Color(0xFFE9F6EC),
    amber: const Color(0xFFA86400),
    amberStrong: const Color(0xFFB26A00),
    amberSoft: const Color(0xFFFFF4E2),
    amberLine: const Color.fromRGBO(202, 138, 4, 0.22),
    red: const Color(0xFFD73A49),
    redDeep: const Color(0xFFA52533),
    redSoft: const Color(0xFFFDECEE),
    redLine: const Color.fromRGBO(215, 58, 73, 0.22),
    primaryBtnBg: const Color(0xFF171717),
    primaryBtnInk: const Color(0xFFFFFFFF),
    secondaryBtnBg: const Color(0xFFF2F2F6),
    bubbleUserBg: const Color(0xFFE7E6E1),
    bubbleUserInk: const Color(0xFF171717),
    bubbleUserLine: const Color.fromRGBO(0, 0, 0, 0.055),
    shimmerBase: const Color(0xFFA1A1A6),
    shimmerHi: const Color(0xFFD7D7DC),
    permDefaultBg: const Color(0xFFF2F2F6),
    permDefaultInk: const Color(0xFF6E6E73),
    permAutoBg: const Color(0xFFEAF0FA),
    permAutoInk: const Color(0xFF2E5F9E),
    permFullBg: const Color(0xFFFBEDEA),
    permFullInk: const Color(0xFFA8452E),
    permFullLine: const Color.fromRGBO(168, 69, 46, 0.22),
    inputBg: const Color(0xFFECECF1),
    inputLine: const Color.fromRGBO(0, 0, 0, 0.06),
    scrim: const Color.fromRGBO(17, 17, 17, 0.32),
    codeBg: const Color(0xFFF6F6F8),
    codeInk: const Color(0xFF24292F),
    diffAddBg: const Color(0xFFE8F6EC),
    diffAddInk: const Color(0xFF1A7F37),
    diffDelBg: const Color(0xFFFDECEE),
    diffDelInk: const Color(0xFFCF222E),
  );

  /// tokens.css dark 主题全量色板（逐字对照）。
  static final AimiColors dark = AimiColors(
    canvas: const Color(0xFF0B0B0C),
    canvasTop: const Color(0xFF111113),
    surface: const Color.fromRGBO(25, 25, 25, 0.95),
    surfaceSolid: const Color(0xFF191919),
    surface2: const Color(0xFF242426),
    surface3: const Color(0xFF2C2C2E),
    ink: const Color(0xFFF4F4F4),
    ink2: const Color(0xFFA1A1A6),
    ink3: const Color(0xFF6E6E73),
    ink4: const Color(0xFF48484A),
    line: const Color.fromRGBO(255, 255, 255, 0.09),
    lineStrong: const Color.fromRGBO(255, 255, 255, 0.14),
    accent: const Color(0xFFA5A5FF),
    green: const Color(0xFF30D158),
    greenSoft: const Color.fromRGBO(48, 209, 88, 0.12),
    amber: const Color(0xFFFFD60A),
    amberStrong: const Color(0xFFFFB340),
    amberSoft: const Color.fromRGBO(255, 214, 10, 0.10),
    amberLine: const Color.fromRGBO(255, 214, 10, 0.20),
    red: const Color(0xFFFF453A),
    redDeep: const Color(0xFFC2343B),
    redSoft: const Color.fromRGBO(255, 69, 58, 0.12),
    redLine: const Color.fromRGBO(255, 69, 58, 0.30),
    primaryBtnBg: const Color(0xFFF4F4F4),
    primaryBtnInk: const Color(0xFF171717),
    secondaryBtnBg: const Color(0xFF242426),
    bubbleUserBg: const Color(0xFF232327),
    bubbleUserInk: const Color(0xFFF4F4F4),
    bubbleUserLine: const Color.fromRGBO(255, 255, 255, 0.08),
    shimmerBase: const Color(0xFF8E8E93),
    shimmerHi: const Color(0xFFF4F4F4),
    permDefaultBg: const Color(0xFF242426),
    permDefaultInk: const Color(0xFFA1A1A6),
    permAutoBg: const Color.fromRGBO(96, 150, 255, 0.16),
    permAutoInk: const Color(0xFF9DC0FF),
    permFullBg: const Color.fromRGBO(255, 110, 84, 0.16),
    permFullInk: const Color(0xFFFFA48D),
    permFullLine: const Color.fromRGBO(255, 140, 110, 0.28),
    inputBg: const Color(0xFF111113),
    inputLine: const Color.fromRGBO(255, 255, 255, 0.08),
    scrim: const Color.fromRGBO(0, 0, 0, 0.55),
    codeBg: const Color(0xFF101012),
    codeInk: const Color(0xFFE6EDF3),
    diffAddBg: const Color.fromRGBO(46, 160, 67, 0.15),
    diffAddInk: const Color(0xFF3FB950),
    diffDelBg: const Color.fromRGBO(248, 81, 73, 0.14),
    diffDelInk: const Color(0xFFF85149),
  );

  @override
  AimiColors copyWith({
    Color? canvas,
    Color? canvasTop,
    Color? surface,
    Color? surfaceSolid,
    Color? surface2,
    Color? surface3,
    Color? ink,
    Color? ink2,
    Color? ink3,
    Color? ink4,
    Color? line,
    Color? lineStrong,
    Color? accent,
    Color? green,
    Color? greenSoft,
    Color? amber,
    Color? amberStrong,
    Color? amberSoft,
    Color? amberLine,
    Color? red,
    Color? redDeep,
    Color? redSoft,
    Color? redLine,
    Color? primaryBtnBg,
    Color? primaryBtnInk,
    Color? secondaryBtnBg,
    Color? bubbleUserBg,
    Color? bubbleUserInk,
    Color? bubbleUserLine,
    Color? shimmerBase,
    Color? shimmerHi,
    Color? permDefaultBg,
    Color? permDefaultInk,
    Color? permAutoBg,
    Color? permAutoInk,
    Color? permFullBg,
    Color? permFullInk,
    Color? permFullLine,
    Color? inputBg,
    Color? inputLine,
    Color? scrim,
    Color? codeBg,
    Color? codeInk,
    Color? diffAddBg,
    Color? diffAddInk,
    Color? diffDelBg,
    Color? diffDelInk,
  }) => AimiColors(
    canvas: canvas ?? this.canvas,
    canvasTop: canvasTop ?? this.canvasTop,
    surface: surface ?? this.surface,
    surfaceSolid: surfaceSolid ?? this.surfaceSolid,
    surface2: surface2 ?? this.surface2,
    surface3: surface3 ?? this.surface3,
    ink: ink ?? this.ink,
    ink2: ink2 ?? this.ink2,
    ink3: ink3 ?? this.ink3,
    ink4: ink4 ?? this.ink4,
    line: line ?? this.line,
    lineStrong: lineStrong ?? this.lineStrong,
    accent: accent ?? this.accent,
    green: green ?? this.green,
    greenSoft: greenSoft ?? this.greenSoft,
    amber: amber ?? this.amber,
    amberStrong: amberStrong ?? this.amberStrong,
    amberSoft: amberSoft ?? this.amberSoft,
    amberLine: amberLine ?? this.amberLine,
    red: red ?? this.red,
    redDeep: redDeep ?? this.redDeep,
    redSoft: redSoft ?? this.redSoft,
    redLine: redLine ?? this.redLine,
    primaryBtnBg: primaryBtnBg ?? this.primaryBtnBg,
    primaryBtnInk: primaryBtnInk ?? this.primaryBtnInk,
    secondaryBtnBg: secondaryBtnBg ?? this.secondaryBtnBg,
    bubbleUserBg: bubbleUserBg ?? this.bubbleUserBg,
    bubbleUserInk: bubbleUserInk ?? this.bubbleUserInk,
    bubbleUserLine: bubbleUserLine ?? this.bubbleUserLine,
    shimmerBase: shimmerBase ?? this.shimmerBase,
    shimmerHi: shimmerHi ?? this.shimmerHi,
    permDefaultBg: permDefaultBg ?? this.permDefaultBg,
    permDefaultInk: permDefaultInk ?? this.permDefaultInk,
    permAutoBg: permAutoBg ?? this.permAutoBg,
    permAutoInk: permAutoInk ?? this.permAutoInk,
    permFullBg: permFullBg ?? this.permFullBg,
    permFullInk: permFullInk ?? this.permFullInk,
    permFullLine: permFullLine ?? this.permFullLine,
    inputBg: inputBg ?? this.inputBg,
    inputLine: inputLine ?? this.inputLine,
    scrim: scrim ?? this.scrim,
    codeBg: codeBg ?? this.codeBg,
    codeInk: codeInk ?? this.codeInk,
    diffAddBg: diffAddBg ?? this.diffAddBg,
    diffAddInk: diffAddInk ?? this.diffAddInk,
    diffDelBg: diffDelBg ?? this.diffDelBg,
    diffDelInk: diffDelInk ?? this.diffDelInk,
  );

  @override
  AimiColors lerp(AimiColors? other, double t) {
    if (other is! AimiColors) return this;
    return AimiColors(
      canvas: Color.lerp(canvas, other.canvas, t)!,
      canvasTop: Color.lerp(canvasTop, other.canvasTop, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surfaceSolid: Color.lerp(surfaceSolid, other.surfaceSolid, t)!,
      surface2: Color.lerp(surface2, other.surface2, t)!,
      surface3: Color.lerp(surface3, other.surface3, t)!,
      ink: Color.lerp(ink, other.ink, t)!,
      ink2: Color.lerp(ink2, other.ink2, t)!,
      ink3: Color.lerp(ink3, other.ink3, t)!,
      ink4: Color.lerp(ink4, other.ink4, t)!,
      line: Color.lerp(line, other.line, t)!,
      lineStrong: Color.lerp(lineStrong, other.lineStrong, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      green: Color.lerp(green, other.green, t)!,
      greenSoft: Color.lerp(greenSoft, other.greenSoft, t)!,
      amber: Color.lerp(amber, other.amber, t)!,
      amberStrong: Color.lerp(amberStrong, other.amberStrong, t)!,
      amberSoft: Color.lerp(amberSoft, other.amberSoft, t)!,
      amberLine: Color.lerp(amberLine, other.amberLine, t)!,
      red: Color.lerp(red, other.red, t)!,
      redDeep: Color.lerp(redDeep, other.redDeep, t)!,
      redSoft: Color.lerp(redSoft, other.redSoft, t)!,
      redLine: Color.lerp(redLine, other.redLine, t)!,
      primaryBtnBg: Color.lerp(primaryBtnBg, other.primaryBtnBg, t)!,
      primaryBtnInk: Color.lerp(primaryBtnInk, other.primaryBtnInk, t)!,
      secondaryBtnBg: Color.lerp(secondaryBtnBg, other.secondaryBtnBg, t)!,
      bubbleUserBg: Color.lerp(bubbleUserBg, other.bubbleUserBg, t)!,
      bubbleUserInk: Color.lerp(bubbleUserInk, other.bubbleUserInk, t)!,
      bubbleUserLine: Color.lerp(bubbleUserLine, other.bubbleUserLine, t)!,
      shimmerBase: Color.lerp(shimmerBase, other.shimmerBase, t)!,
      shimmerHi: Color.lerp(shimmerHi, other.shimmerHi, t)!,
      permDefaultBg: Color.lerp(permDefaultBg, other.permDefaultBg, t)!,
      permDefaultInk: Color.lerp(permDefaultInk, other.permDefaultInk, t)!,
      permAutoBg: Color.lerp(permAutoBg, other.permAutoBg, t)!,
      permAutoInk: Color.lerp(permAutoInk, other.permAutoInk, t)!,
      permFullBg: Color.lerp(permFullBg, other.permFullBg, t)!,
      permFullInk: Color.lerp(permFullInk, other.permFullInk, t)!,
      permFullLine: Color.lerp(permFullLine, other.permFullLine, t)!,
      inputBg: Color.lerp(inputBg, other.inputBg, t)!,
      inputLine: Color.lerp(inputLine, other.inputLine, t)!,
      scrim: Color.lerp(scrim, other.scrim, t)!,
      codeBg: Color.lerp(codeBg, other.codeBg, t)!,
      codeInk: Color.lerp(codeInk, other.codeInk, t)!,
      diffAddBg: Color.lerp(diffAddBg, other.diffAddBg, t)!,
      diffAddInk: Color.lerp(diffAddInk, other.diffAddInk, t)!,
      diffDelBg: Color.lerp(diffDelBg, other.diffDelBg, t)!,
      diffDelInk: Color.lerp(diffDelInk, other.diffDelInk, t)!,
    );
  }
}

/// 语义字阶：档位与 tokens.css --fs-*/--lh-* 对应（不随明暗变化）。
///
/// mono 恒用 JetBrainsMono；界面文字一律 sans（Inter + 系统 CJK 回退）。
@immutable
class AimiText extends ThemeExtension<AimiText> {
  /// 构建一套语义字阶。
  const AimiText({
    required this.display,
    required this.sheetTitle,
    required this.title,
    required this.section,
    required this.row,
    required this.needsTitle,
    required this.chip,
    required this.sessionTitle,
    required this.body,
    required this.agent,
    required this.meta,
    required this.micro,
    required this.mono,
    required this.monoSmall,
  });

  /// 页面大标题（会话/看板）26/32 w600 -3.5%。
  final TextStyle display;

  /// sheet 标题（审批/提问）22/28 w600 -3%。
  final TextStyle sheetTitle;

  /// 区块标题 16/22 w600。
  final TextStyle section;

  /// 页面/区块标题 20/26 w600（领起整页或一个面板）。
  final TextStyle title;

  /// 会话行标题 14.5/19 w500（原型 `.session-title`：中量级，不是 600）。
  final TextStyle row;

  /// 待批卡标题 15/20 w600 -1.5%（原型 `.needs-card h3`）。
  final TextStyle needsTitle;

  /// 筛选 chip 12.5/17 w500（原型 `.chip`）。
  final TextStyle chip;

  /// 会话页标题 15/19 w600 -1.5%（原型 `.session-head-title b`）。
  final TextStyle sessionTitle;

  /// 正文 14.5/22。
  final TextStyle body;

  /// 时间线 agent 正文 14/22。
  final TextStyle agent;

  /// 元信息 11.5/15 w500（原型 `.session-meta` / `.needs-meta`）。
  final TextStyle meta;

  /// 微标签 11.5/15。
  final TextStyle micro;

  /// 机器声 10.5/16（机器 pill、工具参数、事件计数）。
  final TextStyle mono;

  /// 机器声（命令井）11.5/17。
  final TextStyle monoSmall;

  /// 字阶本体；family 与 CJK 回退由 [AimiTheme._build] 统一注入。
  static AimiText build() => const AimiText(
    display: TextStyle(
      fontSize: 26,
      height: 32 / 26,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.91, // -3.5% × 26px
    ),
    sheetTitle: TextStyle(
      fontSize: 22,
      height: 28 / 22,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.66, // -3% × 22px
    ),
    title: TextStyle(
      fontSize: 20,
      height: 26 / 20,
      fontWeight: FontWeight.w600,
    ),
    section: TextStyle(
      fontSize: 16,
      height: 22 / 16,
      fontWeight: FontWeight.w600,
    ),
    // 原型 .session-title：14.5/19 **500**（中量级；600 会把整屏喊成同级）。
    row: TextStyle(
      fontSize: 14.5,
      height: 19 / 14.5,
      fontWeight: FontWeight.w500,
      letterSpacing: -0.007,
    ),
    needsTitle: TextStyle(
      fontSize: 15,
      height: 20 / 15,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.225, // -1.5% × 15px
    ),
    chip: TextStyle(
      fontSize: 12.5,
      height: 17 / 12.5,
      fontWeight: FontWeight.w500,
      letterSpacing: -0.006,
    ),
    sessionTitle: TextStyle(
      fontSize: 15,
      height: 19 / 15,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.225, // -1.5% × 15px
    ),
    body: TextStyle(fontSize: 14.5, height: 22 / 14.5),
    // 会话正文：15/24（-0.3% 字距）。汉字笔画密，14px 视觉小于同级拉丁正文；
    // 提到 15 并放宽行高，正文灰度与可读性对齐 Claude/Codex 的中文口径。
    agent: TextStyle(fontSize: 15, height: 24 / 15, letterSpacing: -0.045),
    meta: TextStyle(
      fontSize: 11.5,
      height: 15 / 11.5,
      fontWeight: FontWeight.w500,
    ),
    micro: TextStyle(fontSize: 11, height: 15 / 11),
    mono: TextStyle(
      fontFamily: 'JetBrainsMono',
      fontSize: 10.5,
      height: 16 / 10.5,
    ),
    // 原型 .tool-well：11px / 17px（命令井、展开输出）。
    monoSmall: TextStyle(
      fontFamily: 'JetBrainsMono',
      fontSize: 11,
      height: 17 / 11,
    ),
  );

  @override
  AimiText copyWith({
    TextStyle? display,
    TextStyle? sheetTitle,
    TextStyle? title,
    TextStyle? section,
    TextStyle? row,
    TextStyle? needsTitle,
    TextStyle? chip,
    TextStyle? sessionTitle,
    TextStyle? body,
    TextStyle? agent,
    TextStyle? meta,
    TextStyle? micro,
    TextStyle? mono,
    TextStyle? monoSmall,
  }) => AimiText(
    display: display ?? this.display,
    sheetTitle: sheetTitle ?? this.sheetTitle,
    title: title ?? this.title,
    section: section ?? this.section,
    row: row ?? this.row,
    needsTitle: needsTitle ?? this.needsTitle,
    chip: chip ?? this.chip,
    sessionTitle: sessionTitle ?? this.sessionTitle,
    body: body ?? this.body,
    agent: agent ?? this.agent,
    meta: meta ?? this.meta,
    micro: micro ?? this.micro,
    mono: mono ?? this.mono,
    monoSmall: monoSmall ?? this.monoSmall,
  );

  @override
  AimiText lerp(AimiText? other, double t) => other is! AimiText ? this : this;
}

/// 主题装配：M3 骨架 + [AimiColors]/[AimiText] 扩展 + 组件主题。
abstract final class AimiTheme {
  /// 浅色主题。
  static ThemeData light() => _build(AimiColors.light, Brightness.light);

  /// 深色主题。
  static ThemeData dark() => _build(AimiColors.dark, Brightness.dark);

  static ThemeData _build(AimiColors c, Brightness brightness) {
    final t = AimiText.build();
    final scheme =
        ColorScheme.fromSeed(
          seedColor: c.accent,
          brightness: brightness,
        ).copyWith(
          // M3 组件语义位对齐 token：让未迁移组件先不吃亏。
          primary: c.primaryBtnBg,
          onPrimary: c.primaryBtnInk,
          secondary: c.secondaryBtnBg,
          onSecondary: c.ink,
          surface: c.surfaceSolid,
          onSurface: c.ink,
          onSurfaceVariant: c.ink2,
          outline: c.lineStrong,
          error: c.red,
          onError: c.surfaceSolid,
        );
    // sans 档位统一补 Inter 字族与 CJK 回退（mono 档位在 AimiText 内自带）。
    TextStyle sans(TextStyle s) => s.copyWith(
      fontFamily: 'Inter',
      fontFamilyFallback: const <String>[
        'PingFang SC',
        'HarmonyOS Sans SC',
        'Microsoft YaHei UI',
        'Microsoft YaHei',
      ],
    );
    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: c.canvas,
      textTheme: TextTheme(
        displayLarge: sans(t.display),
        displayMedium: sans(t.display),
        displaySmall: sans(t.title),
        headlineLarge: sans(t.title),
        headlineMedium: sans(t.title),
        headlineSmall: sans(t.section),
        titleLarge: sans(t.title),
        titleMedium: sans(t.row),
        titleSmall: sans(t.meta),
        bodyLarge: sans(t.body),
        bodyMedium: sans(t.body),
        bodySmall: sans(t.meta),
        labelLarge: sans(t.meta),
        labelMedium: sans(t.micro),
        labelSmall: sans(t.micro),
      ),
      extensions: <ThemeExtension<dynamic>>[c, t],
      appBarTheme: AppBarTheme(
        backgroundColor: Colors.transparent,
        foregroundColor: c.ink,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: sans(t.display),
        systemOverlayStyle: brightness == Brightness.light
            ? SystemUiOverlayStyle.dark
            : SystemUiOverlayStyle.light,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: c.primaryBtnBg,
          foregroundColor: c.primaryBtnInk,
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.all(AimiRadius.pill),
          ),
          textStyle: sans(t.meta),
          minimumSize: const Size(64, 50),
          padding: const EdgeInsets.symmetric(horizontal: 24),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          backgroundColor: c.secondaryBtnBg,
          foregroundColor: c.ink,
          side: BorderSide.none,
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.all(AimiRadius.pill),
          ),
          textStyle: sans(t.meta),
          minimumSize: const Size(64, 50),
          padding: const EdgeInsets.symmetric(horizontal: 24),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: c.ink2,
          textStyle: sans(t.meta),
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.all(AimiRadius.pill),
          ),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        // 输入井：inset 表面，focus 只换边线不换填充（design.md §4.0）。
        filled: true,
        fillColor: c.inputBg,
        hintStyle: sans(t.meta).copyWith(color: c.ink3),
        border: OutlineInputBorder(
          borderRadius: const BorderRadius.all(AimiRadius.inputWell),
          borderSide: BorderSide(color: c.inputLine),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: const BorderRadius.all(AimiRadius.inputWell),
          borderSide: BorderSide(color: c.inputLine),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: const BorderRadius.all(AimiRadius.inputWell),
          borderSide: BorderSide(color: c.lineStrong),
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 12,
        ),
      ),
      switchTheme: SwitchThemeData(
        // 轨道尺寸在 SwitchThemeData 无直接字段，由 _AimiSwitch 组件按 token 施加（44×26）。
        thumbColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? c.canvas : c.ink3,
        ),
        trackColor: WidgetStateProperty.resolveWith(
          (states) =>
              states.contains(WidgetState.selected) ? c.ink : c.surface3,
        ),
      ),
      dividerTheme: DividerThemeData(color: c.line, thickness: 1, space: 1),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: c.surfaceSolid,
        contentTextStyle: sans(t.meta).copyWith(color: c.ink),
        behavior: SnackBarBehavior.floating,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(AimiRadius.pill),
        ),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: AimiRadius.sheet),
        ),
        showDragHandle: true,
      ),
    );
  }
}
