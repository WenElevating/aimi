// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'aimi_database.dart';

// ignore_for_file: type=lint
class $SessionsTable extends Sessions with TableInfo<$SessionsTable, Session> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $SessionsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _agentIdMeta = const VerificationMeta(
    'agentId',
  );
  @override
  late final GeneratedColumn<String> agentId = GeneratedColumn<String>(
    'agent_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _cwdMeta = const VerificationMeta('cwd');
  @override
  late final GeneratedColumn<String> cwd = GeneratedColumn<String>(
    'cwd',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _permissionModeMeta = const VerificationMeta(
    'permissionMode',
  );
  @override
  late final GeneratedColumn<String> permissionMode = GeneratedColumn<String>(
    'permission_mode',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _stateMeta = const VerificationMeta('state');
  @override
  late final GeneratedColumn<String> state = GeneratedColumn<String>(
    'state',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _lastSeqMeta = const VerificationMeta(
    'lastSeq',
  );
  @override
  late final GeneratedColumn<int> lastSeq = GeneratedColumn<int>(
    'last_seq',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<int> createdAt = GeneratedColumn<int>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<int> updatedAt = GeneratedColumn<int>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _modelMeta = const VerificationMeta('model');
  @override
  late final GeneratedColumn<String> model = GeneratedColumn<String>(
    'model',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _resumableMeta = const VerificationMeta(
    'resumable',
  );
  @override
  late final GeneratedColumn<bool> resumable = GeneratedColumn<bool>(
    'resumable',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("resumable" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  static const VerificationMeta _archivedMeta = const VerificationMeta(
    'archived',
  );
  @override
  late final GeneratedColumn<bool> archived = GeneratedColumn<bool>(
    'archived',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("archived" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  static const VerificationMeta _stateSeqMeta = const VerificationMeta(
    'stateSeq',
  );
  @override
  late final GeneratedColumn<int> stateSeq = GeneratedColumn<int>(
    'state_seq',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(-1),
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    agentId,
    cwd,
    permissionMode,
    state,
    lastSeq,
    createdAt,
    updatedAt,
    model,
    resumable,
    archived,
    stateSeq,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'sessions';
  @override
  VerificationContext validateIntegrity(
    Insertable<Session> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('agent_id')) {
      context.handle(
        _agentIdMeta,
        agentId.isAcceptableOrUnknown(data['agent_id']!, _agentIdMeta),
      );
    } else if (isInserting) {
      context.missing(_agentIdMeta);
    }
    if (data.containsKey('cwd')) {
      context.handle(
        _cwdMeta,
        cwd.isAcceptableOrUnknown(data['cwd']!, _cwdMeta),
      );
    } else if (isInserting) {
      context.missing(_cwdMeta);
    }
    if (data.containsKey('permission_mode')) {
      context.handle(
        _permissionModeMeta,
        permissionMode.isAcceptableOrUnknown(
          data['permission_mode']!,
          _permissionModeMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_permissionModeMeta);
    }
    if (data.containsKey('state')) {
      context.handle(
        _stateMeta,
        state.isAcceptableOrUnknown(data['state']!, _stateMeta),
      );
    } else if (isInserting) {
      context.missing(_stateMeta);
    }
    if (data.containsKey('last_seq')) {
      context.handle(
        _lastSeqMeta,
        lastSeq.isAcceptableOrUnknown(data['last_seq']!, _lastSeqMeta),
      );
    } else if (isInserting) {
      context.missing(_lastSeqMeta);
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    if (data.containsKey('model')) {
      context.handle(
        _modelMeta,
        model.isAcceptableOrUnknown(data['model']!, _modelMeta),
      );
    }
    if (data.containsKey('resumable')) {
      context.handle(
        _resumableMeta,
        resumable.isAcceptableOrUnknown(data['resumable']!, _resumableMeta),
      );
    }
    if (data.containsKey('archived')) {
      context.handle(
        _archivedMeta,
        archived.isAcceptableOrUnknown(data['archived']!, _archivedMeta),
      );
    }
    if (data.containsKey('state_seq')) {
      context.handle(
        _stateSeqMeta,
        stateSeq.isAcceptableOrUnknown(data['state_seq']!, _stateSeqMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  Session map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Session(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      agentId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}agent_id'],
      )!,
      cwd: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}cwd'],
      )!,
      permissionMode: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}permission_mode'],
      )!,
      state: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}state'],
      )!,
      lastSeq: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}last_seq'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}updated_at'],
      )!,
      model: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}model'],
      ),
      resumable: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}resumable'],
      )!,
      archived: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}archived'],
      )!,
      stateSeq: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}state_seq'],
      )!,
    );
  }

  @override
  $SessionsTable createAlias(String alias) {
    return $SessionsTable(attachedDatabase, alias);
  }
}

