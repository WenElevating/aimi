// aimi 协议的手机端手写 Dart 镜像，当前是过渡实现：尚未由协议定义自动生成，
// 生成方案落地后整体替换。
//
// 以电脑端的协议定义为唯一依据：本文件的每个 JSON 字段名、取值域白名单都与它逐字一致；
// 任何一方单独改名都会造成两端解析失败，改动必须两端同时进行。
//
// 解析采取宽松接收、严格校验：非契约帧（v 不为 1、未知 type、未知取值域、缺字段或类型不符）
// 一律降级为 null，绝不放行半截帧。

/// 手机建会话允许提交的权限模式白名单。
/// 手机只能选择不高于默认权限的模式（default/plan）；提权请求即使发出也会被服务端拒绝。
const Set<String> _permissionModes = {'default', 'plan'};

/// 会话状态的全部合法取值；当前版本只驱动 running 子集，取值域固定，新增状态须两端同步扩展。
const Set<String> _sessionStates = {
  'starting',
  'running',
  'waiting_approval',
  'waiting_input',
  'finished',
  'failed',
  'stopped',
};

/// 通知事件的严重级合法取值；超出这三个取值的通知事件按非契约帧丢弃。
const Set<String> _noticeSeverities = {'info', 'warn', 'error'};

/// 错误帧的合法错误码取值；未知错误码即非契约帧，整帧丢弃。
const Set<String> _frameErrorCodes = {
  'auth.invalid_token',
  'auth.pairing_expired',
  'protocol.bad_frame',
  'session.not_found',
  'session.agent_missing',
  'session.duplicate_command',
  'server.busy',
};

/// 审批请求候选项的合法选项值；审批指令只接受这三个值，其余取值按非契约帧丢弃。
const Set<String> _approvalDecisions = {'once', 'always', 'reject'};

String _string(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! String) {
    throw FormatException('字段 $key 缺失或不是 string：$value');
  }
  return value;
}

int _int(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! num) {
    throw FormatException('字段 $key 缺失或不是 number：$value');
  }
  return value.toInt();
}

bool _bool(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! bool) {
    throw FormatException('字段 $key 缺失或不是 bool：$value');
  }
  return value;
}

/// 读取可空数值字段：JSON 的 `null` 与「字段不存在」都归一为 null，非数字且非 null 抛 [FormatException]。
int? _optionalInt(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value == null) return null;
  if (value is! num) {
    throw FormatException('字段 $key 不是 number 也不是 null：$value');
  }
  return value.toInt();
}

double? _optionalDouble(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value == null) return null;
  if (value is! num) {
    throw FormatException('字段 $key 不是 number 也不是 null：$value');
  }
  return value.toDouble();
}

List<Map<String, dynamic>> _objectList(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! List) {
    throw FormatException('字段 $key 缺失或不是数组：$value');
  }
  return value.map((item) {
    if (item is! Map<String, dynamic>) {
      throw FormatException('字段 $key 的元素不是对象：$item');
    }
    return item;
  }).toList();
}

Map<String, dynamic> _object(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! Map<String, dynamic>) {
    throw FormatException('字段 $key 缺失或不是对象：$value');
  }
  return value;
}

/// 序列化可空字段的约定：值为 null 时不写出该键，接收方按「字段不存在」处理。
void _putIfNotNull(Map<String, dynamic> json, String key, Object? value) {
  if (value != null) json[key] = value;
}

/// 会话列表项（随握手首个 welcome 帧全量下发）。
/// `state` 与 `lastSeq` 供手机恢复看板红点与断线续接：重连时以服务端下发的 lastSeq 作为本机新起点。
class SessionMetaDto {
  const SessionMetaDto({
    required this.id,
    required this.agentId,
    required this.cwd,
    required this.permissionMode,
    required this.state,
    required this.lastSeq,
    required this.createdAt,
    required this.updatedAt,
  });

