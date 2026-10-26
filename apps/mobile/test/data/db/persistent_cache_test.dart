import 'dart:io';

import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/db/aimi_database.dart';
import 'package:aimi/data/db/persistent_cache.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:flutter_test/flutter_test.dart';

SessionMetaDto _meta() => const SessionMetaDto(
  id: 's1',
  agentId: 'claude',
  cwd: 'C:/work',
  permissionMode: 'default',
  state: 'running',
  lastSeq: 0,
  createdAt: 1,
  updatedAt: 2,
  resumable: true,
);

SessionEventFrameDto _event(int seq) => SessionEventFrameDto(
  sessionId: 's1',
  seq: seq,
  ts: seq + 10,
  agentEvent: const AgentEventDto(type: 'text_delta', text: 'hello'),
);

void main() {
  // 已确认模型要跨 SQLite 重开恢复；旧实测事件不能污染配置选择。
  test(
    'configured model selection survives reopening and welcome remains authoritative',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'aimi-model-cache-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final path = '${directory.path}${Platform.pathSeparator}mirror.sqlite';
      final firstDatabase = AimiDatabase.openFile(path);
      final first = await DriftSessionMirror.open(firstDatabase);
      first.upsertWelcome([_meta().copyWith(model: 'vendor-a/old')]);
      first.applyEvent(
        const SessionEventFrameDto(
          sessionId: 's1',
          seq: 1,
          ts: 2,
          agentEvent: AgentEventDto(type: 'configured', model: 'actual-old'),
        ),
      );
      first.noteConfigured('s1', model: 'vendor-b/new[fast]');
      await first.flushPersistence();
      first.dispose();
      await firstDatabase.close();

      final secondDatabase = AimiDatabase.openFile(path);
      final second = await DriftSessionMirror.open(secondDatabase);
      expect(second.session('s1')?.model, 'vendor-b/new[fast]');
      expect(second.eventsFor('s1').single.agentEvent.model, 'actual-old');
      second.upsertWelcome([_meta().copyWith(model: 'vendor-c/server')]);
      expect(second.session('s1')?.model, 'vendor-c/server');
      await second.flushPersistence();
      second.dispose();
      await secondDatabase.close();
    },
  );

  test(
    'session mirror restores events and cursors after reopening SQLite',
    () async {
      final directory = await Directory.systemTemp.createTemp('aimi-cache-');
      final path = '${directory.path}${Platform.pathSeparator}mirror.sqlite';
      final firstDatabase = AimiDatabase.openFile(path);
      final first = await DriftSessionMirror.open(
        firstDatabase,
        strictSeq: true,
        alignWelcomeCursor: true,
      );
      first.upsertWelcome([_meta()]);
      expect(first.applyEvent(_event(1)), isTrue);
      await first.flushPersistence();
      await firstDatabase.close();

      final secondDatabase = AimiDatabase.openFile(path);
      final second = await DriftSessionMirror.open(
        secondDatabase,
        strictSeq: true,
        alignWelcomeCursor: true,
      );
      expect(second.session('s1')?.state, 'running');
      expect(second.eventsFor('s1').single.seq, 1);
      expect(second.resumeCursors(), {'s1': 1});
      await secondDatabase.close();
      await directory.delete(recursive: true);
    },
  );

  test(
    'outgoing queue restores status and crash recovery survives reopen',
    () async {
      final directory = await Directory.systemTemp.createTemp('aimi-queue-');
      final path = '${directory.path}${Platform.pathSeparator}queue.sqlite';
      final firstDatabase = AimiDatabase.openFile(path);
      final first = await DriftOutgoingMessageStore.open(firstDatabase);
      first.enqueue(clientId: 'c1', sessionId: 's1', text: 'hello', ts: 1);
      first.markFailed('c1', 'timeout');
      await first.flushPersistence();
      await firstDatabase.close();

      final secondDatabase = AimiDatabase.openFile(path);
      final second = await DriftOutgoingMessageStore.open(secondDatabase);
      expect(second.get('c1')?.status, OutgoingMessageStatus.failed);
      second.recoverInFlight();
      await second.flushPersistence();
      await secondDatabase.close();

      final thirdDatabase = AimiDatabase.openFile(path);
      final third = await DriftOutgoingMessageStore.open(thirdDatabase);
      expect(third.queuedInTsOrder().single.clientId, 'c1');
      expect(third.messagesFor('s1').single.text, 'hello');
      await thirdDatabase.close();
      await directory.delete(recursive: true);
    },
  );
}
