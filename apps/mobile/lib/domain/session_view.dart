import '../data/protocol/frame_dto.dart';

/// 时间线项：事件流转换成的可渲染领域项（纯函数产物，零 IO）。
///
/// 当前界面只用五种：文本（相邻 `text_delta` 合并）、工具调用、工具结果、通知、状态徽标。
/// 其余归一化事件（thinking/usage/permission/question/exit）暂不渲染，见 [timelineOf]。
sealed class TimelineItem {
  const TimelineItem();
}

/// 一段连续流式文本（相邻 `text_delta` 合并后的结果）。
class TextTimelineItem extends TimelineItem {
  const TextTimelineItem(this.text);

  /// 合并后的完整文本；尚未截断，截断是 [dashboardSubtitle] 的职责
  final String text;
}

/// 一次工具调用的卡片头（`tool_call`）。
///
/// 按到达顺序与随后的 [ToolResultTimelineItem] 相邻排列；界面以相同的 [id] 且相邻判定
/// 「成对折叠为一张卡」，更完整的收合/展开交互后续版本再补。
class ToolCallTimelineItem extends TimelineItem {
  const ToolCallTimelineItem({
    required this.id,
    required this.name,
    required this.summary,
    required this.inputDigest,
  });

  /// 工具调用 id：与随后的 [ToolResultTimelineItem.id] 相同即视为一对
  final String id;

  /// 工具名（如 Bash/Edit）
  final String name;

  /// 入参摘要（可直接展示的一行）
  final String summary;

  /// 入参摘要哈希；用于判断两次调用是否同参，同参调用可折叠为一条（尚未接入）
  final String inputDigest;
}

/// 工具结果（`tool_result`）；[ok] 为 false 时 UI 显示失败态。
class ToolResultTimelineItem extends TimelineItem {
  const ToolResultTimelineItem({
    required this.id,
    required this.ok,
    required this.outputExcerpt,
    this.exitCode,
  });

  /// 与 [ToolCallTimelineItem.id] 配对的工具调用 id
  final String id;

  /// 是否成功；false 时 UI 显示失败态
  final bool ok;

  /// 输出摘录，server 侧已截断
  final String outputExcerpt;

  /// 退出码；null 表示服务端未提供
  final int? exitCode;
}

/// 提示条（`notice`）；[severity] 取 info/warn/error。
class NoticeTimelineItem extends TimelineItem {
  const NoticeTimelineItem({required this.severity, required this.text});

  /// 严重级，取值限 info/warn/error，决定 UI 颜色；取值域由协议层保证
  final String severity;

  /// 提示文案，原样展示给用户
  final String text;
}

/// 状态徽标（`state`）；界面用灰卡加状态色呈现，等待态的交互后续版本再补。
class StateTimelineItem extends TimelineItem {
  const StateTimelineItem(this.state);

  /// 协议状态值，文案映射见 [stateLabel]
  final String state;
}

class ThinkingTimelineItem extends TimelineItem {
  const ThinkingTimelineItem(this.text);
  final String text;
}

class UsageTimelineItem extends TimelineItem {
  const UsageTimelineItem({
    required this.tokensIn,
    required this.tokensOut,
    this.cost,
  });
  final int tokensIn;
  final int tokensOut;
  final double? cost;
}

class PermissionTimelineItem extends TimelineItem {
  const PermissionTimelineItem({
    required this.id,
    required this.title,
    required this.detail,
    required this.options,
  });
  final String id;
  final String title;
  final String detail;
  final List<ApprovalOptionDto> options;
}

class QuestionTimelineItem extends TimelineItem {
  const QuestionTimelineItem({
    required this.id,
    required this.prompt,
    required this.options,
  });
  final String id;
  final String prompt;
  final List<ChoiceDto> options;
}

class ExitTimelineItem extends TimelineItem {
  const ExitTimelineItem({required this.exitCode, required this.durationMs});
  final int? exitCode;
  final int durationMs;
}

/// 会话状态的用户可见文案；未知状态原样回显（不静默吞掉协议新增值）。
String stateLabel(String state) => switch (state) {
  'starting' => '启动中',
  'running' => '运行中',
  'waiting_approval' => '等待审批',
  'waiting_input' => '等待回答',
  'finished' => '已完成',
  'failed' => '已失败',
  'stopped' => '已停止',
  _ => state,
};

/// 把事件流转换成可渲染的时间线项（纯函数，无 IO）。
///
/// 规则：相邻 `text_delta` 合并为一条 [TextTimelineItem]；`tool_call`/`tool_result` 各成一项
/// 顺序排列；`state` 成 [StateTimelineItem] 徽标；`notice` 成 [NoticeTimelineItem]。
/// 所有协议事件均映射为领域项；UI 可按状态选择折叠或呈现。
List<TimelineItem> timelineOf(List<AgentEventDto> events) {
  final items = <TimelineItem>[];
  for (final event in events) {
    switch (event.type) {
      case 'text_delta':
        final text = event.text ?? '';
        final last = items.isEmpty ? null : items.last;
        if (last is TextTimelineItem) {
          items[items.length - 1] = TextTimelineItem(last.text + text);
        } else {
          items.add(TextTimelineItem(text));
        }
      case 'tool_call':
        items.add(
          ToolCallTimelineItem(
            id: event.id ?? '',
            name: event.name ?? '',
            summary: event.summary ?? '',
            inputDigest: event.inputDigest ?? '',
          ),
        );
      case 'tool_result':
        items.add(
          ToolResultTimelineItem(
            id: event.id ?? '',
            ok: event.ok ?? false,
            outputExcerpt: event.outputExcerpt ?? '',
            exitCode: event.exitCode,
          ),
        );
      case 'notice':
        items.add(
          NoticeTimelineItem(
            severity: event.severity ?? 'info',
            text: event.text ?? '',
          ),
        );
      case 'state':
        items.add(StateTimelineItem(event.state ?? ''));
      case 'thinking':
        items.add(ThinkingTimelineItem(event.text ?? ''));
      case 'usage':
        items.add(
          UsageTimelineItem(
            tokensIn: event.tokensIn ?? 0,
            tokensOut: event.tokensOut ?? 0,
            cost: event.cost,
          ),
        );
      case 'permission':
        items.add(
          PermissionTimelineItem(
            id: event.id ?? '',
            title: event.title ?? '需要审批',
            detail: event.detail ?? '',
            options: event.options ?? const [],
          ),
        );
      case 'question':
        items.add(
          QuestionTimelineItem(
            id: event.id ?? '',
            prompt: event.prompt ?? '',
            options: event.choices ?? const [],
          ),
        );
      case 'exit':
        items.add(
          ExitTimelineItem(
            exitCode: event.exitCode,
            durationMs: event.durationMs ?? 0,
          ),
        );
    }
  }
  return items;
}

/// 看板卡副标题：该会话最后一条 `text_delta` 的前 [maxLength] 个字符；无文本时回落状态文案。
///
/// 按 Unicode 码点截断，避免把代理对（emoji）切成半个字符——否则 UI 会出现替换字符。
String dashboardSubtitle(
  List<AgentEventDto> events,
  String state, {
  int maxLength = 80,
}) {
  String? latest;
  for (final event in events) {
    if (event.type == 'text_delta' && event.text != null) {
      latest = event.text;
    }
  }
  if (latest == null) return stateLabel(state);

  final runes = latest.runes.toList();
  if (runes.length <= maxLength) return latest;
  return String.fromCharCodes(runes.sublist(0, maxLength));
}
