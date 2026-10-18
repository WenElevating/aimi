import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/domain/session_view.dart';
import 'package:flutter_test/flutter_test.dart';

/// 把归一化事件的 JSON 列表解析成领域 DTO（走真实契约解析路径，不做手工构造）。
List<AgentEventDto> eventsOf(List<Map<String, dynamic>> json) =>
    json.map(AgentEventDto.fromJson).toList();

void main() {
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

  test('timelineOf：工具调用/结果/通知/状态各成一项，M0 域外事件（thinking/usage）不产生项', () {
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

    expect(items, hasLength(6));
    expect((items[0] as StateTimelineItem).state, 'running');
    expect((items[1] as TextTimelineItem).text, '我来看看');
    expect((items[2] as ToolCallTimelineItem).name, 'Bash');
    expect((items[2] as ToolCallTimelineItem).summary, 'ls -la');
    expect((items[3] as ToolResultTimelineItem).id, 't1');
    expect((items[3] as ToolResultTimelineItem).ok, isTrue);
    expect((items[3] as ToolResultTimelineItem).exitCode, 0);
    expect((items[4] as NoticeTimelineItem).severity, 'warn');
    expect((items[5] as StateTimelineItem).state, 'finished');
  });

  test('dashboardSubtitle：取最后一条 text_delta 前 80 字符；无文本回落状态文案', () {
    final long = 'a' * 200;
    expect(dashboardSubtitle(eventsOf([
      {'type': 'text_delta', 'text': long},
    ]), 'running').length, 80);

    // 按 Unicode 码点截断：不切断代理对（emoji 记 1 个字符）。
    final emoji = dashboardSubtitle(eventsOf([
      {'type': 'text_delta', 'text': '😀' * 100},
    ]), 'running');
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
    expect(dashboardSubtitle(eventsOf([
      {'type': 'state', 'state': 'running'},
    ]), 'waiting_approval'), '等待审批');
    expect(dashboardSubtitle(const [], 'finished'), '已完成');
    expect(dashboardSubtitle(const [], 'unknown_state'), 'unknown_state');
  });
}