  /// 从 welcome 帧的 JSON 构造；非法取值域（state/permissionMode 白名单外）抛 [FormatException]。
  factory SessionMetaDto.fromJson(Map<String, dynamic> json) {
    final permissionMode = _string(json, 'permissionMode');
    if (!_permissionModes.contains(permissionMode)) {
      throw FormatException('permissionMode 不在白名单：$permissionMode');
    }
    final state = _string(json, 'state');
    if (!_sessionStates.contains(state)) {
      throw FormatException('state 不在取值域：$state');
    }
    return SessionMetaDto(
      id: _string(json, 'id'),
      agentId: _string(json, 'agentId'),
      cwd: _string(json, 'cwd'),
      permissionMode: permissionMode,
      state: state,
      lastSeq: _int(json, 'lastSeq'),
      createdAt: _int(json, 'createdAt'),
      updatedAt: _int(json, 'updatedAt'),
    );
  }

  /// 会话 id（server 生成的稳定标识）。
  final String id;

  /// 该会话绑定的 agent 标识；当前版本只会创建 claude 会话。
  final String agentId;

  /// 会话工作目录（server 侧绝对路径）。
  final String cwd;

  /// 权限模式；只能取白名单内的 default/plan，手机不可提权。
  final String permissionMode;

  /// 会话状态；只能取白名单内的取值，看板红点与状态色据此渲染。
  final String state;

  /// 服务端最新事件序号：重连时以它作为本机续接的起点，与本地已写入进度之间的缺口不回补。
  final int lastSeq;

  /// 会话创建时间（server 毫秒时间戳）。
  final int createdAt;

  /// 最后更新时间（server 毫秒时间戳）：看板卡按它降序排列。
  final int updatedAt;

  /// 字段名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。
  Map<String, dynamic> toJson() => {
        'id': id,
        'agentId': agentId,
        'cwd': cwd,
        'permissionMode': permissionMode,
        'state': state,
        'lastSeq': lastSeq,
        'createdAt': createdAt,
        'updatedAt': updatedAt,
      };

  /// 局部覆盖（镜像侧跟随事件更新 lastSeq/state 用；元数据的权威始终在服务端）。
  SessionMetaDto copyWith({String? state, int? lastSeq}) => SessionMetaDto(
        id: id,
        agentId: agentId,
        cwd: cwd,
        permissionMode: permissionMode,
        state: state ?? this.state,
        lastSeq: lastSeq ?? this.lastSeq,
        createdAt: createdAt,
        updatedAt: updatedAt,
      );
}

/// 手机建会话的入参。
/// `permissionMode` 只能取白名单值，手机不能借建会话提升权限。
class SessionSpecDto {
  const SessionSpecDto({
    required this.agentId,
    required this.cwd,
    required this.permissionMode,
    this.model,
    this.initialPrompt,
  });

  /// 目标 agent 标识；当前版本只支持 claude。
  final String agentId;

  /// agent 的工作目录；server 侧需为已存在目录。
  final String cwd;

  /// 权限模式：只允许 `default`/`plan`（手机不可提权，服务端另有守卫）。
  final String permissionMode;

  /// 可选模型名；为 null 时该键不写入 JSON（缺省即由服务端默认选择）。
  final String? model;

  /// 可选首轮提示词；为 null 时该键不写入 JSON。
  final String? initialPrompt;

  /// 字段名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。
  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{
      'agentId': agentId,
      'cwd': cwd,
      'permissionMode': permissionMode,
    };
    _putIfNotNull(json, 'model', model);
    _putIfNotNull(json, 'initialPrompt', initialPrompt);
    return json;
  }
}

/// 消息附件；当前版本手机端不发送附件，保留该类型只为协议镜像完整。
class AttachmentDto {
  const AttachmentDto({required this.name, required this.b64});

  factory AttachmentDto.fromJson(Map<String, dynamic> json) => AttachmentDto(
        name: _string(json, 'name'),
        b64: _string(json, 'b64'),
      );

  /// 附件文件名；服务端校验上限 255 字节，超出即被拒。
  final String name;

  /// base64 编码的附件内容；服务端校验上限 1.4 MB，超出即被拒。
  final String b64;

  /// 字段名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。
  Map<String, dynamic> toJson() => {'name': name, 'b64': b64};
}

/// 审批请求候选项：`kind` 是审批指令回传的选项值，`label` 只用于界面展示。
class ApprovalOptionDto {
  const ApprovalOptionDto({required this.label, required this.kind});

