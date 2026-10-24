import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../domain/session_view.dart';
import '../icons/aimi_icons.dart';
import 'aimi_primitives.dart';
import '../session/shimmer_line.dart';

/// 会话时间线：回合制渲染（用户气泡 + agent 标签 + 回合内各类项）。
///
/// 与旧版平铺列表的差别（对齐 prototypes/codex/screens/session.html）：
/// - 用户消息右对齐气泡，agent 回答左对齐；
/// - **每个回答回合只出现一次 agent 标签**，同回合的续写/工具卡/思考不再重复；
/// - 工具调用与结果各成一行卡；结果输出在 mono 井里折叠展开；
/// - 审批/提问在时间线里只留一张入口卡，决策动作在 sheet 上完成。
class TimelineView extends StatelessWidget {
  /// 展示一个会话的完整回合视图。
  ///
  /// [onOpenApproval] / [onOpenQuestion]：点「待批」卡与提问卡时打开对应 sheet；
  const TimelineView({
    super.key,
    required this.view,
    required this.agentLabel,
    this.onOpenApproval,
    this.onOpenQuestion,
    this.pendingRequestId,
    this.showShimmer = false,
  });

  /// 回合视图（domain 层 [conversationOf] 的产物）。
  final ConversationView view;

  /// agent 显示名（回合标签，如 "Claude Code"）。
  final String agentLabel;

  /// 打开审批 sheet。
  final void Function(PermissionTimelineItem item)? onOpenApproval;

  /// 打开提问 sheet。
  final void Function(QuestionTimelineItem item)? onOpenQuestion;

  /// 当前待批请求 id：用于把对应的审批卡渲染为可点入口（其余为只读留痕）。
  final String? pendingRequestId;

  /// 首个可见 agent 输出前显示原型的过渡行。
  final bool showShimmer;

  @override
  Widget build(BuildContext context) {
    final blocks = <Widget>[];
    for (final item in view.lead) {
      final widget = _buildItem(item);
      if (widget != null) blocks.add(widget);
    }
    for (var index = 0; index < view.turns.length; index++) {
      final turn = view.turns[index];
      final isLast = index == view.turns.length - 1;
      if (turn.prompts.isEmpty &&
          !turn.hasRenderableContent &&
          !(showShimmer && isLast)) {
        continue;
      }
      blocks.add(
        DefaultTextStyle.merge(
          style: TextStyle(color: context.ai.ink),
          child: _TurnBlock(
            turn: turn,
            agentLabel: agentLabel,
            itemBuilder: _buildItem,
            // 回合内起势只发生在"回合已开盘"的窗口（trailing 为空）；
            // trailing 非空时起势由其下的开局过渡块承载，不重复挂进旧回合。
            showShimmer: showShimmer && isLast && view.trailing.isEmpty,
          ),
        ),
      );
    }
    for (final item in view.trailing) {
      final widget = _buildItem(item);
      if (widget != null) blocks.add(widget);
    }
    // 开局过渡块：尚无可挂靠的已开盘回合时，在用户消息之下直接起势——
    // 全新会话（无任何回合）或已发送但回合尚未开盘（等 starting 锚定）。
    if (showShimmer && (view.turns.isEmpty || view.trailing.isNotEmpty)) {
      blocks.add(
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _AgentLabel(label: agentLabel),
            const SizedBox(height: AimiSpace.s2),
            const ShimmerLine(),
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final block in blocks)
          Padding(
            padding: const EdgeInsets.only(bottom: AimiSpace.s4),
            child: block,
          ),
      ],
    );
  }

  /// 单个时间线项 → widget；不需要渲染的项（如 state/exit 由回合块统一处理）返回 null。
  Widget? _buildItem(TimelineItem item) => switch (item) {
    UserMessageTimelineItem() => _UserBubble(item: item),
    TextTimelineItem() => _AgentText(text: item.text, error: item.error),
    ThinkingTimelineItem() => _ThinkingRow(text: item.text),
    ToolCallTimelineItem() => _ToolRow(call: item),
    ToolResultTimelineItem() => _ToolResultRow(result: item),
    NoticeTimelineItem() => _NoticeBar(item: item),
    PermissionTimelineItem() => _ApprovalCard(
      item: item,
      active: pendingRequestId == item.id,
      onTap: onOpenApproval,
    ),
    QuestionTimelineItem() => _QuestionCard(item: item, onTap: onOpenQuestion),
    // 原型不展示用量/花费（session.html 无对应节点）：不渲染，避免每段话后多一行噪音。
    UsageTimelineItem() => null,
    // state/exit 由回合块的终态行统一渲染，避免同一事实出现两次。
    StateTimelineItem() || ExitTimelineItem() => null,
  };
}

