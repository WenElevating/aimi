import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../domain/session_view.dart';
import '../icons/aimi_icons.dart';
import '../session/turn_actions.dart';
import 'aimi_primitives.dart';
import '../session/markdown_text.dart';
import '../session/shimmer_line.dart';

/// 会话时间线：回合制渲染（用户气泡 + agent 标签 + 回合内各类项）。
///
/// 与旧版平铺列表的差别（对齐 prototypes/codex/screens/session.html）：
/// - 用户消息右对齐气泡，agent 回答左对齐；
/// - **每个回答回合只出现一次 agent 标签**，同回合的续写/工具卡/思考不再重复；
/// - 工具调用与配对结果合并为一张可折叠卡（原型 `.tool-card`），输出在 mono 井里；
/// - 审批/提问在时间线里只留一张入口卡，决策动作在 sheet 上完成；
/// - 收盘回合末尾有动作行（复制/赞/踩，见 [TurnActionsRow]）。
class TimelineView extends StatefulWidget {
  /// 展示一个会话的完整回合视图。
  ///
  /// [onOpenApproval] / [onOpenQuestion]：点「待批」卡与提问卡时打开对应 sheet；
  /// [onTurnFeedback]：点回合动作行「没帮助」时打开回合反馈弹层。
  const TimelineView({
    super.key,
    required this.view,
    required this.agentLabel,
    this.onOpenApproval,
    this.onOpenQuestion,
    this.onTurnFeedback,
    this.pendingRequestId,
    this.showShimmer = false,
    this.showArchivedHint = false,
    this.onFork,
    this.settled = true,
  });

  /// 回合视图（domain 层 [conversationOf] 的产物）。
  final ConversationView view;

  /// agent 显示名（回合标签，如 "Claude Code"）。
  final String agentLabel;

  /// 打开审批 sheet。
  final void Function(PermissionTimelineItem item)? onOpenApproval;

  /// 打开提问 sheet。
  final void Function(QuestionTimelineItem item)? onOpenQuestion;

  /// 打开回合反馈弹层（点「没帮助」）。
  final VoidCallback? onTurnFeedback;

  /// 当前待批请求 id：用于把对应的审批卡渲染为可点入口（其余为只读留痕）。
  final String? pendingRequestId;

  /// 当前回合生成期间在回复尾部显示过渡行。
  final bool showShimmer;

  /// 不可续接（归档）会话：时间线末尾挂静态「已归档，仅供查看」提示条
  /// （无动作、不弹窗，对齐原型失效卡口径）。
  final bool showArchivedHint;

  /// 点回合动作行「分叉」时的回调；null = 服务端未声明分叉能力（按钮置灰）。
  /// 经稳定回调边界传递（同 [_handleTurnFeedback]），缓存回合不持旧闭包。
  final VoidCallback? onFork;

  /// 会话是否处于终态（finished/failed/stopped）。
  ///
  /// 只有终态（或非最后回合）才渲染回合动作行：流式中的回合可能还没说完，
  /// 先不给复制/评价，避免复制半截回答。
  final bool settled;

  @override
  State<TimelineView> createState() => _TimelineViewState();
}

/// 复用未变化回合的 widget 子树，流式追加只重建当前输出块。
class _TimelineViewState extends State<TimelineView> {
  final Map<AgentTurn, ({Widget child, bool shimmer, bool actions})>
  _turnWidgets = {};
  String? _cachedLabel;
  String? _cachedPending;
  Color? _cachedInk;

  /// 缓存不可变回合和稳定回调；当前回合的新快照自动替换旧缓存。
  Widget _turnBlock(
    AgentTurn turn, {
    required bool showShimmer,
    required bool showActions,
  }) {
    final cached = _turnWidgets[turn];
    if (cached != null &&
        cached.shimmer == showShimmer &&
        cached.actions == showActions) {
      return cached.child;
    }
    final child = DefaultTextStyle.merge(
      style: TextStyle(color: context.ai.ink),
      child: _TurnBlock(
        turn: turn,
        agentLabel: widget.agentLabel,
        itemBuilder: _buildItem,
        showShimmer: showShimmer,
        showActions: showActions,
        onTurnFeedback: _handleTurnFeedback,
        onFork: _handleFork,
      ),
    );
    _turnWidgets[turn] = (
      child: child,
      shimmer: showShimmer,
      actions: showActions,
    );
    return child;
  }