  factory ApprovalOptionDto.fromJson(Map<String, dynamic> json) {
    final kind = _string(json, 'kind');
    if (!_approvalDecisions.contains(kind)) {
      throw FormatException('kind 不在裁决值域：$kind');
    }
    return ApprovalOptionDto(label: _string(json, 'label'), kind: kind);
  }

  /// 按钮文案。
  final String label;

  /// 审批指令回传的选项值（once/always/reject 白名单）。
  final String kind;

  /// 字段名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。
  Map<String, dynamic> toJson() => {'label': label, 'kind': kind};
}

/// 提问事件的候选项：`value` 用于回填回答指令，`label` 仅用于界面展示。
class ChoiceDto {
  const ChoiceDto({required this.label, required this.value});

  factory ChoiceDto.fromJson(Map<String, dynamic> json) =>
      ChoiceDto(label: _string(json, 'label'), value: _string(json, 'value'));

  /// 展示用的候选项文案。
  final String label;

  /// answer 指令回传的值。
  final String value;

  /// 字段名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。
  Map<String, dynamic> toJson() => {'label': label, 'value': value};
}

/// 归一化事件（全部 10 个变体）。
///
/// 变体字段按下标命名：协议的判别联合在 Dart 侧用「type + 可空负载字段」承载
/// （手写镜像的最小代价）。所有变体都必须能解析——**不能只认当前界面用到的 5 类**：整帧丢弃会
/// 让该会话的 seq 位移，`SessionCache` 的单调检查随后会把后续事件全部拒掉（永久停流）。
/// 界面当前只渲染其中 5 类（由时间线映射决定），其余类型解析后暂不展示。
class AgentEventDto {
  const AgentEventDto({
    required this.type,
    this.text,
    this.state,
    this.id,
    this.name,
    this.summary,
    this.inputDigest,
    this.ok,
    this.outputExcerpt,
    this.exitCode,
    this.severity,
    this.title,
    this.detail,
    this.options,
    this.choices,
    this.prompt,
    this.tokensIn,
    this.tokensOut,
    this.cost,
    this.durationMs,
  });

  /// 从 JSON 构造；未知 type 或缺失变体必需字段抛 [FormatException]。
  factory AgentEventDto.fromJson(Map<String, dynamic> json) {
    final type = _string(json, 'type');
    switch (type) {
      case 'state':
        final state = _string(json, 'state');
        if (!_sessionStates.contains(state)) {
          throw FormatException('state 不在取值域：$state');
        }
        return AgentEventDto(type: type, state: state);
      case 'text_delta':
      case 'thinking':
        return AgentEventDto(type: type, text: _string(json, 'text'));
      case 'tool_call':
        return AgentEventDto(
          type: type,
          id: _string(json, 'id'),
          name: _string(json, 'name'),
          summary: _string(json, 'summary'),
          inputDigest: _string(json, 'inputDigest'),
        );
      case 'tool_result':
        return AgentEventDto(
          type: type,
          id: _string(json, 'id'),
          ok: _bool(json, 'ok'),
          outputExcerpt: _string(json, 'outputExcerpt'),
          exitCode: _optionalInt(json, 'exitCode'),
        );
      case 'permission':
        return AgentEventDto(
          type: type,
          id: _string(json, 'id'),
          title: _string(json, 'title'),
          detail: _string(json, 'detail'),
          options: _objectList(json, 'options')
              .map(ApprovalOptionDto.fromJson)
              .toList(),
        );
      case 'question':
        return AgentEventDto(
          type: type,
          id: _string(json, 'id'),
          prompt: _string(json, 'prompt'),
          choices:
              _objectList(json, 'options').map(ChoiceDto.fromJson).toList(),
        );
      case 'usage':
        return AgentEventDto(
          type: type,
          tokensIn: _int(json, 'tokensIn'),
          tokensOut: _int(json, 'tokensOut'),
          cost: _optionalDouble(json, 'cost'),
        );
      case 'notice':
        final severity = _string(json, 'severity');
        if (!_noticeSeverities.contains(severity)) {
          throw FormatException('severity 不在取值域：$severity');
        }
        return AgentEventDto(
          type: type,
          severity: severity,
          text: _string(json, 'text'),
        );
      case 'exit':
        return AgentEventDto(
          type: type,
          exitCode: _optionalInt(json, 'exitCode'),
          durationMs: _int(json, 'durationMs'),
        );
      default:
        throw FormatException('未知事件 type：$type');
    }
  }

