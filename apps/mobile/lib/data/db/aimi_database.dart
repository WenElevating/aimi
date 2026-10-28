import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:drift_flutter/drift_flutter.dart';

part 'aimi_database.g.dart';

/// 已缓存的服务端会话元数据。
class Sessions extends Table {
  TextColumn get id => text()();
  TextColumn get agentId => text()();
  TextColumn get cwd => text()();
  TextColumn get permissionMode => text()();
  TextColumn get state => text()();
  IntColumn get lastSeq => integer()();
  IntColumn get createdAt => integer()();
  IntColumn get updatedAt => integer()();
  TextColumn get model => text().nullable()();
  BoolColumn get resumable => boolean().withDefault(const Constant(false))();
  BoolColumn get archived => boolean().withDefault(const Constant(false))();
  IntColumn get stateSeq => integer().withDefault(const Constant(-1))();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

/// 按服务端 seq 保留的归一化事件。
class SessionEvents extends Table {
  TextColumn get sessionId => text()();
  IntColumn get seq => integer()();
  IntColumn get ts => integer()();
  TextColumn get payload => text()();

  @override
  Set<Column<Object>> get primaryKey => {sessionId, seq};
}

/// 只用于 send 文本的离线发送队列。
class SentMessages extends Table {
  TextColumn get clientId => text()();
  TextColumn get sessionId => text()();
  TextColumn get body => text()();
  IntColumn get ts => integer()();
  TextColumn get status => text()();
  IntColumn get attempts => integer().withDefault(const Constant(0))();
  TextColumn get lastError => text().nullable()();

  @override
  Set<Column<Object>> get primaryKey => {clientId};
}

/// 各会话在本机已读到的服务端 seq 水位；未读 = 镜像 lastSeq 超过该水位。
class SessionReadState extends Table {
  TextColumn get sessionId => text()();
  IntColumn get lastReadSeq => integer()();

  @override
  Set<Column<Object>> get primaryKey => {sessionId};
}

/// 移动端本地镜像数据库；唯一写入方应是数据层/后台 isolate。
@DriftDatabase(tables: [Sessions, SessionEvents, SentMessages, SessionReadState])
class AimiDatabase extends _$AimiDatabase {
  AimiDatabase(super.executor);

  /// 创建进程内数据库，供单测和临时会话使用。
  factory AimiDatabase.inMemory() => AimiDatabase(NativeDatabase.memory());

  /// 打开指定文件，重启进程后仍可恢复镜像和待发消息。
  factory AimiDatabase.openFile(String path) =>
      AimiDatabase(NativeDatabase(File(path)));

  /// 打开平台默认应用数据目录中的 aimi 数据库。
  factory AimiDatabase.openDefault() =>
      AimiDatabase(driftDatabase(name: 'aimi_mobile'));

  @override
  int get schemaVersion => 2;

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onCreate: (m) => m.createAll(),
    onUpgrade: (m, from, to) async {
      // v2：新增未读水位表（独立表无历史数据可迁移，建表即完成升级）。
      if (from < 2) await m.createTable(sessionReadState);
    },
  );
}
