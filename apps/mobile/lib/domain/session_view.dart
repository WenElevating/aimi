import '../data/protocol/frame_dto.dart';

/// 时间线项：事件流转换成的可渲染领域项（纯函数产物，零 IO）。
///
/// 文本（相邻 `text_delta` 合并）、工具调用、工具结果、通知、状态徽标、思考、用量、
/// 审批、提问、进程结束，以及本机发送的用户消息（[UserMessageTimelineItem]）。
sealed class TimelineItem {
  const TimelineItem();
}

/// 一条用户发往 agent 的消息（右对齐气泡）。
///
/// 协议不回显用户输入，此项由本机 `sent_messages` 回填；[status] 用于区分
/// 已送达 / 待发 / 失败（失败的仍留在时间线，避免消息无声消失）。
class UserMessageTimelineItem extends TimelineItem {
  const UserMessageTimelineItem({
    required this.clientId,
    required this.text,
    required this.ts,
    required this.status,
  });

  /// 本机生成的消息 id（幂等键；同一 clientId 只渲染一次）。
  final String clientId;

  /// 消息正文。
  final String text;

  /// 本机发送时刻（毫秒）。
  final int ts;

  /// 投递状态（queued/sent/failed/cancelled）；UI 据此决定是否加弱化标记。
  final String status;
}

/// 一段连续流式文本（相邻 `text_delta` 合并后的结果）。
class TextTimelineItem extends TimelineItem {
  const TextTimelineItem(this.text, {this.error = false});

  /// 合并后的完整文本；尚未截断，截断是 [dashboardSubtitle] 的职责
  final String text;

  /// 是否为失败原因文本（协议 `text_delta.error`）；true 时界面以红色渲染
  final bool error;
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
          items[items.length - 1] = TextTimelineItem(
            last.text + text,
            error: last.error,
          );
        } else {
          items.add(TextTimelineItem(text, error: event.error));
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
        final text = event.text ?? '';
        if (text.trim().isNotEmpty) {
          items.add(ThinkingTimelineItem(text));
        }
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
  return _truncateRunes(latest, maxLength);
}

/// 会话页时间线的回合模型输入：一条待渲染的用户消息（来自本机 sent_messages）。
class SentPrompt {
  const SentPrompt({
    required this.clientId,
    required this.text,
    required this.ts,
    required this.status,
  });

  /// 本机幂等键（同 clientId 只渲染一次）。
  final String clientId;

  /// 消息正文。
  final String text;

  /// 本机发送时刻（毫秒），用于回合内排序。
  final int ts;

  /// 投递状态字符串（OutgoingMessageStatus.name）。
  final String status;
}

/// 一个 agent 回答回合：锚定其后的 agent 侧时间线项。
///
/// 分组规则（不依赖跨机时钟对齐）：每出现一次 `state: starting` 即开始新回合；
/// 回合开始前已存在、尚未归位的用户消息按发送顺序挂到该回合的 [prompts]。
class AgentTurn {
  /// 构建一个回合；[prompts] 为锚定在本回合之前的用户消息（通常 1 条）。
  const AgentTurn({required this.prompts, required this.items});

  /// 触发本回合的用户消息（可能为空：例如服务端恢复后的续跑）。
  final List<TimelineItem> prompts;

  /// 本回合 agent 侧的时间线项（不含 [prompts]）。
  final List<TimelineItem> items;

  /// 回合内是否已出现任何 agent 输出（用于“起势只在首 token 前”判定）。
  bool get hasAgentOutput => items.any(
    (item) =>
        item is TextTimelineItem ||
        (item is ThinkingTimelineItem && item.text.trim().isNotEmpty) ||
        item is ToolCallTimelineItem ||
        item is ToolResultTimelineItem ||
        item is NoticeTimelineItem,
  );

  /// 回合是否包含需要用户看到或处理的业务项，即使尚无 agent 文本输出。
  bool get hasRenderableContent =>
      hasAgentOutput ||
      items.any(
        (item) =>
            item is PermissionTimelineItem || item is QuestionTimelineItem,
      );
}

/// 会话页时间线的完整视图模型：开场（首个回合前的散项）+ 回合序列 + 收尾散项。
class ConversationView {
  /// 构建视图模型。
  const ConversationView({
    required this.lead,
    required this.turns,
    required this.trailing,
  });

  /// 首个 `starting` 之前、且不归属任何用户消息的项（历史遗留/续跑事件）。
  final List<TimelineItem> lead;

  /// 按出现顺序的全部回答回合。
  final List<AgentTurn> turns;

  /// 最后一个回合之后仍在等待归属的用户消息（尚未触发新回合）。
  final List<TimelineItem> trailing;

  /// 是否已有可见 agent 输出；空 thinking 增量不算首 token。
  bool get hasAgentOutput =>
      lead.any(_isVisibleAgentOutput) ||
      turns.any((turn) => turn.hasAgentOutput);

  /// 视图是否为空（空则界面渲染空态）。
  bool get isEmpty => lead.isEmpty && turns.isEmpty && trailing.isEmpty;
}

