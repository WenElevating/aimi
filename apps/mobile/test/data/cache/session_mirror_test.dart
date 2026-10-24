import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:flutter_test/flutter_test.dart';

SessionMetaDto meta({String state = 'running', int lastSeq = 0}) =>
    SessionMetaDto(
      id: 's1',
      agentId: 'claude',
      cwd: 'C:/work',
      permissionMode: 'default',
      state: state,
      lastSeq: lastSeq,
      createdAt: 1,
      updatedAt: 2,
      resumable: true,
    );

SessionEventFrameDto event(int seq, String type, {String state = 'running'}) =>
    SessionEventFrameDto(
      sessionId: 's1',
      seq: seq,
      ts: seq + 10,
      agentEvent: AgentEventDto(
        type: type,
        state: type == 'state' ? state : null,
        text: type == 'text_delta' ? 'x' : null,
      ),
    );

void main() {
  test(
    'welcome upsert does not move event cursor and missing sessions archive',
    () {
      final mirror = SessionMirror();
      mirror.upsertWelcome([meta(lastSeq: 9)]);
      expect(mirror.resumeCursors(), isEmpty);
      mirror.applyEvent(event(0, 'state'));
      mirror.upsertWelcome([]);
      expect(mirror.isArchived('s1'), isTrue);
      expect(mirror.resumeCursors(), {'s1': 0});
    },
  );

  test(
    'duplicate and out-of-order events are retained once, lastSeq is max',
    () {
      final mirror = SessionMirror()..upsertWelcome([meta()]);
      expect(mirror.applyEvent(event(3, 'text_delta')), isTrue);
      expect(mirror.applyEvent(event(1, 'text_delta')), isTrue);
      expect(mirror.applyEvent(event(3, 'text_delta')), isFalse);
      expect(mirror.lastSeq('s1'), 3);
      expect(mirror.eventsFor('s1').map((e) => e.seq), [1, 3]);
    },
  );

  test('late state event cannot overwrite newer projected state', () {
    final mirror = SessionMirror()..upsertWelcome([meta()]);
    mirror.applyEvent(event(4, 'state', state: 'finished'));
    mirror.applyEvent(event(2, 'state', state: 'running'));
    expect(mirror.session('s1')?.state, 'finished');
    expect(mirror.eventsFor('s1').length, 2);
  });

  test('noteCreated：新建会话在 welcome 前即可参与 state 投影', () {
    // 回归：手机新建的会话在下次 welcome 前不在镜像里，applyEvent 对未知会话
    // 不投影 state，会话页读到 meta == null——起势过渡与打断态全部失效。
    final mirror = SessionMirror();
    mirror.noteCreated(meta(state: 'starting', lastSeq: -1));
    expect(mirror.session('s1')?.state, 'starting');
    mirror.applyEvent(event(0, 'state', state: 'running'));
    expect(mirror.session('s1')?.state, 'running');
    mirror.applyEvent(event(1, 'state', state: 'finished'));
    expect(mirror.session('s1')?.state, 'finished');
    expect(mirror.sessionsSnapshot().single.state, 'finished');
  });

  test('restore derives cursor for events without a session row (foreign session)', () {
    // 生产损坏形态：广播来的事件被持久化，但该会话没有 sessions 行——
    // 恢复后若光标缺失，resumeCursors 不得产出越界哨兵 -1（会毒化整个 hello）。
    final mirror = SessionMirror(
      initialState: SessionMirrorSnapshot(
        sessions: const [],
        events: [event(0, 'state'), event(2, 'text_delta')],
        lastSeq: const {},
        stateSeq: const {},
        archived: const {},
      ),
    );
    expect(mirror.resumeCursors(), {'s1': 2});
  });

  test('resumeCursors skips sessions without any usable cursor', () {
    // 双保险：即使光标推导不出来（无事件、无元数据），也不允许出现 -1。
    final mirror = SessionMirror(
      initialState: SessionMirrorSnapshot(
        sessions: const [],
        events: const [],
        lastSeq: const {},
        stateSeq: const {},
        archived: const {},
      ),
    );
    expect(mirror.resumeCursors(), isEmpty);
  });

  test('offline queue writes, retries, cancels and orders by timestamp', () {
    final store = OutgoingMessageStore();
    store.enqueue(clientId: 'c2', sessionId: 's1', text: 'b', ts: 2);
    store.enqueue(clientId: 'c1', sessionId: 's1', text: 'a', ts: 1);
    expect(store.queuedInTsOrder().map((m) => m.clientId), ['c1', 'c2']);
    store.markFailed('c1', 'timeout', retryable: true);
    expect(store.get('c1')?.status, OutgoingMessageStatus.queued);
    store.markFailed('c1', 'timeout', retryable: true);
    store.markFailed('c1', 'timeout', retryable: true);
    expect(store.get('c1')?.status, OutgoingMessageStatus.failed);
    expect(store.cancelQueued('c2'), isTrue);
    expect(store.cancelQueued('c1'), isFalse);
  });

  test('noteCreated/noteConfigured 触发 changes 通知；事件帧路径不触发', () async {
    // 回归：noteCreated/noteConfigured 是不经连接的镜像直写，必须发 changes
    // 通知驱动 cacheTicks——否则新建会话页首帧读到过期快照（meta 为 null，
    // 回合标签退回 'Agent'、起势过渡不出现，直到 CLI 起帧的 running 事件）。
    final mirror = SessionMirror()..upsertWelcome([meta()]);
    var notified = 0;
    final sub = mirror.changes.listen((_) => notified++);
    addTearDown(sub.cancel);

    mirror.applyEvent(event(0, 'text_delta'));
    await Future<void>.delayed(Duration.zero);
    expect(notified, 0, reason: '事件帧路径由 cacheTicks 的事件流覆盖，不走 changes');

    mirror.noteCreated(meta(state: 'starting', lastSeq: -1));
    mirror.noteConfigured('s1', model: 'opus');
    await Future<void>.delayed(Duration.zero);
    expect(notified, 2, reason: '本机直写各发一次通知');
    expect(mirror.session('s1')?.model, 'opus');
  });
}