  /// 经稳定方法调用最新页面回调，缓存回合不会持有旧页面闭包。
  void _handleApproval(PermissionTimelineItem item) =>
      widget.onOpenApproval?.call(item);

  /// 提问卡与审批卡采用相同的稳定回调边界。
  void _handleQuestion(QuestionTimelineItem item) =>
      widget.onOpenQuestion?.call(item);

  /// 使用最新回合反馈入口，同时保持历史子树身份。
  void _handleTurnFeedback() => widget.onTurnFeedback?.call();

  /// 使用最新分叉入口，同时保持历史子树身份。
  void _handleFork() => widget.onFork?.call();

  @override
  Widget build(BuildContext context) {
    if (_cachedLabel != widget.agentLabel ||
        _cachedPending != widget.pendingRequestId ||
        _cachedInk != context.ai.ink) {
      _turnWidgets.clear();
      _cachedLabel = widget.agentLabel;
      _cachedPending = widget.pendingRequestId;
      _cachedInk = context.ai.ink;
    }
    final liveTurns = widget.view.turns.toSet();
    _turnWidgets.removeWhere((turn, _) => !liveTurns.contains(turn));
    final blocks = <Widget>[];
    for (final item in widget.view.lead) {
      final widget = _buildItem(item);
      if (widget != null) blocks.add(widget);
    }
    for (var index = 0; index < widget.view.turns.length; index++) {
      final turn = widget.view.turns[index];
      final isLast = index == widget.view.turns.length - 1;
      if (turn.prompts.isEmpty &&
          !turn.hasRenderableContent &&
          !(widget.showShimmer && isLast)) {
        continue;
      }
      blocks.add(
        _turnBlock(
          turn,
          showShimmer:
              widget.showShimmer && isLast && widget.view.trailing.isEmpty,
          showActions: !isLast || (widget.settled && !widget.showShimmer),
        ),
      );
    }
    for (final item in widget.view.trailing) {
      final widget = _buildItem(item);
      if (widget != null) blocks.add(widget);
    }
    // 开局过渡块：尚无可挂靠的已开盘回合时，在用户消息之下直接起势——
    // 全新会话（无任何回合）或已发送但回合尚未开盘（等 starting 锚定）。
    if (widget.showShimmer &&
        (widget.view.turns.isEmpty || widget.view.trailing.isNotEmpty)) {
      blocks.add(
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _AgentLabel(label: widget.agentLabel),
            const SizedBox(height: AimiSpace.s2),
            const ShimmerLine(),
          ],
        ),
      );
    }
    if (widget.showArchivedHint) blocks.add(const _ArchivedHint());
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final block in blocks)
          Padding(
            padding: const EdgeInsets.only(bottom: AimiSpace.s4),
            child: RepaintBoundary(child: block),
          ),
      ],
    );
  }

  /// 单个时间线项 → widget；不需要渲染的项（如 state/exit 由回合块统一处理）返回 null。
  Widget? _buildItem(TimelineItem item) => switch (item) {
    UserMessageTimelineItem() => _UserBubble(item: item),
    TextTimelineItem() => _AgentText(text: item.text, error: item.error),
    ThinkingTimelineItem() => _ThinkingRow(text: item.text),
    // 合并卡是常态；调用/结果单项只出现在未走 conversationOf 合并的场景
    // （如 timelineOf 平铺映射），兜底渲染为运行中卡/无名卡，不白屏。
    ToolTimelineItem() => _ToolCard(item: item),
    ToolCallTimelineItem() => _ToolCard(
      item: ToolTimelineItem(
        id: item.id,
        name: item.name,
        summary: item.summary,
        ok: null,
        outputExcerpt: '',
      ),
    ),
    ToolResultTimelineItem() => _ToolCard(
      item: ToolTimelineItem(
        id: item.id,
        name: '',
        summary: '',
        ok: item.ok,
        outputExcerpt: item.outputExcerpt,
        exitCode: item.exitCode,
      ),
    ),
    NoticeTimelineItem() => _NoticeBar(item: item),
    PermissionTimelineItem() => _ApprovalCard(
      item: item,
      active: widget.pendingRequestId == item.id,
      onTap: _handleApproval,
    ),
    QuestionTimelineItem() => _QuestionCard(item: item, onTap: _handleQuestion),
    // 原型不展示用量/花费（session.html 无对应节点）：不渲染，避免每段话后多一行噪音。
    UsageTimelineItem() => null,
    // state/exit 由回合块的终态行统一渲染，避免同一事实出现两次。
    StateTimelineItem() || ExitTimelineItem() => null,
  };
}