  /// 事件类型（见 [AgentEventDto.fromJson] 的分支：state/text_delta/thinking/tool_call/
  /// tool_result/permission/question/usage/notice/exit）。
  final String type;

  /// text_delta / thinking / notice 的文本负载。
  final String? text;

  /// state 变体的状态值（只能取白名单内的取值）。
  final String? state;

  /// tool_call / tool_result / permission / question 的关联 id（工具卡成对折叠靠它）。
  final String? id;

  /// tool_call 的工具名（如 Bash/Edit）。
  final String? name;

  /// tool_call 的入参摘要（供手机展示，避免下发完整入参）。
  final String? summary;

  /// tool_call 入参的摘要哈希（用于判断两次调用是否同参）。
  final String? inputDigest;

  /// tool_result 是否成功。
  final bool? ok;

  /// tool_result 的输出摘录（server 侧已截断）。
  final String? outputExcerpt;

  /// tool_result 的进程退出码；`exit` 变体的退出码为「可空但必填」。
  final int? exitCode;

  /// notice 的严重级（info/warn/error 白名单）。
  final String? severity;

  /// permission 的标题。
  final String? title;

  /// permission 的详细说明。
  final String? detail;

  /// permission 变体的候选项（JSON 键为 `options`）。
  final List<ApprovalOptionDto>? options;

  /// question 变体的候选项（JSON 键同为 `options`，与 permission 是两种不同形状，
  /// 故 Dart 侧分字段承载）。
  final List<ChoiceDto>? choices;

  /// question 的问题文案。
  final String? prompt;

  /// usage 的输入 token 数。
  final int? tokensIn;

  /// usage 的输出 token 数。
  final int? tokensOut;

  /// usage 的费用（可选）。
  final double? cost;

  /// exit 的会话时长（毫秒）。
  final int? durationMs;

  /// 字段名与电脑端协议的对应变体逐字一致；可选字段为 null 时省略该键。
  /// `exit.exitCode` 例外：协议规定为「可空但必填」，故始终写出（值为 null 也写）。
  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{'type': type};
    switch (type) {
      case 'state':
        json['state'] = state;
      case 'text_delta':
      case 'thinking':
        json['text'] = text;
      case 'tool_call':
        json['id'] = id;
        json['name'] = name;
        json['summary'] = summary;
        json['inputDigest'] = inputDigest;
      case 'tool_result':
        json['id'] = id;
        json['ok'] = ok;
        json['outputExcerpt'] = outputExcerpt;
        _putIfNotNull(json, 'exitCode', exitCode);
      case 'permission':
        json['id'] = id;
        json['title'] = title;
        json['detail'] = detail;
        json['options'] = options?.map((o) => o.toJson()).toList();
      case 'question':
        json['id'] = id;
        json['prompt'] = prompt;
        json['options'] = choices?.map((o) => o.toJson()).toList();
      case 'usage':
        json['tokensIn'] = tokensIn;
        json['tokensOut'] = tokensOut;
        _putIfNotNull(json, 'cost', cost);
      case 'notice':
        json['severity'] = severity;
        json['text'] = text;
      case 'exit':
        json['exitCode'] = exitCode;
        json['durationMs'] = durationMs;
    }
    return json;
  }
}

/// 服务端发往手机的全部帧类型（welcome/pong/bye/session.event/ack/error），闭集之外一律不解析。
sealed class ServerFrameDto {
  const ServerFrameDto();
}

/// 握手成功后的第一帧：服务端版本 + 会话元数据全量。
class WelcomeFrameDto extends ServerFrameDto {
  const WelcomeFrameDto({required this.serverVersion, required this.sessions});

  /// 服务端版本；当前版本只用于展示与日志，不做兼容性判断。
  final String serverVersion;

  /// 该 server 上的全部会话元数据（全量，非增量）。
  final List<SessionMetaDto> sessions;
}

