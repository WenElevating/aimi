import 'dart:async';
import 'dart:convert';

import 'package:drift/drift.dart';

import '../cache/session_mirror.dart';
import '../protocol/frame_dto.dart';
import 'aimi_database.dart';

/// Drift 对 [SessionMirror] 的持久化实现；每个变更按提交顺序排队。
class DriftSessionMirrorPersistence implements SessionMirrorPersistence {
  DriftSessionMirrorPersistence(this.database);

  final AimiDatabase database;
  Future<void> _tail = Future<void>.value();

  Future<void> _enqueue(Future<void> Function() operation) {
    _tail = _tail.then((_) => operation());
    return _tail;
  }

  @override
  Future<void> upsertWelcome(
    Iterable<SessionMetaDto> sessions,
    Iterable<String> archivedIds,
  ) => _enqueue(() async {
    final rows = sessions.toList(growable: false);
    final archived = archivedIds.toSet();
    await database.transaction(() async {
      for (final session in rows) {
        final existing = await (database.select(
          database.sessions,
        )..where((row) => row.id.equals(session.id))).getSingleOrNull();
        await database
            .into(database.sessions)
            .insertOnConflictUpdate(
              SessionsCompanion.insert(
                id: session.id,
                agentId: session.agentId,
                cwd: session.cwd,
                permissionMode: session.permissionMode,
                state: session.state,
                lastSeq: existing?.lastSeq ?? session.lastSeq,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                model: Value(session.model),
                resumable: Value(session.resumable),
                archived: const Value(false),
                stateSeq: Value(existing?.stateSeq ?? -1),
              ),
            );
      }
      if (archived.isNotEmpty) {
        await (database.update(database.sessions)
              ..where((row) => row.id.isIn(archived)))
            .write(const SessionsCompanion(archived: Value(true)));
      }
    });
  });

  @override
  Future<void> applyEvent(
    SessionEventFrameDto frame,
    SessionMetaDto? projectedSession,
    int lastSeq,
    int stateSeq,
  ) => _enqueue(() async {
    await database.transaction(() async {
      await database
          .into(database.sessionEvents)
          .insertOnConflictUpdate(
            SessionEventsCompanion.insert(
              sessionId: frame.sessionId,
              seq: frame.seq,
              ts: frame.ts,
              payload: jsonEncode(frame.toJson()),
            ),
          );
      if (projectedSession != null) {
        await database
            .into(database.sessions)
            .insertOnConflictUpdate(
              SessionsCompanion.insert(
                id: projectedSession.id,
                agentId: projectedSession.agentId,
                cwd: projectedSession.cwd,
                permissionMode: projectedSession.permissionMode,
                state: projectedSession.state,
                lastSeq: lastSeq,
                createdAt: projectedSession.createdAt,
                updatedAt: projectedSession.updatedAt,
                model: Value(projectedSession.model),
                resumable: Value(projectedSession.resumable),
                archived: const Value(false),
                stateSeq: Value(stateSeq),
              ),
            );
      }
    });
  });

  @override
  Future<void> archiveMissing(Iterable<String> archivedIds) =>
      _enqueue(() async {
        final ids = archivedIds.toSet();
        if (ids.isEmpty) return;
        await (database.update(database.sessions)
              ..where((row) => row.id.isIn(ids)))
            .write(const SessionsCompanion(archived: Value(true)));
      });

  @override
  Future<void> flush() => _tail;

  /// 读取可重放的数据库快照。
  Future<SessionMirrorSnapshot> readSnapshot() async {
    final sessionRows = await database.select(database.sessions).get();
    final eventRows = await (database.select(
      database.sessionEvents,
    )..orderBy([(row) => OrderingTerm(expression: row.seq)])).get();
    return SessionMirrorSnapshot(
      sessions: sessionRows
          .map(
            (row) => SessionMetaDto(
              id: row.id,
              agentId: row.agentId,
              cwd: row.cwd,
              permissionMode: row.permissionMode,
              state: row.state,
              lastSeq: row.lastSeq,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              model: row.model,
              resumable: row.resumable,
            ),
          )
          .toList(growable: false),
      events: eventRows
          .map(
            (row) => SessionEventFrameDto.fromJson(
              (jsonDecode(row.payload) as Map).cast<String, dynamic>(),
            ),
          )
          .toList(growable: false),
      lastSeq: {for (final row in sessionRows) row.id: row.lastSeq},
      stateSeq: {for (final row in sessionRows) row.id: row.stateSeq},
      archived: {
        for (final row in sessionRows)
          if (row.archived) row.id,
      },
    );
  }
}

/// 可从 SQLite 快照恢复的会话镜像。
class DriftSessionMirror extends SessionMirror {
  DriftSessionMirror._(
    SessionMirrorSnapshot snapshot,
    DriftSessionMirrorPersistence persistence, {
    required super.strictSeq,
    required super.alignWelcomeCursor,
  }) : super(persistence: persistence, initialState: snapshot);

  /// 打开数据库并恢复上次进程留下的事件、光标和归档状态。
  static Future<DriftSessionMirror> open(
    AimiDatabase database, {
    bool strictSeq = false,
    bool alignWelcomeCursor = false,
  }) async {
    final persistence = DriftSessionMirrorPersistence(database);
    return DriftSessionMirror._(
      await persistence.readSnapshot(),
      persistence,
      strictSeq: strictSeq,
      alignWelcomeCursor: alignWelcomeCursor,
    );
  }
}

/// Drift 对 [OutgoingMessageStore] 的持久化实现。
class DriftOutgoingMessagePersistence implements OutgoingMessagePersistence {
  DriftOutgoingMessagePersistence(this.database);

  final AimiDatabase database;
  Future<void> _tail = Future<void>.value();

  @override
  Future<void> save(OutgoingMessage message) {
    _tail = _tail.then(
      (_) => database
          .into(database.sentMessages)
          .insertOnConflictUpdate(
            SentMessagesCompanion.insert(
              clientId: message.clientId,
              sessionId: message.sessionId,
              body: message.text,
              ts: message.ts,
              status: message.status.name,
              attempts: Value(message.attempts),
              lastError: Value(message.lastError),
            ),
          ),
    );
    return _tail;
  }

  @override
  Future<void> flush() => _tail;

  /// 读取所有离线发送记录，供进程恢复时重建状态机。
  Future<Map<String, OutgoingMessage>> readMessages() async {
    final rows = await database.select(database.sentMessages).get();
    return {
      for (final row in rows)
        row.clientId: OutgoingMessage(
          clientId: row.clientId,
          sessionId: row.sessionId,
          text: row.body,
          ts: row.ts,
          status: OutgoingMessageStatus.values.firstWhere(
            (status) => status.name == row.status,
            orElse: () => OutgoingMessageStatus.failed,
          ),
          attempts: row.attempts,
          lastError: row.lastError,
        ),
    };
  }
}

/// 可从 SQLite 快照恢复的离线发送队列。
class DriftOutgoingMessageStore extends OutgoingMessageStore {
  DriftOutgoingMessageStore._(
    Map<String, OutgoingMessage> messages,
    DriftOutgoingMessagePersistence persistence,
  ) : super(initialMessages: messages, persistence: persistence);

  /// 打开数据库并恢复待发、失败和已发送记录。
  static Future<DriftOutgoingMessageStore> open(AimiDatabase database) async {
    final persistence = DriftOutgoingMessagePersistence(database);
    return DriftOutgoingMessageStore._(
      await persistence.readMessages(),
      persistence,
    );
  }
}