/// 一个回答回合：用户提问（若有）→ agent 标签 → 回合内各项 → 终态行。
class _TurnBlock extends StatelessWidget {
  const _TurnBlock({
    required this.turn,
    required this.agentLabel,
    required this.itemBuilder,
    this.showShimmer = false,
  });

  final AgentTurn turn;
  final String agentLabel;
  final Widget? Function(TimelineItem item) itemBuilder;
  final bool showShimmer;

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[];
    for (final prompt in turn.prompts) {
      final w = itemBuilder(prompt);
      if (w == null) continue;
      children.add(w);
      children.add(const SizedBox(height: AimiSpace.s3));
    }
    // agent 标签：每回合一次（design.md §3.3）。
    children.add(_AgentLabel(label: agentLabel));
    children.add(const SizedBox(height: AimiSpace.s2));
    // 起势行挂在回合内：showShimmer 翻 false 时走 180ms 淡出交棒，不闪没。
    children.add(ShimmerHandoff(show: showShimmer));

    // 终态行已按用户要求移除（失败/停止/完成都不画）：失败原因由回复位置的
    // 红色文本承载，其余终态对用户无增量信息。
    for (final item in turn.items) {
      if (item is StateTimelineItem) continue;
      final w = itemBuilder(item);
      if (w == null) continue;
      children.add(w);
      children.add(const SizedBox(height: AimiSpace.s2));
    }
    if (children.isNotEmpty && children.last is SizedBox) {
      // 只裁掉末尾多余的空隙；shimmer 起势行（非 SizedBox）不得误删——
      // 有用户消息的运行回合正是"标签 + shimmer"形态。
      children.removeLast();
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    );
  }
}

/// agent 回合标签（原型 `.agent-label`）：16px 圆形字母头像 + 名称。
///
/// 规格逐字取自 app.css：`font-size 11px`、`weight 500`、`color ink-3`、`gap 6px`；
/// 头像是 **surface-3 底 + 首字母**（8.5px / 600），不是图标——用图标会读成"功能入口"。
class _AgentLabel extends StatelessWidget {
  const _AgentLabel({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final initial = label.isEmpty ? '?' : label.characters.first.toUpperCase();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 16,
          height: 16,
          decoration: BoxDecoration(shape: BoxShape.circle, color: ai.surface3),
          alignment: Alignment.center,
          child: Text(
            initial,
            style: tt.micro.copyWith(
              fontSize: 8.5,
              height: 1,
              fontWeight: FontWeight.w600,
              color: ai.ink2,
            ),
          ),
        ),
        const SizedBox(width: 6),
        Text(
          label,
          style: tt.micro.copyWith(
            fontSize: 11,
            height: 1.25,
            fontWeight: FontWeight.w500,
            color: ai.ink3,
          ),
        ),
      ],
    );
  }
}

/// agent 正文：14/22，可选中复制。
class _AgentText extends StatelessWidget {
  const _AgentText({required this.text, this.error = false});

  /// 回复正文。
  final String text;

  /// 失败原因文本（协议 `text_delta.error`）：暗红色呈现，不用通知条。
  /// why 暗红而非主题 red：亮红在暗色主题下接近正常输出的高亮感，
  /// 用户会误读成模型正文；暗红一眼可辨"这是失败"。
  final bool error;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    return SelectableText(
      text,
      style: context.tt.agent.copyWith(color: error ? ai.redDeep : ai.ink),
    );
  }
}

