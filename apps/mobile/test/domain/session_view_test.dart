import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/domain/session_view.dart';
import 'package:flutter_test/flutter_test.dart';

/// 把归一化事件的 JSON 列表解析成领域 DTO（走真实契约解析路径，不做手工构造）。
List<AgentEventDto> eventsOf(List<Map<String, dynamic>> json) =>
    json.map(AgentEventDto.fromJson).toList();

void main() {

  test('旧本地数据（无 error 标记）按内容特征补标失败文本', () {
    // 协议 error 字段是后加的：重启前落库的失败回复没有它，
    // 恢复后必须仍按失败渲染（暗红），不能显示成正常正文。
    final legacy = AgentEventDto.fromJson({
      'type': 'text_delta',
      'text': 'Failed to authenticate. API Error: 403 当前令牌无权访问所选分组',
    });
    expect(legacy.error, isFalse);
    final view = conversationOf(
      [
        AgentEventDto.fromJson({'type': 'state', 'state': 'starting'}),
        legacy,
      ],
      const [],
    );
    final item = view.turns.single.items.whereType<TextTimelineItem>().single;
    expect(item.error, isTrue);
  });

  test('正常回复不会被误判为失败文本', () {
    final view = conversationOf(
      [
        AgentEventDto.fromJson({'type': 'state', 'state': 'starting'}),
        AgentEventDto.fromJson({'type': 'text_delta', 'text': 'Failed to authenticate 是什么意思？'}),
        AgentEventDto.fromJson({'type': 'text_delta', 'text': '这是正常回答。'}),
      ],
      const [],
    );
    final texts = view.turns.single.items.whereType<TextTimelineItem>().toList();
    expect(texts.single.error, isFalse);
  });

  test('timelineOf：相邻 text_delta 合并为一条文本项（中间被 state 打断则另起一条）', () {
    final merged = timelineOf(
      eventsOf([
        {'type': 'text_delta', 'text': '你好'},
        {'type': 'text_delta', 'text': '，世界'},
        {'type': 'text_delta', 'text': '！'},
      ]),
    );
    expect(merged, hasLength(1));
    expect((merged.single as TextTimelineItem).text, '你好，世界！');

    final interrupted = timelineOf(
      eventsOf([
        {'type': 'text_delta', 'text': '甲'},
        {'type': 'state', 'state': 'waiting_approval'},
        {'type': 'text_delta', 'text': '乙'},
      ]),
    );
    expect(interrupted, hasLength(3));
    expect((interrupted[1] as StateTimelineItem).state, 'waiting_approval');
    expect((interrupted[2] as TextTimelineItem).text, '乙');
  });

  test('timelineOf：全部协议事件均有领域映射', () {
    final items = timelineOf(
      eventsOf([
        {'type': 'state', 'state': 'running'},
        {'type': 'thinking', 'text': '内部推理'},
        {'type': 'text_delta', 'text': '我来看看'},
        {
          'type': 'tool_call',
          'id': 't1',
          'name': 'Bash',
          'summary': 'ls -la',
          'inputDigest': 'ab12cd',
        },
        {
          'type': 'tool_result',
          'id': 't1',
          'ok': true,
          'outputExcerpt': 'a.txt',
          'exitCode': 0,
        },
        {'type': 'usage', 'tokensIn': 10, 'tokensOut': 20},
        {'type': 'notice', 'severity': 'warn', 'text': '注意上下文'},
        {'type': 'state', 'state': 'finished'},
      ]),
    );

    expect(items, hasLength(8));
    expect((items[0] as StateTimelineItem).state, 'running');
    expect(items[1], isA<ThinkingTimelineItem>());
    expect((items[2] as TextTimelineItem).text, '我来看看');
    expect((items[3] as ToolCallTimelineItem).name, 'Bash');
    expect((items[3] as ToolCallTimelineItem).summary, 'ls -la');
    expect((items[4] as ToolResultTimelineItem).id, 't1');
    expect((items[4] as ToolResultTimelineItem).ok, isTrue);
    expect((items[4] as ToolResultTimelineItem).exitCode, 0);
    expect(items[5], isA<UsageTimelineItem>());
    expect((items[6] as NoticeTimelineItem).severity, 'warn');
    expect((items[7] as StateTimelineItem).state, 'finished');
  });

  test('timelineOf：空 thinking 不产生可见项，非空 thinking 保留', () {
    final items = timelineOf(
      eventsOf([
        {'type': 'thinking', 'text': ''},
        {'type': 'thinking', 'text': '先检查事件顺序'},
      ]),
    );
    expect(items, hasLength(1));
    expect((items.single as ThinkingTimelineItem).text, '先检查事件顺序');
  });

  test('dashboardSubtitle：取最后一条 text_delta 前 80 字符；无文本回落状态文案', () {
    final long = 'a' * 200;
    expect(
      dashboardSubtitle(
        eventsOf([
          {'type': 'text_delta', 'text': long},
        ]),
        'running',
      ).length,
      80,
    );

    // 按 Unicode 码点截断：不切断代理对（emoji 记 1 个字符）。
    final emoji = dashboardSubtitle(
      eventsOf([
        {'type': 'text_delta', 'text': '😀' * 100},
      ]),
      'running',
    );
    expect(emoji.runes.length, 80);
    expect(emoji.startsWith('😀'), isTrue);

    // 多条 text_delta 时取最后一条。
    expect(
      dashboardSubtitle(
        eventsOf([
          {'type': 'text_delta', 'text': '甲'},
          {'type': 'text_delta', 'text': '乙'},
        ]),
        'running',
      ),
      '乙',
    );

    // 无 text_delta → 状态文案。
    expect(
      dashboardSubtitle(
        eventsOf([
          {'type': 'state', 'state': 'running'},
        ]),
        'waiting_approval',
      ),
      '等待审批',
    );
    expect(dashboardSubtitle(const [], 'finished'), '已完成');
    expect(dashboardSubtitle(const [], 'unknown_state'), 'unknown_state');
  });

  test('conversationOf：每个 starting 开新回合，用户消息锚定在其后的回合', () {
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'state', 'state': 'running'},
        {'type': 'text_delta', 'text': '第一答'},
        {'type': 'state', 'state': 'finished'},
        {'type': 'state', 'state': 'starting'},
        {'type': 'text_delta', 'text': '第二答'},
        {'type': 'state', 'state': 'finished'},
      ]),
      const [
        SentPrompt(clientId: 'c1', text: '第一问', ts: 1, status: 'sent'),
        SentPrompt(clientId: 'c2', text: '第二问', ts: 2, status: 'sent'),
      ],
    );
    expect(view.turns, hasLength(2));
    expect(view.lead, isEmpty);
    expect(view.trailing, isEmpty);
    // 回归口径：回合 1 的用户消息必须是「第一问」，不能被后续回合抢走。
    expect(
      view.turns[0].prompts.map((e) => (e as UserMessageTimelineItem).text),
      ['第一问'],
    );
    expect(
      view.turns[1].prompts.map((e) => (e as UserMessageTimelineItem).text),
      ['第二问'],
    );
    expect((view.turns[0].items.last as StateTimelineItem).state, 'finished');
  });

  test('conversationOf：无事件时用户消息落 trailing（新会话首屏可见）', () {
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
      ]),
      const [SentPrompt(clientId: 'c9', text: '新问题', ts: 9, status: 'queued')],
    );
    // starting 已开回合，消息归该回合。
    expect(view.turns.single.prompts, hasLength(1));

    final empty = conversationOf(const [], const [
      SentPrompt(clientId: 'c9', text: '新问题', ts: 9, status: 'queued'),
    ]);
    expect(empty.turns, isEmpty);
    expect(empty.trailing, hasLength(1));
    expect(empty.isEmpty, isFalse);
  });

  test('conversationOf：同回合相邻 thinking 合并，且回合内保留工具卡顺序', () {
    final view = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'thinking', 'text': '甲'},
        {'type': 'thinking', 'text': '乙'},
        {
          'type': 'tool_call',
          'id': 't1',
          'name': 'Bash',
          'summary': 'pnpm test',
          'inputDigest': 'd1',
        },
        {'type': 'tool_result', 'id': 't1', 'ok': true, 'outputExcerpt': 'ok'},
        {'type': 'text_delta', 'text': '完成'},
      ]),
      const [],
    );
    final items = view.turns.single.items;
    expect(items[1], isA<ThinkingTimelineItem>());
    expect((items[1] as ThinkingTimelineItem).text, '甲乙');
    expect(items[2], isA<ToolCallTimelineItem>());
    expect(items[3], isA<ToolResultTimelineItem>());
    expect((items.last as TextTimelineItem).text, '完成');
    expect(view.turns.single.hasAgentOutput, isTrue);
  });

  test('conversationOf：空 thinking 不结束首 token 过渡，有内容才交接', () {
    final emptyThinking = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'thinking', 'text': ''},
      ]),
      const [],
    );
    expect(emptyThinking.turns.single.hasAgentOutput, isFalse);

    final approval = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {
          'type': 'permission',
          'id': 'req-1',
          'title': 'Bash · pnpm build',
          'detail': 'pnpm build',
          'options': const [
            {'label': '允许一次', 'kind': 'once'},
          ],
        },
      ]),
      const [],
    );
    expect(approval.turns.single.hasAgentOutput, isFalse);
    expect(approval.turns.single.hasRenderableContent, isTrue);

    final visibleThinking = conversationOf(
      eventsOf([
        {'type': 'state', 'state': 'starting'},
        {'type': 'thinking', 'text': '先看一下上下文'},
      ]),
      const [],
    );
    expect(visibleThinking.turns.single.hasAgentOutput, isTrue);
  });
}