class Session extends DataClass implements Insertable<Session> {
  final String id;
  final String agentId;
  final String cwd;
  final String permissionMode;
  final String state;
  final int lastSeq;
  final int createdAt;
  final int updatedAt;
  final String? model;
  final bool resumable;
  final bool archived;
  final int stateSeq;
  const Session({
    required this.id,
    required this.agentId,
    required this.cwd,
    required this.permissionMode,
    required this.state,
    required this.lastSeq,
    required this.createdAt,
    required this.updatedAt,
    this.model,
    required this.resumable,
    required this.archived,
    required this.stateSeq,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['agent_id'] = Variable<String>(agentId);
    map['cwd'] = Variable<String>(cwd);
    map['permission_mode'] = Variable<String>(permissionMode);
    map['state'] = Variable<String>(state);
    map['last_seq'] = Variable<int>(lastSeq);
    map['created_at'] = Variable<int>(createdAt);
    map['updated_at'] = Variable<int>(updatedAt);
    if (!nullToAbsent || model != null) {
      map['model'] = Variable<String>(model);
    }
    map['resumable'] = Variable<bool>(resumable);
    map['archived'] = Variable<bool>(archived);
    map['state_seq'] = Variable<int>(stateSeq);
    return map;
  }

  SessionsCompanion toCompanion(bool nullToAbsent) {
    return SessionsCompanion(
      id: Value(id),
      agentId: Value(agentId),
      cwd: Value(cwd),
      permissionMode: Value(permissionMode),
      state: Value(state),
      lastSeq: Value(lastSeq),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
      model: model == null && nullToAbsent
          ? const Value.absent()
          : Value(model),
      resumable: Value(resumable),
      archived: Value(archived),
      stateSeq: Value(stateSeq),
    );
  }

  factory Session.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Session(
      id: serializer.fromJson<String>(json['id']),
      agentId: serializer.fromJson<String>(json['agentId']),
      cwd: serializer.fromJson<String>(json['cwd']),
      permissionMode: serializer.fromJson<String>(json['permissionMode']),
      state: serializer.fromJson<String>(json['state']),
      lastSeq: serializer.fromJson<int>(json['lastSeq']),
      createdAt: serializer.fromJson<int>(json['createdAt']),
      updatedAt: serializer.fromJson<int>(json['updatedAt']),
      model: serializer.fromJson<String?>(json['model']),
      resumable: serializer.fromJson<bool>(json['resumable']),
      archived: serializer.fromJson<bool>(json['archived']),
      stateSeq: serializer.fromJson<int>(json['stateSeq']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'agentId': serializer.toJson<String>(agentId),
      'cwd': serializer.toJson<String>(cwd),
      'permissionMode': serializer.toJson<String>(permissionMode),
      'state': serializer.toJson<String>(state),
      'lastSeq': serializer.toJson<int>(lastSeq),
      'createdAt': serializer.toJson<int>(createdAt),
      'updatedAt': serializer.toJson<int>(updatedAt),
      'model': serializer.toJson<String?>(model),
      'resumable': serializer.toJson<bool>(resumable),
      'archived': serializer.toJson<bool>(archived),
      'stateSeq': serializer.toJson<int>(stateSeq),
    };
  }

  Session copyWith({
    String? id,
    String? agentId,
    String? cwd,
    String? permissionMode,
    String? state,
    int? lastSeq,
    int? createdAt,
    int? updatedAt,
    Value<String?> model = const Value.absent(),
    bool? resumable,
    bool? archived,
    int? stateSeq,
  }) => Session(
    id: id ?? this.id,
    agentId: agentId ?? this.agentId,
    cwd: cwd ?? this.cwd,
    permissionMode: permissionMode ?? this.permissionMode,
    state: state ?? this.state,
    lastSeq: lastSeq ?? this.lastSeq,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
    model: model.present ? model.value : this.model,
    resumable: resumable ?? this.resumable,
    archived: archived ?? this.archived,
    stateSeq: stateSeq ?? this.stateSeq,
  );
  Session copyWithCompanion(SessionsCompanion data) {
    return Session(
      id: data.id.present ? data.id.value : this.id,
      agentId: data.agentId.present ? data.agentId.value : this.agentId,
      cwd: data.cwd.present ? data.cwd.value : this.cwd,
      permissionMode: data.permissionMode.present
          ? data.permissionMode.value
          : this.permissionMode,
      state: data.state.present ? data.state.value : this.state,
      lastSeq: data.lastSeq.present ? data.lastSeq.value : this.lastSeq,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
      model: data.model.present ? data.model.value : this.model,
      resumable: data.resumable.present ? data.resumable.value : this.resumable,
      archived: data.archived.present ? data.archived.value : this.archived,
      stateSeq: data.stateSeq.present ? data.stateSeq.value : this.stateSeq,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Session(')
          ..write('id: $id, ')
          ..write('agentId: $agentId, ')
          ..write('cwd: $cwd, ')
          ..write('permissionMode: $permissionMode, ')
          ..write('state: $state, ')
          ..write('lastSeq: $lastSeq, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('model: $model, ')
          ..write('resumable: $resumable, ')
          ..write('archived: $archived, ')
          ..write('stateSeq: $stateSeq')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    agentId,
    cwd,
    permissionMode,
    state,
    lastSeq,
    createdAt,
    updatedAt,
    model,
    resumable,
    archived,
    stateSeq,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Session &&
          other.id == this.id &&
          other.agentId == this.agentId &&
          other.cwd == this.cwd &&
          other.permissionMode == this.permissionMode &&
          other.state == this.state &&
          other.lastSeq == this.lastSeq &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt &&
          other.model == this.model &&
          other.resumable == this.resumable &&
          other.archived == this.archived &&
          other.stateSeq == this.stateSeq);
}

class SessionsCompanion extends UpdateCompanion<Session> {
  final Value<String> id;
  final Value<String> agentId;
  final Value<String> cwd;
  final Value<String> permissionMode;
  final Value<String> state;
  final Value<int> lastSeq;
  final Value<int> createdAt;
  final Value<int> updatedAt;
  final Value<String?> model;
  final Value<bool> resumable;
  final Value<bool> archived;
  final Value<int> stateSeq;
  final Value<int> rowid;
  const SessionsCompanion({
    this.id = const Value.absent(),
    this.agentId = const Value.absent(),
    this.cwd = const Value.absent(),
    this.permissionMode = const Value.absent(),
    this.state = const Value.absent(),
    this.lastSeq = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.model = const Value.absent(),
    this.resumable = const Value.absent(),
    this.archived = const Value.absent(),
    this.stateSeq = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  SessionsCompanion.insert({
    required String id,
    required String agentId,
    required String cwd,
    required String permissionMode,
    required String state,
    required int lastSeq,
    required int createdAt,
    required int updatedAt,
    this.model = const Value.absent(),
    this.resumable = const Value.absent(),
    this.archived = const Value.absent(),
    this.stateSeq = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       agentId = Value(agentId),
       cwd = Value(cwd),
       permissionMode = Value(permissionMode),
       state = Value(state),
       lastSeq = Value(lastSeq),
       createdAt = Value(createdAt),
       updatedAt = Value(updatedAt);
  static Insertable<Session> custom({
    Expression<String>? id,
    Expression<String>? agentId,
    Expression<String>? cwd,
    Expression<String>? permissionMode,
    Expression<String>? state,
    Expression<int>? lastSeq,
    Expression<int>? createdAt,
    Expression<int>? updatedAt,
    Expression<String>? model,
    Expression<bool>? resumable,
    Expression<bool>? archived,
    Expression<int>? stateSeq,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (agentId != null) 'agent_id': agentId,
      if (cwd != null) 'cwd': cwd,
      if (permissionMode != null) 'permission_mode': permissionMode,
      if (state != null) 'state': state,
      if (lastSeq != null) 'last_seq': lastSeq,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (model != null) 'model': model,
      if (resumable != null) 'resumable': resumable,
      if (archived != null) 'archived': archived,
      if (stateSeq != null) 'state_seq': stateSeq,
      if (rowid != null) 'rowid': rowid,
    });
  }

  SessionsCompanion copyWith({
    Value<String>? id,
    Value<String>? agentId,
    Value<String>? cwd,
    Value<String>? permissionMode,
    Value<String>? state,
    Value<int>? lastSeq,
    Value<int>? createdAt,
    Value<int>? updatedAt,
    Value<String?>? model,
    Value<bool>? resumable,
    Value<bool>? archived,
    Value<int>? stateSeq,
    Value<int>? rowid,
  }) {
    return SessionsCompanion(
      id: id ?? this.id,
      agentId: agentId ?? this.agentId,
      cwd: cwd ?? this.cwd,
      permissionMode: permissionMode ?? this.permissionMode,
      state: state ?? this.state,
      lastSeq: lastSeq ?? this.lastSeq,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      model: model ?? this.model,
      resumable: resumable ?? this.resumable,
      archived: archived ?? this.archived,
      stateSeq: stateSeq ?? this.stateSeq,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (agentId.present) {
      map['agent_id'] = Variable<String>(agentId.value);
    }
    if (cwd.present) {
      map['cwd'] = Variable<String>(cwd.value);
    }
    if (permissionMode.present) {
      map['permission_mode'] = Variable<String>(permissionMode.value);
    }
    if (state.present) {
      map['state'] = Variable<String>(state.value);
    }
    if (lastSeq.present) {
      map['last_seq'] = Variable<int>(lastSeq.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<int>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<int>(updatedAt.value);
    }
    if (model.present) {
      map['model'] = Variable<String>(model.value);
    }
    if (resumable.present) {
      map['resumable'] = Variable<bool>(resumable.value);
    }
    if (archived.present) {
      map['archived'] = Variable<bool>(archived.value);
    }
    if (stateSeq.present) {
      map['state_seq'] = Variable<int>(stateSeq.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('SessionsCompanion(')
          ..write('id: $id, ')
          ..write('agentId: $agentId, ')
          ..write('cwd: $cwd, ')
          ..write('permissionMode: $permissionMode, ')
          ..write('state: $state, ')
          ..write('lastSeq: $lastSeq, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('model: $model, ')
          ..write('resumable: $resumable, ')
          ..write('archived: $archived, ')
          ..write('stateSeq: $stateSeq, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $SessionEventsTable extends SessionEvents
    with TableInfo<$SessionEventsTable, SessionEvent> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $SessionEventsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _seqMeta = const VerificationMeta('seq');
  @override
  late final GeneratedColumn<int> seq = GeneratedColumn<int>(
    'seq',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _tsMeta = const VerificationMeta('ts');
  @override
  late final GeneratedColumn<int> ts = GeneratedColumn<int>(
    'ts',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _payloadMeta = const VerificationMeta(
    'payload',
  );
  @override
  late final GeneratedColumn<String> payload = GeneratedColumn<String>(
    'payload',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [sessionId, seq, ts, payload];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'session_events';
  @override
  VerificationContext validateIntegrity(
    Insertable<SessionEvent> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('seq')) {
      context.handle(
        _seqMeta,
        seq.isAcceptableOrUnknown(data['seq']!, _seqMeta),
      );
    } else if (isInserting) {
      context.missing(_seqMeta);
    }
    if (data.containsKey('ts')) {
      context.handle(_tsMeta, ts.isAcceptableOrUnknown(data['ts']!, _tsMeta));
    } else if (isInserting) {
      context.missing(_tsMeta);
    }
    if (data.containsKey('payload')) {
      context.handle(
        _payloadMeta,
        payload.isAcceptableOrUnknown(data['payload']!, _payloadMeta),
      );
    } else if (isInserting) {
      context.missing(_payloadMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {sessionId, seq};
  @override
  SessionEvent map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return SessionEvent(
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      seq: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}seq'],
      )!,
      ts: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}ts'],
      )!,
      payload: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}payload'],
      )!,
    );
  }

  @override
  $SessionEventsTable createAlias(String alias) {
    return $SessionEventsTable(attachedDatabase, alias);
  }
}

class SessionEvent extends DataClass implements Insertable<SessionEvent> {
  final String sessionId;
  final int seq;
  final int ts;
  final String payload;
  const SessionEvent({
    required this.sessionId,
    required this.seq,
    required this.ts,
    required this.payload,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['session_id'] = Variable<String>(sessionId);
    map['seq'] = Variable<int>(seq);
    map['ts'] = Variable<int>(ts);
    map['payload'] = Variable<String>(payload);
    return map;
  }

  SessionEventsCompanion toCompanion(bool nullToAbsent) {
    return SessionEventsCompanion(
      sessionId: Value(sessionId),
      seq: Value(seq),
      ts: Value(ts),
      payload: Value(payload),
    );
  }

  factory SessionEvent.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return SessionEvent(
      sessionId: serializer.fromJson<String>(json['sessionId']),
      seq: serializer.fromJson<int>(json['seq']),
      ts: serializer.fromJson<int>(json['ts']),
      payload: serializer.fromJson<String>(json['payload']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'sessionId': serializer.toJson<String>(sessionId),
      'seq': serializer.toJson<int>(seq),
      'ts': serializer.toJson<int>(ts),
      'payload': serializer.toJson<String>(payload),
    };
  }

  SessionEvent copyWith({
    String? sessionId,
    int? seq,
    int? ts,
    String? payload,
  }) => SessionEvent(
    sessionId: sessionId ?? this.sessionId,
    seq: seq ?? this.seq,
    ts: ts ?? this.ts,
    payload: payload ?? this.payload,
  );
  SessionEvent copyWithCompanion(SessionEventsCompanion data) {
    return SessionEvent(
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      seq: data.seq.present ? data.seq.value : this.seq,
      ts: data.ts.present ? data.ts.value : this.ts,
      payload: data.payload.present ? data.payload.value : this.payload,
    );
  }

  @override
  String toString() {
    return (StringBuffer('SessionEvent(')
          ..write('sessionId: $sessionId, ')
          ..write('seq: $seq, ')
          ..write('ts: $ts, ')
          ..write('payload: $payload')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(sessionId, seq, ts, payload);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is SessionEvent &&
          other.sessionId == this.sessionId &&
          other.seq == this.seq &&
          other.ts == this.ts &&
          other.payload == this.payload);
}

class SessionEventsCompanion extends UpdateCompanion<SessionEvent> {
  final Value<String> sessionId;
  final Value<int> seq;
  final Value<int> ts;
  final Value<String> payload;
  final Value<int> rowid;
  const SessionEventsCompanion({
    this.sessionId = const Value.absent(),
    this.seq = const Value.absent(),
    this.ts = const Value.absent(),
    this.payload = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  SessionEventsCompanion.insert({
    required String sessionId,
    required int seq,
    required int ts,
    required String payload,
    this.rowid = const Value.absent(),
  }) : sessionId = Value(sessionId),
       seq = Value(seq),
       ts = Value(ts),
       payload = Value(payload);
  static Insertable<SessionEvent> custom({
    Expression<String>? sessionId,
    Expression<int>? seq,
    Expression<int>? ts,
    Expression<String>? payload,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (sessionId != null) 'session_id': sessionId,
      if (seq != null) 'seq': seq,
      if (ts != null) 'ts': ts,
      if (payload != null) 'payload': payload,
      if (rowid != null) 'rowid': rowid,
    });
  }

  SessionEventsCompanion copyWith({
    Value<String>? sessionId,
    Value<int>? seq,
    Value<int>? ts,
    Value<String>? payload,
    Value<int>? rowid,
  }) {
    return SessionEventsCompanion(
      sessionId: sessionId ?? this.sessionId,
      seq: seq ?? this.seq,
      ts: ts ?? this.ts,
      payload: payload ?? this.payload,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (seq.present) {
      map['seq'] = Variable<int>(seq.value);
    }
    if (ts.present) {
      map['ts'] = Variable<int>(ts.value);
    }
    if (payload.present) {
      map['payload'] = Variable<String>(payload.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('SessionEventsCompanion(')
          ..write('sessionId: $sessionId, ')
          ..write('seq: $seq, ')
          ..write('ts: $ts, ')
          ..write('payload: $payload, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $SentMessagesTable extends SentMessages
    with TableInfo<$SentMessagesTable, SentMessage> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $SentMessagesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _clientIdMeta = const VerificationMeta(
    'clientId',
  );
  @override
  late final GeneratedColumn<String> clientId = GeneratedColumn<String>(
    'client_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _bodyMeta = const VerificationMeta('body');
  @override
  late final GeneratedColumn<String> body = GeneratedColumn<String>(
    'body',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _tsMeta = const VerificationMeta('ts');
  @override
  late final GeneratedColumn<int> ts = GeneratedColumn<int>(
    'ts',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _attemptsMeta = const VerificationMeta(
    'attempts',
  );
  @override
  late final GeneratedColumn<int> attempts = GeneratedColumn<int>(
    'attempts',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _lastErrorMeta = const VerificationMeta(
    'lastError',
  );
  @override
  late final GeneratedColumn<String> lastError = GeneratedColumn<String>(
    'last_error',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    clientId,
    sessionId,
    body,
    ts,
    status,
    attempts,
    lastError,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'sent_messages';
  @override
  VerificationContext validateIntegrity(
    Insertable<SentMessage> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('client_id')) {
      context.handle(
        _clientIdMeta,
        clientId.isAcceptableOrUnknown(data['client_id']!, _clientIdMeta),
      );
    } else if (isInserting) {
      context.missing(_clientIdMeta);
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('body')) {
      context.handle(
        _bodyMeta,
        body.isAcceptableOrUnknown(data['body']!, _bodyMeta),
      );
    } else if (isInserting) {
      context.missing(_bodyMeta);
    }
    if (data.containsKey('ts')) {
      context.handle(_tsMeta, ts.isAcceptableOrUnknown(data['ts']!, _tsMeta));
    } else if (isInserting) {
      context.missing(_tsMeta);
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    } else if (isInserting) {
      context.missing(_statusMeta);
    }
    if (data.containsKey('attempts')) {
      context.handle(
        _attemptsMeta,
        attempts.isAcceptableOrUnknown(data['attempts']!, _attemptsMeta),
      );
    }
    if (data.containsKey('last_error')) {
      context.handle(
        _lastErrorMeta,
        lastError.isAcceptableOrUnknown(data['last_error']!, _lastErrorMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {clientId};
  @override
  SentMessage map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return SentMessage(
      clientId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}client_id'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      body: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}body'],
      )!,
      ts: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}ts'],
      )!,
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
      attempts: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}attempts'],
      )!,
      lastError: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}last_error'],
      ),
    );
  }

  @override
  $SentMessagesTable createAlias(String alias) {
    return $SentMessagesTable(attachedDatabase, alias);
  }
}

class SentMessage extends DataClass implements Insertable<SentMessage> {
  final String clientId;
  final String sessionId;
  final String body;
  final int ts;
  final String status;
  final int attempts;
  final String? lastError;
  const SentMessage({
    required this.clientId,
    required this.sessionId,
    required this.body,
    required this.ts,
    required this.status,
    required this.attempts,
    this.lastError,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['client_id'] = Variable<String>(clientId);
    map['session_id'] = Variable<String>(sessionId);
    map['body'] = Variable<String>(body);
    map['ts'] = Variable<int>(ts);
    map['status'] = Variable<String>(status);
    map['attempts'] = Variable<int>(attempts);
    if (!nullToAbsent || lastError != null) {
      map['last_error'] = Variable<String>(lastError);
    }
    return map;
  }

  SentMessagesCompanion toCompanion(bool nullToAbsent) {
    return SentMessagesCompanion(
      clientId: Value(clientId),
      sessionId: Value(sessionId),
      body: Value(body),
      ts: Value(ts),
      status: Value(status),
      attempts: Value(attempts),
      lastError: lastError == null && nullToAbsent
          ? const Value.absent()
          : Value(lastError),
    );
  }

  factory SentMessage.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return SentMessage(
      clientId: serializer.fromJson<String>(json['clientId']),
      sessionId: serializer.fromJson<String>(json['sessionId']),
      body: serializer.fromJson<String>(json['body']),
      ts: serializer.fromJson<int>(json['ts']),
      status: serializer.fromJson<String>(json['status']),
      attempts: serializer.fromJson<int>(json['attempts']),
      lastError: serializer.fromJson<String?>(json['lastError']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'clientId': serializer.toJson<String>(clientId),
      'sessionId': serializer.toJson<String>(sessionId),
      'body': serializer.toJson<String>(body),
      'ts': serializer.toJson<int>(ts),
      'status': serializer.toJson<String>(status),
      'attempts': serializer.toJson<int>(attempts),
      'lastError': serializer.toJson<String?>(lastError),
    };
  }

  SentMessage copyWith({
    String? clientId,
    String? sessionId,
    String? body,
    int? ts,
    String? status,
    int? attempts,
    Value<String?> lastError = const Value.absent(),
  }) => SentMessage(
    clientId: clientId ?? this.clientId,
    sessionId: sessionId ?? this.sessionId,
    body: body ?? this.body,
    ts: ts ?? this.ts,
    status: status ?? this.status,
    attempts: attempts ?? this.attempts,
    lastError: lastError.present ? lastError.value : this.lastError,
  );
  SentMessage copyWithCompanion(SentMessagesCompanion data) {
    return SentMessage(
      clientId: data.clientId.present ? data.clientId.value : this.clientId,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      body: data.body.present ? data.body.value : this.body,
      ts: data.ts.present ? data.ts.value : this.ts,
      status: data.status.present ? data.status.value : this.status,
      attempts: data.attempts.present ? data.attempts.value : this.attempts,
      lastError: data.lastError.present ? data.lastError.value : this.lastError,
    );
  }

  @override
  String toString() {
    return (StringBuffer('SentMessage(')
          ..write('clientId: $clientId, ')
          ..write('sessionId: $sessionId, ')
          ..write('body: $body, ')
          ..write('ts: $ts, ')
          ..write('status: $status, ')
          ..write('attempts: $attempts, ')
          ..write('lastError: $lastError')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(clientId, sessionId, body, ts, status, attempts, lastError);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is SentMessage &&
          other.clientId == this.clientId &&
          other.sessionId == this.sessionId &&
          other.body == this.body &&
          other.ts == this.ts &&
          other.status == this.status &&
          other.attempts == this.attempts &&
          other.lastError == this.lastError);
}

class SentMessagesCompanion extends UpdateCompanion<SentMessage> {
  final Value<String> clientId;
  final Value<String> sessionId;
  final Value<String> body;
  final Value<int> ts;
  final Value<String> status;
  final Value<int> attempts;
  final Value<String?> lastError;
  final Value<int> rowid;
  const SentMessagesCompanion({
    this.clientId = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.body = const Value.absent(),
    this.ts = const Value.absent(),
    this.status = const Value.absent(),
    this.attempts = const Value.absent(),
    this.lastError = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  SentMessagesCompanion.insert({
    required String clientId,
    required String sessionId,
    required String body,
    required int ts,
    required String status,
    this.attempts = const Value.absent(),
    this.lastError = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : clientId = Value(clientId),
       sessionId = Value(sessionId),
       body = Value(body),
       ts = Value(ts),
       status = Value(status);
  static Insertable<SentMessage> custom({
    Expression<String>? clientId,
    Expression<String>? sessionId,
    Expression<String>? body,
    Expression<int>? ts,
    Expression<String>? status,
    Expression<int>? attempts,
    Expression<String>? lastError,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (clientId != null) 'client_id': clientId,
      if (sessionId != null) 'session_id': sessionId,
      if (body != null) 'body': body,
      if (ts != null) 'ts': ts,
      if (status != null) 'status': status,
      if (attempts != null) 'attempts': attempts,
      if (lastError != null) 'last_error': lastError,
      if (rowid != null) 'rowid': rowid,
    });
  }

  SentMessagesCompanion copyWith({
    Value<String>? clientId,
    Value<String>? sessionId,
    Value<String>? body,
    Value<int>? ts,
    Value<String>? status,
    Value<int>? attempts,
    Value<String?>? lastError,
    Value<int>? rowid,
  }) {
    return SentMessagesCompanion(
      clientId: clientId ?? this.clientId,
      sessionId: sessionId ?? this.sessionId,
      body: body ?? this.body,
      ts: ts ?? this.ts,
      status: status ?? this.status,
      attempts: attempts ?? this.attempts,
      lastError: lastError ?? this.lastError,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (clientId.present) {
      map['client_id'] = Variable<String>(clientId.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (body.present) {
      map['body'] = Variable<String>(body.value);
    }
    if (ts.present) {
      map['ts'] = Variable<int>(ts.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (attempts.present) {
      map['attempts'] = Variable<int>(attempts.value);
    }
    if (lastError.present) {
      map['last_error'] = Variable<String>(lastError.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('SentMessagesCompanion(')
          ..write('clientId: $clientId, ')
          ..write('sessionId: $sessionId, ')
          ..write('body: $body, ')
          ..write('ts: $ts, ')
          ..write('status: $status, ')
          ..write('attempts: $attempts, ')
          ..write('lastError: $lastError, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $SessionReadStateTable extends SessionReadState
    with TableInfo<$SessionReadStateTable, SessionReadStateData> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $SessionReadStateTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _lastReadSeqMeta = const VerificationMeta(
    'lastReadSeq',
  );
  @override
  late final GeneratedColumn<int> lastReadSeq = GeneratedColumn<int>(
    'last_read_seq',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [sessionId, lastReadSeq];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'session_read_state';
  @override
  VerificationContext validateIntegrity(
    Insertable<SessionReadStateData> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('last_read_seq')) {
      context.handle(
        _lastReadSeqMeta,
        lastReadSeq.isAcceptableOrUnknown(
          data['last_read_seq']!,
          _lastReadSeqMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_lastReadSeqMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {sessionId};
  @override
  SessionReadStateData map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return SessionReadStateData(
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      lastReadSeq: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}last_read_seq'],
      )!,
    );
  }

  @override
  $SessionReadStateTable createAlias(String alias) {
    return $SessionReadStateTable(attachedDatabase, alias);
  }
}

class SessionReadStateData extends DataClass
    implements Insertable<SessionReadStateData> {
  final String sessionId;
  final int lastReadSeq;
  const SessionReadStateData({
    required this.sessionId,
    required this.lastReadSeq,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['session_id'] = Variable<String>(sessionId);
    map['last_read_seq'] = Variable<int>(lastReadSeq);
    return map;
  }

  SessionReadStateCompanion toCompanion(bool nullToAbsent) {
    return SessionReadStateCompanion(
      sessionId: Value(sessionId),
      lastReadSeq: Value(lastReadSeq),
    );
  }

  factory SessionReadStateData.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return SessionReadStateData(
      sessionId: serializer.fromJson<String>(json['sessionId']),
      lastReadSeq: serializer.fromJson<int>(json['lastReadSeq']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'sessionId': serializer.toJson<String>(sessionId),
      'lastReadSeq': serializer.toJson<int>(lastReadSeq),
    };
  }

  SessionReadStateData copyWith({String? sessionId, int? lastReadSeq}) =>
      SessionReadStateData(
        sessionId: sessionId ?? this.sessionId,
        lastReadSeq: lastReadSeq ?? this.lastReadSeq,
      );
  SessionReadStateData copyWithCompanion(SessionReadStateCompanion data) {
    return SessionReadStateData(
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      lastReadSeq: data.lastReadSeq.present
          ? data.lastReadSeq.value
          : this.lastReadSeq,
    );
  }

  @override
  String toString() {
    return (StringBuffer('SessionReadStateData(')
          ..write('sessionId: $sessionId, ')
          ..write('lastReadSeq: $lastReadSeq')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(sessionId, lastReadSeq);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is SessionReadStateData &&
          other.sessionId == this.sessionId &&
          other.lastReadSeq == this.lastReadSeq);
}

class SessionReadStateCompanion extends UpdateCompanion<SessionReadStateData> {
  final Value<String> sessionId;
  final Value<int> lastReadSeq;
  final Value<int> rowid;
  const SessionReadStateCompanion({
    this.sessionId = const Value.absent(),
    this.lastReadSeq = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  SessionReadStateCompanion.insert({
    required String sessionId,
    required int lastReadSeq,
    this.rowid = const Value.absent(),
  }) : sessionId = Value(sessionId),
       lastReadSeq = Value(lastReadSeq);
  static Insertable<SessionReadStateData> custom({
    Expression<String>? sessionId,
    Expression<int>? lastReadSeq,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (sessionId != null) 'session_id': sessionId,
      if (lastReadSeq != null) 'last_read_seq': lastReadSeq,
      if (rowid != null) 'rowid': rowid,
    });
  }

  SessionReadStateCompanion copyWith({
    Value<String>? sessionId,
    Value<int>? lastReadSeq,
    Value<int>? rowid,
  }) {
    return SessionReadStateCompanion(
      sessionId: sessionId ?? this.sessionId,
      lastReadSeq: lastReadSeq ?? this.lastReadSeq,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (lastReadSeq.present) {
      map['last_read_seq'] = Variable<int>(lastReadSeq.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('SessionReadStateCompanion(')
          ..write('sessionId: $sessionId, ')
          ..write('lastReadSeq: $lastReadSeq, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

abstract class _$AimiDatabase extends GeneratedDatabase {
  _$AimiDatabase(QueryExecutor e) : super(e);
  $AimiDatabaseManager get managers => $AimiDatabaseManager(this);
  late final $SessionsTable sessions = $SessionsTable(this);
  late final $SessionEventsTable sessionEvents = $SessionEventsTable(this);
  late final $SentMessagesTable sentMessages = $SentMessagesTable(this);
  late final $SessionReadStateTable sessionReadState = $SessionReadStateTable(
    this,
  );
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [
    sessions,
    sessionEvents,
    sentMessages,
    sessionReadState,
  ];
}

typedef $$SessionsTableCreateCompanionBuilder =
    SessionsCompanion Function({
      required String id,
      required String agentId,
      required String cwd,
      required String permissionMode,
      required String state,
      required int lastSeq,
      required int createdAt,
      required int updatedAt,
      Value<String?> model,
      Value<bool> resumable,
      Value<bool> archived,
      Value<int> stateSeq,
      Value<int> rowid,
    });
typedef $$SessionsTableUpdateCompanionBuilder =
    SessionsCompanion Function({
      Value<String> id,
      Value<String> agentId,
      Value<String> cwd,
      Value<String> permissionMode,
      Value<String> state,
      Value<int> lastSeq,
      Value<int> createdAt,
      Value<int> updatedAt,
      Value<String?> model,
      Value<bool> resumable,
      Value<bool> archived,
      Value<int> stateSeq,
      Value<int> rowid,
    });

class $$SessionsTableFilterComposer
    extends Composer<_$AimiDatabase, $SessionsTable> {
  $$SessionsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get agentId => $composableBuilder(
    column: $table.agentId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get cwd => $composableBuilder(
    column: $table.cwd,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get permissionMode => $composableBuilder(
    column: $table.permissionMode,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get state => $composableBuilder(
    column: $table.state,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get lastSeq => $composableBuilder(
    column: $table.lastSeq,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get model => $composableBuilder(
    column: $table.model,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get resumable => $composableBuilder(
    column: $table.resumable,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get archived => $composableBuilder(
    column: $table.archived,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get stateSeq => $composableBuilder(
    column: $table.stateSeq,
    builder: (column) => ColumnFilters(column),
  );
}

class $$SessionsTableOrderingComposer
    extends Composer<_$AimiDatabase, $SessionsTable> {
  $$SessionsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get agentId => $composableBuilder(
    column: $table.agentId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get cwd => $composableBuilder(
    column: $table.cwd,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get permissionMode => $composableBuilder(
    column: $table.permissionMode,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get state => $composableBuilder(
    column: $table.state,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get lastSeq => $composableBuilder(
    column: $table.lastSeq,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get model => $composableBuilder(
    column: $table.model,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get resumable => $composableBuilder(
    column: $table.resumable,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get archived => $composableBuilder(
    column: $table.archived,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get stateSeq => $composableBuilder(
    column: $table.stateSeq,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$SessionsTableAnnotationComposer
    extends Composer<_$AimiDatabase, $SessionsTable> {
  $$SessionsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get agentId =>
      $composableBuilder(column: $table.agentId, builder: (column) => column);

  GeneratedColumn<String> get cwd =>
      $composableBuilder(column: $table.cwd, builder: (column) => column);

  GeneratedColumn<String> get permissionMode => $composableBuilder(
    column: $table.permissionMode,
    builder: (column) => column,
  );

  GeneratedColumn<String> get state =>
      $composableBuilder(column: $table.state, builder: (column) => column);

  GeneratedColumn<int> get lastSeq =>
      $composableBuilder(column: $table.lastSeq, builder: (column) => column);

  GeneratedColumn<int> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<int> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  GeneratedColumn<String> get model =>
      $composableBuilder(column: $table.model, builder: (column) => column);

  GeneratedColumn<bool> get resumable =>
      $composableBuilder(column: $table.resumable, builder: (column) => column);

  GeneratedColumn<bool> get archived =>
      $composableBuilder(column: $table.archived, builder: (column) => column);

  GeneratedColumn<int> get stateSeq =>
      $composableBuilder(column: $table.stateSeq, builder: (column) => column);
}

class $$SessionsTableTableManager
    extends
        RootTableManager<
          _$AimiDatabase,
          $SessionsTable,
          Session,
          $$SessionsTableFilterComposer,
          $$SessionsTableOrderingComposer,
          $$SessionsTableAnnotationComposer,
          $$SessionsTableCreateCompanionBuilder,
          $$SessionsTableUpdateCompanionBuilder,
          (Session, BaseReferences<_$AimiDatabase, $SessionsTable, Session>),
          Session,
          PrefetchHooks Function()
        > {
  $$SessionsTableTableManager(_$AimiDatabase db, $SessionsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$SessionsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$SessionsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$SessionsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> agentId = const Value.absent(),
                Value<String> cwd = const Value.absent(),
                Value<String> permissionMode = const Value.absent(),
                Value<String> state = const Value.absent(),
                Value<int> lastSeq = const Value.absent(),
                Value<int> createdAt = const Value.absent(),
                Value<int> updatedAt = const Value.absent(),
                Value<String?> model = const Value.absent(),
                Value<bool> resumable = const Value.absent(),
                Value<bool> archived = const Value.absent(),
                Value<int> stateSeq = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SessionsCompanion(
                id: id,
                agentId: agentId,
                cwd: cwd,
                permissionMode: permissionMode,
                state: state,
                lastSeq: lastSeq,
                createdAt: createdAt,
                updatedAt: updatedAt,
                model: model,
                resumable: resumable,
                archived: archived,
                stateSeq: stateSeq,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String agentId,
                required String cwd,
                required String permissionMode,
                required String state,
                required int lastSeq,
                required int createdAt,
                required int updatedAt,
                Value<String?> model = const Value.absent(),
                Value<bool> resumable = const Value.absent(),
                Value<bool> archived = const Value.absent(),
                Value<int> stateSeq = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SessionsCompanion.insert(
                id: id,
                agentId: agentId,
                cwd: cwd,
                permissionMode: permissionMode,
                state: state,
                lastSeq: lastSeq,
                createdAt: createdAt,
                updatedAt: updatedAt,
                model: model,
                resumable: resumable,
                archived: archived,
                stateSeq: stateSeq,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$SessionsTableProcessedTableManager =
    ProcessedTableManager<
      _$AimiDatabase,
      $SessionsTable,
      Session,
      $$SessionsTableFilterComposer,
      $$SessionsTableOrderingComposer,
      $$SessionsTableAnnotationComposer,
      $$SessionsTableCreateCompanionBuilder,
      $$SessionsTableUpdateCompanionBuilder,
      (Session, BaseReferences<_$AimiDatabase, $SessionsTable, Session>),
      Session,
      PrefetchHooks Function()
    >;
typedef $$SessionEventsTableCreateCompanionBuilder =
    SessionEventsCompanion Function({
      required String sessionId,
      required int seq,
      required int ts,
      required String payload,
      Value<int> rowid,
    });
typedef $$SessionEventsTableUpdateCompanionBuilder =
    SessionEventsCompanion Function({
      Value<String> sessionId,
      Value<int> seq,
      Value<int> ts,
      Value<String> payload,
      Value<int> rowid,
    });

class $$SessionEventsTableFilterComposer
    extends Composer<_$AimiDatabase, $SessionEventsTable> {
  $$SessionEventsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get seq => $composableBuilder(
    column: $table.seq,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get ts => $composableBuilder(
    column: $table.ts,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get payload => $composableBuilder(
    column: $table.payload,
    builder: (column) => ColumnFilters(column),
  );
}

class $$SessionEventsTableOrderingComposer
    extends Composer<_$AimiDatabase, $SessionEventsTable> {
  $$SessionEventsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get seq => $composableBuilder(
    column: $table.seq,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get ts => $composableBuilder(
    column: $table.ts,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get payload => $composableBuilder(
    column: $table.payload,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$SessionEventsTableAnnotationComposer
    extends Composer<_$AimiDatabase, $SessionEventsTable> {
  $$SessionEventsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<int> get seq =>
      $composableBuilder(column: $table.seq, builder: (column) => column);

  GeneratedColumn<int> get ts =>
      $composableBuilder(column: $table.ts, builder: (column) => column);

  GeneratedColumn<String> get payload =>
      $composableBuilder(column: $table.payload, builder: (column) => column);
}

class $$SessionEventsTableTableManager
    extends
        RootTableManager<
          _$AimiDatabase,
          $SessionEventsTable,
          SessionEvent,
          $$SessionEventsTableFilterComposer,
          $$SessionEventsTableOrderingComposer,
          $$SessionEventsTableAnnotationComposer,
          $$SessionEventsTableCreateCompanionBuilder,
          $$SessionEventsTableUpdateCompanionBuilder,
          (
            SessionEvent,
            BaseReferences<_$AimiDatabase, $SessionEventsTable, SessionEvent>,
          ),
          SessionEvent,
          PrefetchHooks Function()
        > {
  $$SessionEventsTableTableManager(_$AimiDatabase db, $SessionEventsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$SessionEventsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$SessionEventsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$SessionEventsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> sessionId = const Value.absent(),
                Value<int> seq = const Value.absent(),
                Value<int> ts = const Value.absent(),
                Value<String> payload = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SessionEventsCompanion(
                sessionId: sessionId,
                seq: seq,
                ts: ts,
                payload: payload,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String sessionId,
                required int seq,
                required int ts,
                required String payload,
                Value<int> rowid = const Value.absent(),
              }) => SessionEventsCompanion.insert(
                sessionId: sessionId,
                seq: seq,
                ts: ts,
                payload: payload,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$SessionEventsTableProcessedTableManager =
    ProcessedTableManager<
      _$AimiDatabase,
      $SessionEventsTable,
      SessionEvent,
      $$SessionEventsTableFilterComposer,
      $$SessionEventsTableOrderingComposer,
      $$SessionEventsTableAnnotationComposer,
      $$SessionEventsTableCreateCompanionBuilder,
      $$SessionEventsTableUpdateCompanionBuilder,
      (
        SessionEvent,
        BaseReferences<_$AimiDatabase, $SessionEventsTable, SessionEvent>,
      ),
      SessionEvent,
      PrefetchHooks Function()
    >;
typedef $$SentMessagesTableCreateCompanionBuilder =
    SentMessagesCompanion Function({
      required String clientId,
      required String sessionId,
      required String body,
      required int ts,
      required String status,
      Value<int> attempts,
      Value<String?> lastError,
      Value<int> rowid,
    });
typedef $$SentMessagesTableUpdateCompanionBuilder =
    SentMessagesCompanion Function({
      Value<String> clientId,
      Value<String> sessionId,
      Value<String> body,
      Value<int> ts,
      Value<String> status,
      Value<int> attempts,
      Value<String?> lastError,
      Value<int> rowid,
    });

class $$SentMessagesTableFilterComposer
    extends Composer<_$AimiDatabase, $SentMessagesTable> {
  $$SentMessagesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get clientId => $composableBuilder(
    column: $table.clientId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get body => $composableBuilder(
    column: $table.body,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get ts => $composableBuilder(
    column: $table.ts,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get attempts => $composableBuilder(
    column: $table.attempts,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get lastError => $composableBuilder(
    column: $table.lastError,
    builder: (column) => ColumnFilters(column),
  );
}

class $$SentMessagesTableOrderingComposer
    extends Composer<_$AimiDatabase, $SentMessagesTable> {
  $$SentMessagesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get clientId => $composableBuilder(
    column: $table.clientId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get body => $composableBuilder(
    column: $table.body,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get ts => $composableBuilder(
    column: $table.ts,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get attempts => $composableBuilder(
    column: $table.attempts,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get lastError => $composableBuilder(
    column: $table.lastError,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$SentMessagesTableAnnotationComposer
    extends Composer<_$AimiDatabase, $SentMessagesTable> {
  $$SentMessagesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get clientId =>
      $composableBuilder(column: $table.clientId, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get body =>
      $composableBuilder(column: $table.body, builder: (column) => column);

  GeneratedColumn<int> get ts =>
      $composableBuilder(column: $table.ts, builder: (column) => column);

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<int> get attempts =>
      $composableBuilder(column: $table.attempts, builder: (column) => column);

  GeneratedColumn<String> get lastError =>
      $composableBuilder(column: $table.lastError, builder: (column) => column);
}

class $$SentMessagesTableTableManager
    extends
        RootTableManager<
          _$AimiDatabase,
          $SentMessagesTable,
          SentMessage,
          $$SentMessagesTableFilterComposer,
          $$SentMessagesTableOrderingComposer,
          $$SentMessagesTableAnnotationComposer,
          $$SentMessagesTableCreateCompanionBuilder,
          $$SentMessagesTableUpdateCompanionBuilder,
          (
            SentMessage,
            BaseReferences<_$AimiDatabase, $SentMessagesTable, SentMessage>,
          ),
          SentMessage,
          PrefetchHooks Function()
        > {
  $$SentMessagesTableTableManager(_$AimiDatabase db, $SentMessagesTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$SentMessagesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$SentMessagesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$SentMessagesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> clientId = const Value.absent(),
                Value<String> sessionId = const Value.absent(),
                Value<String> body = const Value.absent(),
                Value<int> ts = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<int> attempts = const Value.absent(),
                Value<String?> lastError = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SentMessagesCompanion(
                clientId: clientId,
                sessionId: sessionId,
                body: body,
                ts: ts,
                status: status,
                attempts: attempts,
                lastError: lastError,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String clientId,
                required String sessionId,
                required String body,
                required int ts,
                required String status,
                Value<int> attempts = const Value.absent(),
                Value<String?> lastError = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SentMessagesCompanion.insert(
                clientId: clientId,
                sessionId: sessionId,
                body: body,
                ts: ts,
                status: status,
                attempts: attempts,
                lastError: lastError,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$SentMessagesTableProcessedTableManager =
    ProcessedTableManager<
      _$AimiDatabase,
      $SentMessagesTable,
      SentMessage,
      $$SentMessagesTableFilterComposer,
      $$SentMessagesTableOrderingComposer,
      $$SentMessagesTableAnnotationComposer,
      $$SentMessagesTableCreateCompanionBuilder,
      $$SentMessagesTableUpdateCompanionBuilder,
      (
        SentMessage,
        BaseReferences<_$AimiDatabase, $SentMessagesTable, SentMessage>,
      ),
      SentMessage,
      PrefetchHooks Function()
    >;
typedef $$SessionReadStateTableCreateCompanionBuilder =
    SessionReadStateCompanion Function({
      required String sessionId,
      required int lastReadSeq,
      Value<int> rowid,
    });
typedef $$SessionReadStateTableUpdateCompanionBuilder =
    SessionReadStateCompanion Function({
      Value<String> sessionId,
      Value<int> lastReadSeq,
      Value<int> rowid,
    });

class $$SessionReadStateTableFilterComposer
    extends Composer<_$AimiDatabase, $SessionReadStateTable> {
  $$SessionReadStateTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get lastReadSeq => $composableBuilder(
    column: $table.lastReadSeq,
    builder: (column) => ColumnFilters(column),
  );
}

class $$SessionReadStateTableOrderingComposer
    extends Composer<_$AimiDatabase, $SessionReadStateTable> {
  $$SessionReadStateTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get lastReadSeq => $composableBuilder(
    column: $table.lastReadSeq,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$SessionReadStateTableAnnotationComposer
    extends Composer<_$AimiDatabase, $SessionReadStateTable> {
  $$SessionReadStateTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<int> get lastReadSeq => $composableBuilder(
    column: $table.lastReadSeq,
    builder: (column) => column,
  );
}

class $$SessionReadStateTableTableManager
    extends
        RootTableManager<
          _$AimiDatabase,
          $SessionReadStateTable,
          SessionReadStateData,
          $$SessionReadStateTableFilterComposer,
          $$SessionReadStateTableOrderingComposer,
          $$SessionReadStateTableAnnotationComposer,
          $$SessionReadStateTableCreateCompanionBuilder,
          $$SessionReadStateTableUpdateCompanionBuilder,
          (
            SessionReadStateData,
            BaseReferences<
              _$AimiDatabase,
              $SessionReadStateTable,
              SessionReadStateData
            >,
          ),
          SessionReadStateData,
          PrefetchHooks Function()
        > {
  $$SessionReadStateTableTableManager(
    _$AimiDatabase db,
    $SessionReadStateTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$SessionReadStateTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$SessionReadStateTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$SessionReadStateTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> sessionId = const Value.absent(),
                Value<int> lastReadSeq = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SessionReadStateCompanion(
                sessionId: sessionId,
                lastReadSeq: lastReadSeq,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String sessionId,
                required int lastReadSeq,
                Value<int> rowid = const Value.absent(),
              }) => SessionReadStateCompanion.insert(
                sessionId: sessionId,
                lastReadSeq: lastReadSeq,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$SessionReadStateTableProcessedTableManager =
    ProcessedTableManager<
      _$AimiDatabase,
      $SessionReadStateTable,
      SessionReadStateData,
      $$SessionReadStateTableFilterComposer,
      $$SessionReadStateTableOrderingComposer,
      $$SessionReadStateTableAnnotationComposer,
      $$SessionReadStateTableCreateCompanionBuilder,
      $$SessionReadStateTableUpdateCompanionBuilder,
      (
        SessionReadStateData,
        BaseReferences<
          _$AimiDatabase,
          $SessionReadStateTable,
          SessionReadStateData
        >,
      ),
      SessionReadStateData,
      PrefetchHooks Function()
    >;

class $AimiDatabaseManager {
  final _$AimiDatabase _db;
  $AimiDatabaseManager(this._db);
  $$SessionsTableTableManager get sessions =>
      $$SessionsTableTableManager(_db, _db.sessions);
  $$SessionEventsTableTableManager get sessionEvents =>
      $$SessionEventsTableTableManager(_db, _db.sessionEvents);
  $$SentMessagesTableTableManager get sentMessages =>
      $$SentMessagesTableTableManager(_db, _db.sentMessages);
  $$SessionReadStateTableTableManager get sessionReadState =>
      $$SessionReadStateTableTableManager(_db, _db.sessionReadState);
}