/// 用户消息气泡：右对齐、只比画布强一档的中性 tint（design.md §4.0）。
class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.item});

  final UserMessageTimelineItem item;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final failed = item.status == 'failed';
    final queued = item.status == 'queued';
    return Align(
      alignment: Alignment.centerRight,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.84,
        ),
        child: Container(
          // 原型 .msg-user：padding 9px 13px、14/21、圆角 18 18 5 18。
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 9),
          decoration: BoxDecoration(
            color: ai.bubbleUserBg,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(18),
              topRight: Radius.circular(18),
              bottomLeft: Radius.circular(18),
              bottomRight: Radius.circular(5),
            ),
            border: Border.all(color: ai.bubbleUserLine),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                item.text,
                style: tt.agent.copyWith(
                  fontSize: 14,
                  height: 21 / 14,
                  color: ai.bubbleUserInk,
                ),
              ),
              if (failed || queued) ...[
                const SizedBox(height: 2),
                Text(
                  failed ? '发送失败' : '待发送',
                  style: tt.micro.copyWith(color: failed ? ai.red : ai.amber),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 思考行（原型 `.thinking-row`）：靠左的 pill，chevron-down + 「思考了 N 秒」。
///
/// 规格逐字取自 app.css：`inline-flex`、`padding 4px 9px`、pill 圆角、`surface` 底、
/// 1px 发丝线、11px / ink-3、图标 12px 且**是 chevron-down**（展开指示，不是时钟）。
/// 展开后的思考正文放在药丸下方，保持左对齐。
class _ThinkingRow extends StatefulWidget {
  const _ThinkingRow({required this.text});

  final String text;

  @override
  State<_ThinkingRow> createState() => _ThinkingRowState();
}

class _ThinkingRowState extends State<_ThinkingRow> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    // 事件流不带思考时长，按文本量给一个量级估计（不假装精确）。
    final seconds = (widget.text.runes.length / 55).ceil().clamp(1, 99);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: AimiPressable(
            onTap: () => setState(() => _expanded = !_expanded),
            borderRadius: const BorderRadius.all(AimiRadius.pill),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
              decoration: BoxDecoration(
                color: ai.surface,
                borderRadius: const BorderRadius.all(AimiRadius.pill),
                border: Border.all(color: ai.line),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  AnimatedRotation(
                    turns: _expanded ? 0.5 : 0,
                    duration: AimiMotion.fast,
                    curve: AimiMotion.ease,
                    child: AimiIcon(
                      data: AimiIcons.chevronDown,
                      size: 12,
                      color: ai.ink3,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    '思考了 $seconds 秒',
                    style: tt.micro.copyWith(
                      fontSize: 11,
                      height: 1.25,
                      color: ai.ink3,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        if (_expanded) ...[
          const SizedBox(height: 6),
          Text(
            widget.text.isEmpty ? '（无内容）' : widget.text,
            style: tt.micro.copyWith(color: ai.ink3),
          ),
        ],
      ],
    );
  }
}

/// 工具调用行卡：图标 + 工具名 + mono 参数。
class _ToolRow extends StatelessWidget {
  const _ToolRow({required this.call});

  final ToolCallTimelineItem call;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return AimiSurface(
      radius: AimiRadius.row,
      // 原型 .tool-card：padding 10px 11px。
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 10),
      child: Row(
        children: [
          AimiIcon(data: _iconFor(call.name), size: 14, color: ai.ink3),
          const SizedBox(width: 7),
          // 原型 .tool-name：12px / 600 / ink。
          Text(
            call.name,
            style: tt.chip.copyWith(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: ai.ink,
            ),
          ),
          if (call.summary.isNotEmpty) ...[
            const SizedBox(width: 7),
            // 原型 .tool-arg：10.5 mono / ink-2。
            Expanded(
              child: AimiMono(call.summary, style: tt.mono, color: ai.ink2),
            ),
          ] else
            const Spacer(),
        ],
      ),
    );
  }

  /// 工具名 → 图标（对齐原型 Read/Edit/Bash 的字形映射）。
  static AimiIconData _iconFor(String name) {
    final lower = name.toLowerCase();
    if (lower.contains('bash') ||
        lower.contains('shell') ||
        lower.contains('exec')) {
      return AimiIcons.terminal;
    }
    if (lower.contains('edit') ||
        lower.contains('write') ||
        lower.contains('patch')) {
      return AimiIcons.pen;
    }
    if (lower.contains('grep') ||
        lower.contains('search') ||
        lower.contains('glob')) {
      return AimiIcons.search;
    }
    return AimiIcons.doc;
  }
}

/// 工具结果：一行摘要（成功/失败）+ 可展开的 mono 输出井。
class _ToolResultRow extends StatelessWidget {
  const _ToolResultRow({required this.result});

  final ToolResultTimelineItem result;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final hasOutput = result.outputExcerpt.isNotEmpty;
    final accent = result.ok ? ai.ink3 : ai.red;
    final title = result.ok
        ? '输出 · ${_lineCount(result.outputExcerpt)} 行'
        : '失败${result.exitCode == null ? '' : ' · 退出码 ${result.exitCode}'}';
    if (!hasOutput) {
      return Row(
        children: [
          AimiIcon(
            data: result.ok ? AimiIcons.check : AimiIcons.close,
            size: 12,
            color: accent,
          ),
          const SizedBox(width: 6),
          Text(title, style: tt.micro.copyWith(color: accent)),
        ],
      );
    }
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        dense: true,
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(bottom: 6),
        minTileHeight: 32,
        leading: AimiIcon(
          data: result.ok ? AimiIcons.check : AimiIcons.close,
          size: 13,
          color: accent,
        ),
        title: Text(title, style: tt.micro.copyWith(color: accent)),
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: ai.codeBg,
              borderRadius: const BorderRadius.all(AimiRadius.well),
            ),
            child: SelectableText(
              result.outputExcerpt,
              style: tt.monoSmall.copyWith(color: ai.codeInk),
            ),
          ),
        ],
      ),
    );
  }

  /// 输出行数（一眼判断体量，不展示全文）。
  static int _lineCount(String text) => text.split('\n').length;
}