/// 心跳回执：nonce 原样回传，用于判定「两拍未回」。
class PongFrameDto extends ServerFrameDto {
  const PongFrameDto({required this.nonce});

  /// 心跳序号，原样回传（连接层只用来清「未回拍数」，不校验连续性）。
  final int nonce;
}

/// 服务端主动终结连接（令牌被吊销、连接被其他设备接管、服务端停机）。
class ByeFrameDto extends ServerFrameDto {
  const ByeFrameDto({required this.reason});

  /// 终结原因（如 taken_over / revoked）。
  final String reason;
}

/// 事件流帧：`seq` 为会话内单调递增序号，从 0 起。
class SessionEventFrameDto extends ServerFrameDto {
  const SessionEventFrameDto({
    required this.sessionId,
    required this.seq,
    required this.ts,
    required this.agentEvent,
  });

  /// 从 JSON 构造；`seq` 为负或字段缺失抛 [FormatException]。
  factory SessionEventFrameDto.fromJson(Map<String, dynamic> json) {
    final seq = _int(json, 'seq');
    if (seq < 0) {
      throw FormatException('seq 必须非负：$seq');
    }
    return SessionEventFrameDto(
      sessionId: _string(json, 'sessionId'),
      seq: seq,
      ts: _int(json, 'ts'),
      agentEvent: AgentEventDto.fromJson(_object(json, 'agentEvent')),
    );
  }

  /// 事件所属会话。
  final String sessionId;

  /// 会话内单调递增事件序号（从 0 起）；镜像层的乱序/重复判据。
  final int seq;

  /// server 侧事件时刻（毫秒时间戳）。
  final int ts;

  /// 归一化事件负载。
  final AgentEventDto agentEvent;

  /// 字段名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。
  Map<String, dynamic> toJson() => {
        'v': 1,
        'type': 'session.event',
        'sessionId': sessionId,
        'seq': seq,
        'ts': ts,
        'agentEvent': agentEvent.toJson(),
      };
}

/// `session.create` 的回执，携带新建会话的 id。
class AckFrameDto extends ServerFrameDto {
  const AckFrameDto({required this.sessionId});

  /// 新建会话 id；手机据此 GoRouter push `/session/:id`。
  final String sessionId;
}

/// 错误帧；当前版本只记日志，不做界面呈现与自动重试。
class ErrorFrameDto extends ServerFrameDto {
  const ErrorFrameDto({required this.code, required this.message});

  /// 错误码；只能取白名单内的取值，未知码不会被解析成本类型。
  final String code;

  /// 人类可读的错误说明（server 侧文案，直接展示）。
  final String message;
}

/// 服务端帧的解析入口：契约内返回类型化帧，
/// 其余（含未知 type、未知 error code、取值域越界、类型不符、v≠1）一律返回 null。
class ServerFrameParser {
  const ServerFrameParser._();

  /// 契约内返回类型化帧，其余一律 null。
  static ServerFrameDto? parse(Map<String, dynamic> json) {
    try {
      if (json['v'] != 1) return null;
      switch (json['type']) {
        case 'welcome':
          return WelcomeFrameDto(
            serverVersion: _string(json, 'serverVersion'),
            sessions: _objectList(json, 'sessions')
                .map(SessionMetaDto.fromJson)
                .toList(),
          );
        case 'pong':
          return PongFrameDto(nonce: _int(json, 'nonce'));
        case 'bye':
          return ByeFrameDto(reason: _string(json, 'reason'));
        case 'session.event':
          return SessionEventFrameDto.fromJson(json);
        case 'ack':
          return AckFrameDto(sessionId: _string(json, 'sessionId'));
        case 'error':
          final code = _string(json, 'code');
          if (!_frameErrorCodes.contains(code)) return null;
          return ErrorFrameDto(code: code, message: _string(json, 'message'));
        default:
          return null;
      }
    } on FormatException {
      return null;
    } on TypeError {
      // 宽松 JSON（如 `sessions` 元素为数字）在类型转换处抛出的兜底。
      return null;
    }
  }
}

/// 手机发往服务端的全部帧类型（hello/ping/session.create/session.command），闭集之外不会构造。
sealed class ClientFrameDto {
  const ClientFrameDto();

