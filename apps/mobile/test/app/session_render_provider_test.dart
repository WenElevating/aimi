import 'package:aimi/app/session_render_provider.dart';
import 'package:aimi/app/providers.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// 构造服务端已入镜像的事件，明确区分事件接收与界面提交。
SessionEventFrameDto _frame(int seq, String type, {String sessionId = 's1'}) =>
    SessionEventFrameDto(
      sessionId: sessionId,
      seq: seq,
      ts: seq,
      agentEvent: AgentEventDto(type: type, text: '$seq', state: 'finished'),
    );

void main() {
  test('异步缓存恢复后自动载入历史，欢迎元数据不会改变事件快照', () async {
    final cache = SessionMirror();
    cache.applyEvent(_frame(0, 'text_delta'));
    final container = ProviderContainer(
      overrides: [
        cacheProvider.overrideWith((ref) async => cache),
        connectionProvider.overrideWith((ref) => null),
      ],
    );
    final values = <List<AgentEventDto>>[];
    final subscription = container.listen(
      sessionRenderEventsProvider('s1'),
      (_, value) => values.add(value),
      fireImmediately: true,
    );
    expect(values.first, isEmpty);
    await container.read(cacheProvider.future);
    await container.pump();
    await Future<void>.delayed(Duration.zero);
    expect(values.last, hasLength(1));
    final count = values.length;
    cache.upsertWelcome(const []);
    await Future<void>.delayed(Duration.zero);
    expect(values, hasLength(count));
    subscription.close();
    container.dispose();
    cache.dispose();
  });

  testWidgets('重连补发重复 seq 不改变历史，乱序补洞按顺序提交', (tester) async {
    final cache = SessionMirror();
    cache.applyEvent(_frame(1, 'text_delta'));
    cache.applyEvent(_frame(3, 'text_delta'));
    final controller = SessionRenderEventsController(cache, 's1');
    final values = <List<AgentEventDto>>[];
    controller.addListener(values.add, fireImmediately: true);
    // 生产连接仅转发镜像接收成功的帧，重连重复帧不会进入渲染订阅。
    expect(cache.applyEvent(_frame(1, 'text_delta')), isFalse);
    final missing = _frame(2, 'text_delta');
    expect(cache.applyEvent(missing), isTrue);
    controller.onFrame(missing);
    await tester.pump(const Duration(milliseconds: 16));
    expect(values.first.map((event) => event.text), ['1', '3']);
    expect(values.last.map((event) => event.text), ['1', '2', '3']);
    expect(values, hasLength(2));
    controller.dispose();
    cache.dispose();
  });

  testWidgets('同一帧内的文本仅提交一次，其他会话不触发刷新', (tester) async {
    final cache = SessionMirror();
    final controller = SessionRenderEventsController(cache, 's1');
    final seen = <List<AgentEventDto>>[];
    controller.addListener(seen.add, fireImmediately: false);
    for (var seq = 0; seq < 10; seq++) {
      final frame = _frame(seq, 'text_delta');
      cache.applyEvent(frame);
      controller.onFrame(frame);
    }
    expect(cache.eventsFor('s1'), hasLength(10));
    expect(seen, isEmpty);
    await tester.pump(const Duration(milliseconds: 15));
    expect(seen.single, hasLength(10));
    final other = _frame(0, 'text_delta', sessionId: 'other');
    cache.applyEvent(other);
    controller.onFrame(other);
    await tester.pump(const Duration(milliseconds: 16));
    expect(seen, hasLength(1));
    controller.dispose();
    cache.dispose();
  });

  testWidgets('终态立即提交尾部文本，销毁取消尚未提交的窗口', (tester) async {
    final cache = SessionMirror();
    final controller = SessionRenderEventsController(cache, 's1');
    final seen = <List<AgentEventDto>>[];
    controller.addListener(seen.add, fireImmediately: false);
    final delta = _frame(0, 'text_delta');
    cache.applyEvent(delta);
    controller.onFrame(delta);
    final finished = _frame(1, 'state');
    cache.applyEvent(finished);
    controller.onFrame(finished);
    expect(seen.single, hasLength(2));
    expect(seen.single.first.text, '0');
    await tester.pump(const Duration(milliseconds: 16));
    expect(seen, hasLength(1));
    final pending = _frame(2, 'text_delta');
    cache.applyEvent(pending);
    controller.onFrame(pending);
    controller.dispose();
    await tester.pump(const Duration(milliseconds: 16));
    expect(seen, hasLength(1));
    cache.dispose();
  });
}
