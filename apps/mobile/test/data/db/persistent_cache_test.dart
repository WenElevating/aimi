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
      await thirdDatabase.close();
      await directory.delete(recursive: true);
    },
  );
}