/// 一个回答回合：用户提问（若有）→ agent 标签 → 回合内各项 → 动作行。
class _TurnBlock extends StatelessWidget {
  const _TurnBlock({
    required this.turn,
    required this.agentLabel,
    required this.itemBuilder,
    this.showShimmer = false,
    this.showActions = false,
    this.onTurnFeedback,
    this.onFork,
  });

  final AgentTurn turn;
  final String agentLabel;
  final Widget? Function(TimelineItem item) itemBuilder;
  final bool showShimmer;

  /// 是否在回合末尾渲染动作行（复制/赞/踩）。
  final bool showActions;

  /// 点「没帮助」时的回调（透传给动作行）。
  final VoidCallback? onTurnFeedback;

  /// 点「分叉」时的回调（透传给动作行；null=能力未声明，按钮置灰）。
  final VoidCallback? onFork;

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
    // 终态行已按用户要求移除（失败/停止/完成都不画）：失败原因由回复位置的
    // 红色文本承载，其余终态对用户无增量信息。
    var hasText = false;
    final texts = <String>[];
    for (final item in turn.items) {
      if (item is StateTimelineItem) continue;
      if (item is TextTimelineItem) {
        hasText = true;
        texts.add(item.text);
      }
      final w = itemBuilder(item);
      if (w == null) continue;
      children.add(w);
      children.add(const SizedBox(height: AimiSpace.s2));
    }
    if (children.isNotEmpty && children.last is SizedBox) {
      // 只裁掉末尾多余的空隙。
      children.removeLast();
    }
    // 生成状态永远落在当前回合内容之后；首 token 到达后仍保持可见，
    // 直到终态或等待用户处理时才淡出。
    if (showShimmer) {
      children.add(const SizedBox(height: AimiSpace.s2));
    }
    children.add(ShimmerHandoff(show: showShimmer));
    // 回合动作行：只在有文字的收盘回合出现（错误回合也给，复制含报错——
    // 与原型 ?state=error 的口径一致）；流式中的回合不渲染。
    if (showActions && hasText) {
      children.add(
        TurnActionsRow(
          turnText: turnCopyText(texts),
          onFeedback: onTurnFeedback,
          onFork: onFork,
        ),
      );
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

/// agent 正文：15/24，可选中复制。
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
    if (!containsMarkdownSyntax(text)) {
      return SelectableText(
        text,
        style: context.tt.agent.copyWith(color: error ? ai.redDeep : ai.ink),
      );
    }
    return MarkdownText(text: text, error: error);
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
                // 气泡与 agent 正文同一排版基线（15/23）；行高略紧于正文（24），
                // 气泡空间小、单行居多。
                style: tt.agent.copyWith(
                  fontSize: 15,
                  height: 23 / 15,
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
          // 展开正文同工具卡口径：淡入+下落 160ms，收起即时。
          AimiBodyIn(
            child: Text(
              widget.text.isEmpty ? '（无内容）' : widget.text,
              style: tt.micro.copyWith(color: ai.ink3),
            ),
          ),
        ],
      ],
    );
  }
}

