import 'dart:collection';

import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/domain/session_view.dart';
import 'package:flutter_test/flutter_test.dart';

/// 生成稳定身份的回合事件，供增量及恢复路径共用。
AgentEventDto _event(String type, {String? text, String? state}) =>
    AgentEventDto(type: type, text: text, state: state);

/// 将可见内容转为值结构，与原有完整投影逐前缀对照，防止增量路径改变分组语义。
List<Object?> _shape(ConversationView view) => [
  view.lead.map(_itemShape).toList(),
  for (final turn in view.turns)
    [
      turn.prompts.map(_itemShape).toList(),
      turn.items.map(_itemShape).toList(),
    ],
  view.trailing.map(_itemShape).toList(),
];

/// 覆盖流式正文、思考、工具配对、回合边界和本机消息的关键字段。
Object _itemShape(TimelineItem item) => switch (item) {
  TextTimelineItem() => ['text', item.text, item.error],
  ThinkingTimelineItem() => ['thinking', item.text],
  ToolTimelineItem() => [
    'tool',
    item.id,
    item.name,
    item.summary,
    item.ok,
    item.outputExcerpt,
  ],
  StateTimelineItem() => ['state', item.state],
  UserMessageTimelineItem() => [
    'prompt',
    item.clientId,
    item.text,
    item.ts,
    item.status,
  ],
  _ => item.runtimeType.toString(),
};

/// 固定长度视图不复制历史，并记录实际事件读取次数以验证增量复杂度。
class _EventPrefix extends ListBase<AgentEventDto> {
  /// 为同一输入创建固定前缀，模拟生产镜像的 O(1) 快照。
  _EventPrefix(this.events, this.count);

  final List<AgentEventDto> events;
  final int count;
  int reads = 0;

  @override
  int get length => count;

  @override
  set length(int value) => throw UnsupportedError('fixed prefix');

  @override
  AgentEventDto operator [](int index) {
    reads++;
    return events[index];
  }

  @override
  void operator []=(int index, AgentEventDto value) =>
      throw UnsupportedError('fixed prefix');
}

void main() {
  test('长历史追加只读取常数个事件，同一回放的完整投影与增量投影最终一致', () {
    final fixture = <AgentEventDto>[];
    for (var turn = 0; turn < 100; turn++) {
      fixture.add(_event('state', state: 'starting'));
      for (var chunk = 0; chunk < 20; chunk++) {
        fixture.add(_event('text_delta', text: 'history:$turn:$chunk '));
      }
      fixture.add(_event('state', state: 'finished'));
    }
    fixture.add(_event('state', state: 'starting'));
    final historyLength = fixture.length;
    for (var chunk = 0; chunk < 300; chunk++) {
      fixture.add(_event('text_delta', text: 'tail:$chunk '));
    }
    // 两种路径先各热身一次，计时仅描述本机 Dart 测试回放，不代表设备帧性能。
    conversationOf(fixture, const []);
    ConversationProjection().update(fixture, const []);
    final fullTime = Stopwatch()..start();
    late ConversationView full;
    for (var count = historyLength; count <= fixture.length; count++) {
      full = conversationOf(_EventPrefix(fixture, count), const []);
    }
    fullTime.stop();
    final incremental = ConversationProjection();
    incremental.update(_EventPrefix(fixture, historyLength), const []);
    final incrementTime = Stopwatch()..start();
    late ConversationView projected;
    for (var count = historyLength + 1; count <= fixture.length; count++) {
      final input = _EventPrefix(fixture, count);
      projected = incremental.update(input, const []);
      expect(
        input.reads,
        lessThanOrEqualTo(6),
        reason: 'append must not scan history',
      );
    }
    incrementTime.stop();
    expect(_shape(projected), _shape(full));
    // ignore: avoid_print
    print(
      '[projection bench] history=$historyLength deltas=300 full=${fullTime.elapsedMicroseconds}us incremental=${incrementTime.elapsedMicroseconds}us',
    );
  });

  test('工具穿插、多轮及无回合历史在每个事件前缀都与完整投影一致', () {
    final projection = ConversationProjection();
    final events = <AgentEventDto>[
      _event('text_delta', text: 'legacy'),
      _event('state', state: 'starting'),
      _event('thinking', text: 'think'),
      _event('thinking', text: ' more'),
      const AgentEventDto(
        type: 'tool_call',
        id: 't',
        name: 'Bash',
        summary: 'pwd',
      ),
      const AgentEventDto(type: 'permission', id: 'p'),
      const AgentEventDto(
        type: 'tool_result',
        id: 't',
        ok: true,
        outputExcerpt: '/tmp',
      ),
      _event('text_delta', text: 'first'),
      _event('text_delta', text: ' reply'),
      _event('state', state: 'finished'),
      _event('state', state: 'starting'),
      _event('text_delta', text: 'second'),
      _event('state', state: 'finished'),
    ];
    const prompts = [
      SentPrompt(clientId: '2', text: 'second', ts: 2, status: 'sent'),
      SentPrompt(clientId: '1', text: 'first', ts: 1, status: 'sent'),
    ];
    for (var length = 0; length <= events.length; length++) {
      final prefix = events.take(length).toList();
      expect(
        _shape(projection.update(prefix, prompts)),
        _shape(conversationOf(prefix, prompts)),
        reason: 'prefix=$length',
      );
    }
  });

  test('追加当前回合不会重新投影已完成的历史回合', () {
    final projection = ConversationProjection();
    final events = <AgentEventDto>[
      _event('state', state: 'starting'),
      _event('text_delta', text: 'history'),
      _event('state', state: 'finished'),
      _event('state', state: 'starting'),
      _event('text_delta', text: 'a'),
    ];
    final initial = projection.update(events, const []);
    events.add(_event('text_delta', text: 'b'));
    final next = projection.update(events, const []);
    expect(identical(initial.turns.first, next.turns.first), isTrue);
    expect(
      initial.turns.last.items.whereType<TextTimelineItem>().single.text,
      'a',
    );
    expect(
      next.turns.last.items.whereType<TextTimelineItem>().single.text,
      'ab',
    );
    expect(identical(next, projection.update(events, const [])), isTrue);
  });

  test('重放插入会重建投影，终态冲刷后文本不丢失或重复', () {
    final projection = ConversationProjection();
    final start = _event('state', state: 'starting');
    final tail = _event('text_delta', text: 'b');
    projection.update([start, tail], const []);
    final next = projection.update([
      start,
      _event('text_delta', text: 'a'),
      tail,
      _event('state', state: 'finished'),
    ], const []);
    expect(
      next.turns.single.items.whereType<TextTimelineItem>().single.text,
      'ab',
    );
    expect(
      (next.turns.single.items.last as StateTimelineItem).state,
      'finished',
    );
  });

  test('本机消息到达及投递状态变化会重新锚定回合', () {
    final projection = ConversationProjection();
    final events = [
      _event('state', state: 'starting'),
      _event('text_delta', text: 'ok'),
    ];
    projection.update(events, const []);
    final view = projection.update(events, const [
      SentPrompt(clientId: 'p1', text: 'question', ts: 1, status: 'sent'),
    ]);
    expect(
      (view.turns.single.prompts.single as UserMessageTimelineItem).text,
      'question',
    );
    final failed = projection.update(events, const [
      SentPrompt(clientId: 'p1', text: 'question', ts: 1, status: 'failed'),
    ]);
    expect(
      (failed.turns.single.prompts.single as UserMessageTimelineItem).status,
      'failed',
    );
  });
}