  /// 握手帧；当前版本恒不带 `resume`，连接一律从服务端最新状态开始。
  factory ClientFrameDto.hello({required String token}) = HelloFrameDto;

  /// 应用层心跳帧。
  factory ClientFrameDto.ping(int nonce) = PingFrameDto;

  /// 建会话帧。
  factory ClientFrameDto.sessionCreate(SessionSpecDto spec) =
      SessionCreateFrameDto;

  /// 命令帧；`clientId` 供服务端做幂等去重，避免断线重发导致命令执行两次。
  factory ClientFrameDto.sessionCommand({
    required String sessionId,
    required String clientId,
    required AgentCommandDto cmd,
  }) = SessionCommandFrameDto;

  /// 字段名与电脑端协议的对应帧类型逐字一致，任何一方单独改名都会造成解析失败。
  Map<String, dynamic> toJson();
}

/// `hello` 帧；`resume` 恒为 null，本机不向服务端请求补发历史事件。
class HelloFrameDto extends ClientFrameDto {
  const HelloFrameDto({required this.token});

  /// 设备 token（配对时签发，存 secure_storage；server 只存哈希）。
  final String token;

  @override
  Map<String, dynamic> toJson() =>
      {'v': 1, 'type': 'hello', 'token': token, 'resume': null};
}

/// `ping` 帧。
class PingFrameDto extends ClientFrameDto {
  const PingFrameDto(this.nonce);

  /// 本拍编号（自增），pong 原样回传以配对。
  final int nonce;

  @override
  Map<String, dynamic> toJson() => {'v': 1, 'type': 'ping', 'nonce': nonce};
}

/// `session.create` 帧。
class SessionCreateFrameDto extends ClientFrameDto {
  const SessionCreateFrameDto(this.spec);

  /// 建会话入参（权限模式白名单见 [SessionSpecDto.permissionMode]）。
  final SessionSpecDto spec;

  @override
  Map<String, dynamic> toJson() =>
      {'v': 1, 'type': 'session.create', 'spec': spec.toJson()};
}

/// `session.command` 帧。
class SessionCommandFrameDto extends ClientFrameDto {
  const SessionCommandFrameDto({
    required this.sessionId,
    required this.clientId,
    required this.cmd,
  });

  /// 目标会话 id。
  final String sessionId;

  /// 幂等键（uuid）：断线重发同一命令时由服务端去重，避免重复执行。
  final String clientId;

  /// 发给 agent 的指令；当前版本只会用到 send 与 interrupt。
  final AgentCommandDto cmd;

  @override
  Map<String, dynamic> toJson() => {
        'v': 1,
        'type': 'session.command',
        'sessionId': sessionId,
        'clientId': clientId,
        'cmd': cmd.toJson(),
      };
}

/// 手机发往 agent 的统一指令。
/// 当前版本只用 `send`/`interrupt` 两个变体，approve/answer/stop/restart 尚未接入。
sealed class AgentCommandDto {
  const AgentCommandDto();

  /// 发消息（可带附件）。
  factory AgentCommandDto.send(String text, {List<AttachmentDto>? files}) =
      SendCommandDto;

  /// 打断当前回合。
  factory AgentCommandDto.interrupt() = InterruptCommandDto;

  /// 字段名与电脑端协议的对应变体逐字一致，任何一方单独改名都会造成解析失败。
  Map<String, dynamic> toJson();
}

/// `send` 指令。
class SendCommandDto extends AgentCommandDto {
  const SendCommandDto(this.text, {this.files});

  /// 消息正文；服务端校验上限 64 KB，超出即被拒。
  final String text;

  /// 可选附件；为 null 或空列表时该键不写入 JSON。
  final List<AttachmentDto>? files;

  @override
  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{'cmd': 'send', 'text': text};
    final attachments = files;
    if (attachments != null && attachments.isNotEmpty) {
      json['files'] = attachments.map((f) => f.toJson()).toList();
    }
    return json;
  }
}

/// `interrupt` 指令。
class InterruptCommandDto extends AgentCommandDto {
  const InterruptCommandDto();

  @override
  Map<String, dynamic> toJson() => {'cmd': 'interrupt'};
}