/// 提示条：info 中性、warn 琥珀、error 红（静态，不做无限闪烁）。
class _NoticeBar extends StatelessWidget {
  const _NoticeBar({required this.item});

  final NoticeTimelineItem item;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final (bg, fg) = switch (item.severity) {
      'warn' => (ai.amberSoft, ai.amberStrong),
      'error' => (ai.redSoft, ai.red),
      _ => (ai.surface2, ai.ink2),
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: const BorderRadius.all(AimiRadius.well),
      ),
      child: Text(item.text, style: tt.micro.copyWith(color: fg)),
    );
  }
}

/// 待批卡：时间线里唯一的入口（标题 + mono 命令摘要），点开 sheet 决策；失效后灰化留痕。
class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({required this.item, required this.active, this.onTap});

  final PermissionTimelineItem item;
  final bool active;
  final void Function(PermissionTimelineItem item)? onTap;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final stale = !active;
    final fg = stale ? ai.ink3 : ai.amberStrong;
    return Semantics(
      button: !stale,
      label: stale ? '审批已失效' : '待批：${item.title}',
      child: Opacity(
        opacity: stale ? 0.75 : 1,
        child: InkWell(
          onTap: stale ? null : () => onTap?.call(item),
          borderRadius: const BorderRadius.all(AimiRadius.card),
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              gradient: stale
                  ? null
                  : LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: <Color>[ai.amberSoft, ai.surface],
                    ),
              color: stale ? ai.surface2 : null,
              borderRadius: const BorderRadius.all(AimiRadius.card),
              border: Border.all(color: stale ? ai.line : ai.amberLine),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    if (stale)
                      Container(
                        width: 6,
                        height: 6,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: fg,
                        ),
                      )
                    else
                      AimiBreathingDot(color: fg, size: 6, halo: ai.amberSoft),
                    const SizedBox(width: 6),
                    Text(
                      stale ? '审批已失效' : '待批',
                      style: tt.micro.copyWith(color: fg),
                    ),
                    const Spacer(),
                    if (!stale)
                      AimiIcon(data: AimiIcons.chevron, size: 13, color: fg),
                  ],
                ),
                const SizedBox(height: 6),
                Text(item.title, style: tt.meta.copyWith(color: ai.ink)),
                if (item.detail.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 8,
                    ),
                    decoration: BoxDecoration(
                      color: ai.codeBg,
                      borderRadius: const BorderRadius.all(AimiRadius.well),
                    ),
                    child: AimiMono(
                      item.detail,
                      style: tt.monoSmall,
                      color: ai.codeInk,
                      maxLines: 3,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 提问卡：时间线留一个入口，答复在 sheet 上完成（决策只在 sheet）。
class _QuestionCard extends StatelessWidget {
  const _QuestionCard({required this.item, this.onTap});

  final QuestionTimelineItem item;
  final void Function(QuestionTimelineItem item)? onTap;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return InkWell(
      onTap: () => onTap?.call(item),
      borderRadius: const BorderRadius.all(AimiRadius.card),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: ai.amberSoft,
          borderRadius: const BorderRadius.all(AimiRadius.card),
          border: Border.all(color: ai.amberLine),
        ),
        child: Row(
          children: [
            AimiBreathingDot(
              color: ai.amberStrong,
              size: 6,
              halo: ai.amberSoft,
            ),
            const SizedBox(width: 6),
            Text('待回答', style: tt.micro.copyWith(color: ai.amberStrong)),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                item.prompt,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: tt.meta.copyWith(color: ai.ink),
              ),
            ),
            AimiIcon(data: AimiIcons.chevron, size: 13, color: ai.amberStrong),
          ],
        ),
      ),
    );
  }
}
