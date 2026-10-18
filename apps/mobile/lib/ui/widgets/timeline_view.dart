import 'package:flutter/material.dart';

import '../../domain/session_view.dart';
import 'state_badge.dart';

/// 时间线渲染行：领域项经过「工具调用/结果按 id 邻接折叠」后的展示单元。
///
/// 折叠是**呈现层映射**（不新增领域语义，也不改 `domain/session_view.dart`）：`timelineOf`
/// 产出相邻的 [ToolCallTimelineItem]/[ToolResultTimelineItem] 两项，界面按相同 id 且相邻
/// 判定成对折叠。
sealed class TimelineRowData {
  const TimelineRowData();
}

/// 单条领域项（文本/通知/状态，以及孤立的工具结果由 [ToolCardRowData] 承载）。
class SingleRowData extends TimelineRowData {
  /// 一对一承载一条领域项
  const SingleRowData(this.item);

  /// 待渲染的领域项（文本 / 通知 / 状态，或孤立的工具结果）
  final TimelineItem item;
}

/// 工具卡片：调用与其结果折叠为一张可展开卡。
///
/// [call] 或 [result] 都可能为 null——断线中途进入会话时，时间线上可能只有结果没有调用
/// （重连期间错过的调用不会补发，这是既知后果），此时仍渲染为一张卡而不是丢弃。
class ToolCardRowData extends TimelineRowData {
  /// 允许缺一半：[call] 与 [result] 至少有一个非 null（重连中途进入会话时可能只见其一）。
  const ToolCardRowData({this.call, this.result});

  /// 调用头；null 表示只收到结果
  final ToolCallTimelineItem? call;

  /// 结果；null 表示调用尚未返回，卡片显示「运行中」
  final ToolResultTimelineItem? result;
}

/// 纯函数：相邻且同 id 的 `tool_call`/`tool_result` 折叠为一张卡，其余项一对一。
List<TimelineRowData> foldTimelineRows(List<TimelineItem> items) {
  final rows = <TimelineRowData>[];
  for (var index = 0; index < items.length; index++) {
    final item = items[index];
    if (item is ToolCallTimelineItem) {
      final next = index + 1 < items.length ? items[index + 1] : null;
      if (next is ToolResultTimelineItem && next.id == item.id) {
        rows.add(ToolCardRowData(call: item, result: next));
        index++;
      } else {
        rows.add(ToolCardRowData(call: item));
      }
    } else if (item is ToolResultTimelineItem) {
      rows.add(ToolCardRowData(result: item));
    } else {
      rows.add(SingleRowData(item));
    }
  }
  return rows;
}

/// 会话时间线：`ListView.builder` 虚拟化渲染，洪水场景只重建可见行。
///
/// 纯展示组件：只接收已算好的领域项（`timelineOf` 的产物），不做 IO、不读 provider。
class TimelineView extends StatelessWidget {
  /// [items] 需为 `timelineOf` 产出的、已按 seq 升序的领域项（组件只做折叠，不重排）。
  const TimelineView({super.key, required this.items});

  /// 领域项，需已按 seq 升序；相邻同 id 的工具调用与结果会被折叠成一张卡
  final List<TimelineItem> items;

  @override
  Widget build(BuildContext context) {
    final rows = foldTimelineRows(items);
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 6),
      itemCount: rows.length,
      itemBuilder: (context, index) => TimelineRow(data: rows[index]),
    );
  }
}

/// 单行渲染（文本 / 通知 / 状态 / 工具卡）。
class TimelineRow extends StatelessWidget {
  /// [data] 为已折叠的一行：单条领域项或一张工具卡。
  const TimelineRow({super.key, required this.data});

  /// 该行要渲染的内容（单条领域项或工具卡）
  final TimelineRowData data;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: switch (data) {
        SingleRowData(:final item) => _single(context, item),
        ToolCardRowData(call: final call, result: final result) =>
          _ToolCard(call: call, result: result),
      },
    );
  }

  Widget _single(BuildContext context, TimelineItem item) => switch (item) {
        TextTimelineItem(:final text) => Text(
            text,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        NoticeTimelineItem(:final severity, :final text) => _notice(
            severity,
            text,
          ),
        StateTimelineItem(:final state) => Align(
            alignment: Alignment.centerLeft,
            child: StateBadge(state: state, compact: true),
          ),
        _ => const SizedBox.shrink(),
      };

  Widget _notice(String severity, String text) {
    final color = switch (severity) {
      'warn' => Colors.orange,
      'error' => Colors.red,
      _ => Colors.blueGrey,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
        border: Border(left: BorderSide(color: color, width: 3)),
      ),
      child: Text(text, style: TextStyle(color: color, fontSize: 13)),
    );
  }
}

/// 工具卡：展开后显示结果摘录（等宽字体，便于读日志与代码）。
class _ToolCard extends StatelessWidget {
  const _ToolCard({this.call, this.result});

  final ToolCallTimelineItem? call;
  final ToolResultTimelineItem? result;

  /// 标题文案；缺调用头时退化为工具结果态
  String get _title {
    final name = call?.name ?? '工具结果';
    final summary = call?.summary ?? '';
    return summary.isEmpty ? name : '$name · $summary';
  }

  String get _status {
    final result = this.result;
    if (result == null) return '运行中…';
    if (!result.ok) return '失败';
    final exitCode = result.exitCode;
    return exitCode == null || exitCode == 0 ? '完成' : '完成（退出码 $exitCode）';
  }

  @override
  Widget build(BuildContext context) {
    final result = this.result;
    final failed = result != null && !result.ok;
    return Card(
      margin: EdgeInsets.zero,
      child: ExpansionTile(
        dense: true,
        leading: Icon(
          failed ? Icons.error_outline : Icons.build_outlined,
          size: 18,
          color: failed ? Colors.red : null,
        ),
        title: Text(
          _title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
        ),
        subtitle: Text(_status, style: const TextStyle(fontSize: 11)),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                result?.outputExcerpt.isNotEmpty == true
                    ? result!.outputExcerpt
                    : '（无输出摘录）',
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
