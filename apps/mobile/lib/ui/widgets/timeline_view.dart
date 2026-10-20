import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../domain/session_view.dart';
import '../icons/aimi_icons.dart';
import 'aimi_primitives.dart';

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
  /// [onResume]：失败行上的「续接」动作（聚焦 composer）。
  const TimelineView({
    super.key,
    required this.view,
    required this.agentLabel,
    this.onOpenApproval,
    this.onOpenQuestion,
    this.onResume,
    this.pendingRequestId,
  });

  /// 回合视图（domain 层 [conversationOf] 的产物）。
  final ConversationView view;

  /// agent 显示名（回合标签，如 "Claude Code"）。
  final String agentLabel;

  /// 打开审批 sheet。
  final void Function(PermissionTimelineItem item)? onOpenApproval;

  /// 打开提问 sheet。
  final void Function(QuestionTimelineItem item)? onOpenQuestion;

  /// 失败后「续接」。
  final VoidCallback? onResume;

  /// 当前待批请求 id：用于把对应的审批卡渲染为可点入口（其余为只读留痕）。
  final String? pendingRequestId;

  @override
  Widget build(BuildContext context) {
    final blocks = <Widget>[];
    for (final item in view.lead) {
      final widget = _buildItem(item);
      if (widget != null) blocks.add(widget);
    }
    for (final turn in view.turns) {
      blocks.add(
        DefaultTextStyle.merge(
          style: TextStyle(color: context.ai.ink),
          child: _TurnBlock(
            turn: turn,
            agentLabel: agentLabel,
            itemBuilder: _buildItem,
            onResume: onResume,
          ),
        ),
      );
    }
    for (final item in view.trailing) {
      final widget = _buildItem(item);
      if (widget != null) blocks.add(widget);
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
        TextTimelineItem() => _AgentText(text: item.text),
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
        UsageTimelineItem() => _UsageRow(item: item),
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
    this.onResume,
  });

  final AgentTurn turn;
  final String agentLabel;
  final Widget? Function(TimelineItem item) itemBuilder;
  final VoidCallback? onResume;

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

    // 终态 state 项与 exit 项不逐条渲染：统一成一行的终态提示。
    String? terminal;
    ExitTimelineItem? exit;
    for (final item in turn.items) {
      if (item is StateTimelineItem) {
        if (item.state == 'finished' || item.state == 'failed' || item.state == 'stopped') {
          terminal = item.state;
        }
        continue;
      }
      if (item is ExitTimelineItem) {
        exit = item;
        continue;
      }
      final w = itemBuilder(item);
      if (w == null) continue;
      children.add(w);
      children.add(const SizedBox(height: AimiSpace.s2));
    }
    if (terminal != null) {
      children.add(_TerminalRow(state: terminal, exit: exit, onResume: onResume));
    } else if (children.isNotEmpty) {
      children.removeLast(); // 去掉末尾多余的空隙
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children);
  }
}

/// agent 回合标签：16px 头像圆 + 名称（11px），只承担「切分多轮对话」。
class _AgentLabel extends StatelessWidget {
  const _AgentLabel({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 16,
          height: 16,
          decoration: BoxDecoration(shape: BoxShape.circle, color: ai.surface2),
          alignment: Alignment.center,
          child: AimiIcon(data: AimiIcons.spark, size: 9, color: ai.ink3),
        ),
        const SizedBox(width: 6),
        Text(label, style: tt.micro.copyWith(color: ai.ink3)),
      ],
    );
  }
}