/// 工具卡（原型 `.tool-card`）：折叠一行（图标+名称+参数摘要+状态+chevron），
/// 点开后命令井展示命令与输出摘录。
///
/// 规格逐字取自 app.css 1009-1080：
/// - 整行头部可点，右侧状态 meta（`.run` 绿 / `.fail` 红）；
/// - 展开动画是 body 淡入+下落 160ms（[AimiBodyIn]），**不做高度补间**——时间线里
///   高度突变更稳；收起即时移除，无动画；
/// - chevron 折叠朝右、展开转 90°（140ms）；
/// - 失败卡（`.tool-card.is-error`）整卡红渐变 + 红边，输出正文不铺红。
class _ToolCard extends StatefulWidget {
  const _ToolCard({required this.item});

  final ToolTimelineItem item;

  @override
  State<_ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<_ToolCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final item = widget.item;
    final failed = item.ok == false;
    // 状态 meta：运行中绿、失败红（含退出码）、成功 ink3；原型 .tool-meta 10.5px。
    final (metaText, metaColor) = switch (item.ok) {
      null => ('运行中', ai.green),
      false => (item.exitCode == null ? '失败' : '退出码 ${item.exitCode}', ai.red),
      true => ('完成', ai.ink3),
    };
    return AimiSurface(
      radius: AimiRadius.row,
      padding: EdgeInsets.zero,
      gradient: failed
          ? LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: <Color>[ai.redSoft, ai.surface],
              stops: const <double>[0, 0.88],
            )
          : null,
      borderColor: failed ? ai.redLine : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            button: true,
            expanded: _expanded,
            child: AimiPressable(
              onTap: () => setState(() => _expanded = !_expanded),
              borderRadius: const BorderRadius.all(AimiRadius.row),
              pressedColor: ai.surface2,
              child: Padding(
                // 原型 .tool-head：padding 10px 11px、gap 7px。
                padding: const EdgeInsets.symmetric(
                  horizontal: 11,
                  vertical: 10,
                ),
                child: Row(
                  children: [
                    AimiIcon(
                      data: _iconFor(item.name),
                      size: 14,
                      color: failed ? ai.red : ai.ink3,
                    ),
                    const SizedBox(width: 7),
                    // 原型 .tool-name：12px / 600 / ink。Flexible 限宽：超长工具名
                    // 省略号收缩，不把右侧状态/chevron 挤出 Row。
                    Flexible(
                      child: Text(
                        item.name.isEmpty ? '工具' : item.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: tt.chip.copyWith(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: ai.ink,
                        ),
                      ),
                    ),
                    if (item.summary.isNotEmpty) ...[
                      const SizedBox(width: 7),
                      // 原型 .tool-arg：10.5 mono / ink-2，单行省略。
                      Expanded(
                        child: AimiMono(
                          item.summary,
                          style: tt.mono,
                          color: ai.ink2,
                        ),
                      ),
                    ] else
                      const Spacer(),
                    const SizedBox(width: 7),
                    Text(metaText, style: tt.mono.copyWith(color: metaColor)),
                    const SizedBox(width: 6),
                    AnimatedRotation(
                      turns: _expanded ? 0.25 : 0,
                      duration: AimiMotion.fast,
                      curve: AimiMotion.ease,
                      child: AimiIcon(
                        data: AimiIcons.chevron,
                        size: 13,
                        color: ai.ink3,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (_expanded)
            AimiBodyIn(
              child: Padding(
                // 原型 .tool-body：0 11px 10px（与头部 11px 对齐）。
                padding: const EdgeInsets.fromLTRB(11, 0, 11, 10),
                child: Container(
                  width: double.infinity,
                  // 原型 .tool-well：padding 9px 10px、radius 10、codeBg/codeInk。
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 9,
                  ),
                  decoration: BoxDecoration(
                    color: ai.codeBg,
                    borderRadius: const BorderRadius.all(AimiRadius.well),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (item.summary.isNotEmpty) ...[
                        SelectableText(
                          '\$ ${item.summary}',
                          style: tt.monoSmall.copyWith(color: ai.codeInk),
                        ),
                        const SizedBox(height: 6),
                      ],
                      if (item.outputExcerpt.isNotEmpty)
                        SelectableText(
                          item.outputExcerpt,
                          style: tt.monoSmall.copyWith(color: ai.codeInk),
                        ),
                    ],
                  ),
                ),
              ),
            ),
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

/// 待批卡（原型 `.approval-inline`）：时间线里唯一的入口（标题 + mono 命令摘要），
/// 点开 sheet 决策；失效后去阴影留痕（`.approval-inline.stale`）。
class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({required this.item, required this.active, this.onTap});

  final PermissionTimelineItem item;
  final bool active;
  final void Function(PermissionTimelineItem item)? onTap;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final stale = !active;
    final fg = stale ? ai.ink3 : ai.amberStrong;
    return Semantics(
      button: !stale,
      label: stale ? '审批已失效' : '待批：${item.title}',
      child: InkWell(
        onTap: stale ? null : () => onTap?.call(item),
        borderRadius: const BorderRadius.all(AimiRadius.row),
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            // 原型 active：surface 平底 + amber 边 + 卡片阴影；stale：换 line 边、去阴影。
            color: ai.surface,
            borderRadius: const BorderRadius.all(AimiRadius.row),
            border: Border.all(color: stale ? ai.line : ai.amberLine),
            boxShadow: stale ? null : AimiShadow.card(dark),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  // 原型 .approval-inline-label .dot：5px 实点。
                  if (stale)
                    Container(
                      width: 5,
                      height: 5,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: fg,
                      ),
                    )
                  else
                    AimiBreathingDot(
                      color: fg,
                      size: 5,
                      halo: ai.amberSoft,
                      // 原型 needs-label 的 amber-pulse：环扩散而非整点呼吸。
                      motion: AimiDotMotion.pulse,
                    ),
                  const SizedBox(width: 6),
                  Text(
                    stale ? '审批已失效' : '待批',
                    // 原型 label：11px / 600 / amber-strong。
                    style: tt.micro.copyWith(
                      fontWeight: FontWeight.w600,
                      color: fg,
                    ),
                  ),
                  const Spacer(),
                  if (!stale)
                    AimiIcon(data: AimiIcons.chevron, size: 13, color: fg),
                ],
              ),
              const SizedBox(height: 6),
              // 原型 .approval-inline p：12.5 / 18 / ink-2。
              Text(
                item.title,
                style: tt.chip.copyWith(
                  fontWeight: FontWeight.w400,
                  height: 18 / 12.5,
                  color: ai.ink2,
                ),
              ),
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
      borderRadius: const BorderRadius.all(AimiRadius.row),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: ai.amberSoft,
          borderRadius: const BorderRadius.all(AimiRadius.row),
          border: Border.all(color: ai.amberLine),
        ),
        child: Row(
          children: [
            AimiBreathingDot(
              color: ai.amberStrong,
              size: 6,
              halo: ai.amberSoft,
              motion: AimiDotMotion.pulse,
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

/// 归档提示条：静态灰面、无动作（原型失效卡口径——灰化、留痕、不弹窗）。
class _ArchivedHint extends StatelessWidget {
  const _ArchivedHint();

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: ai.surface2,
        borderRadius: const BorderRadius.all(AimiRadius.well),
        border: Border.all(color: ai.line),
      ),
      child: Row(
        children: [
          AimiIcon(data: AimiIcons.lock, size: 13, color: ai.ink3),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '会话已归档，仅供查看',
              style: tt.meta.copyWith(color: ai.ink3),
            ),
          ),
        ],
      ),
    );
  }
}