/// 把「本机用户消息 + agent 事件流」合成为可渲染的回合视图（纯函数，无 IO）。
///
/// 归一化规则：
/// - `text_delta` 相邻合并；同回合内 `thinking` 相邻合并（界面上再折叠为「思考了 N 秒」）；
/// - 每遇 `state: starting` 开新回合，此前所有未归位的用户消息归入该回合；
/// - 回合边界的 `state` 项保留在回合内，由界面决定是否显示（finished/failed 显示为终态行）。
ConversationView conversationOf(
  List<AgentEventDto> events,
  List<SentPrompt> prompts,
) {
  final pending = prompts.toList()
    ..sort((a, b) => a.ts == b.ts ? 0 : (a.ts < b.ts ? -1 : 1));
  var cursor = 0;
  var turnOpen = false;
  var current = <TimelineItem>[];
  var currentPrompts = <TimelineItem>[];
  final turns = <AgentTurn>[];
  final lead = <TimelineItem>[];

  /// 收束当前回合；仅在已开盘时调用。
  void closeTurn() {
    if (!turnOpen) return;
    turns.add(AgentTurn(prompts: currentPrompts, items: current));
    current = <TimelineItem>[];
    currentPrompts = <TimelineItem>[];
    turnOpen = false;
  }

  /// 取出**一条**尚未归位的用户消息作为回合触发消息。
  ///
  /// 每个回合只消费一条：多出来的消息属于尚未开始的后续回合，
  /// 否则第二条提问会被错挂到第一个回答上（用户看到的对话顺序就乱了）。
  List<TimelineItem> takeNextPrompt() {
    if (cursor >= pending.length) return const [];
    final prompt = pending[cursor++];
    return [
      UserMessageTimelineItem(
        clientId: prompt.clientId,
        text: prompt.text,
        ts: prompt.ts,
        status: prompt.status,
      ),
    ];
  }

  /// 把尚未归位的用户消息全部取出（仅用于收尾区）。
  List<TimelineItem> takeAllPending() {
    final taken = <TimelineItem>[];
    while (cursor < pending.length) {
      final prompt = pending[cursor++];
      taken.add(
        UserMessageTimelineItem(
          clientId: prompt.clientId,
          text: prompt.text,
          ts: prompt.ts,
          status: prompt.status,
        ),
      );
    }
    return taken;
  }

  for (final event in events) {
    if (event.type == 'state' && event.state == 'starting') {
      closeTurn();
      // 新回合：消费一条未归位消息作为本回合的触发（可能没有——恢复续跑）。
      currentPrompts = takeNextPrompt();
      turnOpen = true;
      current.add(StateTimelineItem('starting'));
      continue;
    }
    final item = _itemOf(event);
    if (item == null) continue;
    if (!turnOpen) {
      // 尚未开盘：该事件属于开场区，但未归位的用户消息仍要插在其前（保持对话顺序）。
      final orphan = takeAllPending();
      lead.addAll(orphan);
      lead.add(item);
      continue;
    }
    final last = current.isEmpty ? null : current.last;
    if (item is TextTimelineItem && last is TextTimelineItem) {
      current[current.length - 1] = TextTimelineItem(
        last.text + item.text,
        error: last.error || item.error,
      );
    } else if (item is ThinkingTimelineItem && last is ThinkingTimelineItem) {
      current[current.length - 1] = ThinkingTimelineItem(last.text + item.text);
    } else {
      current.add(item);
    }
  }
  closeTurn();
  return ConversationView(lead: lead, turns: turns, trailing: takeAllPending());
}

/// 单事件到时间线项的映射；未知类型返回 null（已由物理解析层丢弃）。
TimelineItem? _itemOf(AgentEventDto event) => switch (event.type) {
  'text_delta' => TextTimelineItem(event.text ?? '', error: event.error),
  'thinking' when (event.text ?? '').trim().isNotEmpty => ThinkingTimelineItem(
    event.text!,
  ),
  'thinking' => null,
  'tool_call' => ToolCallTimelineItem(
    id: event.id ?? '',
    name: event.name ?? '',
    summary: event.summary ?? '',
    inputDigest: event.inputDigest ?? '',
  ),
  'tool_result' => ToolResultTimelineItem(
    id: event.id ?? '',
    ok: event.ok ?? false,
    outputExcerpt: event.outputExcerpt ?? '',
    exitCode: event.exitCode,
  ),
  'notice' => NoticeTimelineItem(
    severity: event.severity ?? 'info',
    text: event.text ?? '',
  ),
  'state' => StateTimelineItem(event.state ?? ''),
  'usage' => UsageTimelineItem(
    tokensIn: event.tokensIn ?? 0,
    tokensOut: event.tokensOut ?? 0,
    cost: event.cost,
  ),
  'permission' => PermissionTimelineItem(
    id: event.id ?? '',
    title: event.title ?? '需要审批',
    detail: event.detail ?? '',
    options: event.options ?? const [],
  ),
  'question' => QuestionTimelineItem(
    id: event.id ?? '',
    prompt: event.prompt ?? '',
    options: event.choices ?? const [],
  ),
  'exit' => ExitTimelineItem(
    exitCode: event.exitCode,
    durationMs: event.durationMs ?? 0,
  ),
  _ => null,
};

/// 可见的 agent 输出用于判断首 token 交接；用户输入和空 thinking 不算。
bool _isVisibleAgentOutput(TimelineItem item) =>
    item is TextTimelineItem ||
    (item is ThinkingTimelineItem && item.text.trim().isNotEmpty) ||
    item is ToolCallTimelineItem ||
    item is ToolResultTimelineItem ||
    item is NoticeTimelineItem;

/// 按码点截断长文本（同 [dashboardSubtitle] 的口径）。
String _truncateRunes(String text, int maxLength) {
  final runes = text.runes.toList();
  if (runes.length <= maxLength) return text;
  return String.fromCharCodes(runes.sublist(0, maxLength));
}