/// agent 正文：14/22，可选中复制。
class _AgentText extends StatelessWidget {
  const _AgentText({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    return SelectableText(text, style: context.tt.agent.copyWith(color: ai.ink));
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
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.84),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
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
              Text(item.text, style: tt.agent.copyWith(color: ai.bubbleUserInk)),
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

/// 思考行：折叠 pill「思考了 N 秒」，展开显示思考文本。
class _ThinkingRow extends StatelessWidget {
  const _ThinkingRow({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    // 事件流不带思考时长，按文本量给一个量级估计（不假装精确）。
    final seconds = (text.runes.length / 55).ceil().clamp(1, 99);
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        dense: true,
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(bottom: 4),
        minTileHeight: 32,
        leading: AimiIcon(data: AimiIcons.clock, size: 13, color: ai.ink3),
        title: Text('思考了 $seconds 秒', style: tt.micro.copyWith(color: ai.ink3)),
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              text.isEmpty ? '（无内容）' : text,
              style: tt.micro.copyWith(color: ai.ink3, fontStyle: FontStyle.italic),
            ),
          ),
        ],
      ),
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
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      child: Row(
        children: [
          AimiIcon(data: _iconFor(call.name), size: 14, color: ai.ink3),
          const SizedBox(width: 8),
          Text(call.name, style: tt.meta.copyWith(color: ai.ink)),
          if (call.summary.isNotEmpty) ...[
            const SizedBox(width: 8),
            Expanded(
              child: AimiMono(call.summary, style: tt.monoSmall, color: ai.ink2),
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
    if (lower.contains('bash') || lower.contains('shell') || lower.contains('exec')) {
      return AimiIcons.terminal;
    }
    if (lower.contains('edit') || lower.contains('write') || lower.contains('patch')) {
      return AimiIcons.pen;
    }
    if (lower.contains('grep') || lower.contains('search') || lower.contains('glob')) {
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
          AimiIcon(data: result.ok ? AimiIcons.check : AimiIcons.close, size: 12, color: accent),
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
                        decoration: BoxDecoration(shape: BoxShape.circle, color: fg),
                      )
                    else
                      AimiBreathingDot(color: fg, size: 6, halo: ai.amberSoft),
                    const SizedBox(width: 6),
                    Text(stale ? '审批已失效' : '待批', style: tt.micro.copyWith(color: fg)),
                    const Spacer(),
                    if (!stale) AimiIcon(data: AimiIcons.chevron, size: 13, color: fg),
                  ],
                ),
                const SizedBox(height: 6),
                Text(item.title, style: tt.meta.copyWith(color: ai.ink)),
                if (item.detail.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
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
            AimiBreathingDot(color: ai.amberStrong, size: 6, halo: ai.amberSoft),
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

/// 终态行：完成灰勾 / 失败红叉 + 续接 / 停止灰暂停。
class _TerminalRow extends StatelessWidget {
  const _TerminalRow({required this.state, this.exit, this.onResume});

  final String state;
  final ExitTimelineItem? exit;
  final VoidCallback? onResume;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final failed = state == 'failed';
    final color = failed ? ai.red : ai.ink3;
    final label = switch (state) {
      'failed' => '进程已退出',
      'stopped' => '已停止',
      _ => '已完成',
    };
    final exitSuffix = exit == null ? '' : ' · ${exit!.durationMs ~/ 1000}s';
    return Row(
      children: [
        AimiIcon(
          data: switch (state) {
            'failed' => AimiIcons.close,
            'stopped' => AimiIcons.pause,
            _ => AimiIcons.check,
          },
          size: 13,
          color: color,
        ),
        const SizedBox(width: 6),
        Text('$label$exitSuffix', style: tt.micro.copyWith(color: color)),
        const Spacer(),
        if (failed)
          TextButton(
            onPressed: onResume,
            style: TextButton.styleFrom(
              minimumSize: const Size(44, 32),
              padding: const EdgeInsets.symmetric(horizontal: 8),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: Text('续接', style: tt.micro.copyWith(color: ai.ink2)),
          ),
      ],
    );
  }
}

/// 用量行：降为 meta 行（机器声数字，不抢正文）。
class _UsageRow extends StatelessWidget {
  const _UsageRow({required this.item});

  final UsageTimelineItem item;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final cost = item.cost == null ? '' : ' · \$${item.cost!.toStringAsFixed(3)}';
    return AimiMono(
      '用量 ${item.tokensIn} / ${item.tokensOut}$cost',
      style: tt.monoSmall,
      color: ai.ink3,
    );
  }
}
