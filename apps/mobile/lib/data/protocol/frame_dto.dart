// aimi 协议的手机端手写 Dart 镜像，当前是过渡实现：尚未由协议定义自动生成，
// 生成方案落地后整体替换。
//
// 以电脑端的协议定义为唯一依据：本文件的每个 JSON 字段名、取值域白名单都与它逐字一致；
// 任何一方单独改名都会造成两端解析失败，改动必须两端同时进行。
//
// 解析采取宽松接收、严格校验：非契约帧（v 不为 1、未知 type、未知取值域、缺字段或类型不符）
// 一律降级为 null，绝不放行半截帧。

/// 权限 ID 为适配器定义的不透明标识，与协议包的边界校验保持一致。
String _permissionId(Map<String, dynamic> json, String key) {
  final value = _string(json, key);
  if (value.isEmpty ||
      value.length > 128 ||
      !RegExp(r'^[A-Za-z0-9_.:-]+$').hasMatch(value)) {
    throw FormatException('权限标识无效：$value');
  }
  return value;
}

/// 适配器提供的权限模式名称、含义与会话可用状态。
class PermissionModeDescriptorDto {
  /// 状态由服务端判定；客户端不依据名称猜测权限等级。
  const PermissionModeDescriptorDto({
    required this.id,
    required this.name,
    required this.description,
    required this.availability,
    this.reason,
  });

  /// 校验服务端描述，保留未来 agent 的自定义模式。
  factory PermissionModeDescriptorDto.fromJson(Map<String, dynamic> json) {
    final availability = _string(json, 'availability');
    if (!const {'available', 'unavailable', 'unknown'}.contains(availability)) {
      throw const FormatException('权限可用状态无效');
    }
    final name = _string(json, 'name');
    final description = _string(json, 'description');
    final reason = _optionalString(json, 'reason');
    if (name.isEmpty ||
        name.length > 128 ||
        description.length > 1024 ||
        (reason?.length ?? 0) > 1024) {
      throw const FormatException('权限描述长度无效');
    }
    return PermissionModeDescriptorDto(
      id: _permissionId(json, 'id'),
      name: name,
      description: description,
      availability: availability,
      reason: reason,
    );
  }

  final String id;
  final String name;
  final String description;
  final String availability;
  final String? reason;

  /// 镜像持久化使用与服务端一致的字段名。
  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'description': description,
    'availability': availability,
    if (reason != null) 'reason': reason,
  };
}

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
  'auth.pairing_failed',
  'protocol.bad_frame',
  'session.not_found',
  'session.agent_missing',
  'session.duplicate_command',
  'protocol.rate_limited',
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

/// 读取可空字符串字段：JSON 的 `null` 与「字段不存在」都归一为 null，非字符串且非 null 抛 [FormatException]。
String? _optionalString(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value == null) return null;
  if (value is! String) {
    throw FormatException('字段 $key 不是 string 也不是 null：$value');
  }
  return value;
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
    this.model,
    // 缺省 true 是 v:1 兼容口径：新服务端总下发 resumable（协议必填），
    // 只有旧服务端的帧缺字段——旧世界没有归档概念，composer 照常出现；
    // 若缺省 false 会把旧服务端的全部会话误判为「已归档」。
    this.resumable = true,
    this.permissionModes,
  });

  /// 从 welcome 构造；校验状态取值及权限标识格式，接受未来 agent 的自定义模式。
  factory SessionMetaDto.fromJson(Map<String, dynamic> json) {
    final permissionMode = _permissionId(json, 'permissionMode');
    final state = _string(json, 'state');
    if (!_sessionStates.contains(state)) {
      throw FormatException('state 不在取值域：$state');
    }
    return SessionMetaDto(
      id: _string(json, 'id'),
      agentId: _string(json, 'agentId'),
      cwd: _string(json, 'cwd'),
      permissionMode: permissionMode,
      permissionModes: json['permissionModes'] == null
          ? null
          : _objectList(
              json,
              'permissionModes',
            ).map(PermissionModeDescriptorDto.fromJson).toList(),
      state: state,
      lastSeq: _int(json, 'lastSeq'),
      createdAt: _int(json, 'createdAt'),
      updatedAt: _int(json, 'updatedAt'),
      model: json['model'] as String?,
      resumable: json['resumable'] is bool ? json['resumable'] as bool : true,
    );
  }

  /// 会话 id，由 server 生成并保持稳定
  final String id;

  /// 该会话绑定的 agent 标识；当前版本只会创建 claude 会话
  final String agentId;

  /// 会话工作目录，server 侧的绝对路径
  final String cwd;

  /// 当前权限模式的不透明标识；服务端负责支持范围和策略校验。
  final String permissionMode;

  /// 当前会话可切换模式；缺省表示旧服务端未提供。
  final List<PermissionModeDescriptorDto>? permissionModes;

  /// 会话状态；只能取白名单内的取值，看板红点与状态色据此渲染
  final String state;

  /// 服务端最新事件序号；重连时以它作为本机续接的起点，与本地已写入进度之间的缺口不回补
  final int lastSeq;

  /// 会话创建时间，server 毫秒时间戳
  final int createdAt;

  /// 最后更新时间，server 毫秒时间戳；看板卡按它降序排列
  final int updatedAt;

  /// 服务端持久化的模型名；缺省表示跟随 CLI 默认。
  final String? model;

  /// 服务端是否仍有 agent 续接线索。
  final bool resumable;

  /// 序列化为 JSON 对象；键名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。
  Map<String, dynamic> toJson() => {
    'id': id,
    'agentId': agentId,
    'cwd': cwd,
    'permissionMode': permissionMode,
    if (permissionModes != null)
      'permissionModes': permissionModes!.map((mode) => mode.toJson()).toList(),
    'state': state,
    'lastSeq': lastSeq,
    'createdAt': createdAt,
    'updatedAt': updatedAt,
    if (model != null) 'model': model,
    'resumable': resumable,
  };

  /// 只覆盖少数可局部更新的字段，其余原样保留；镜像侧跟随事件/配置变更时使用，
  /// 元数据的权威始终在服务端（下一次 welcome 会以服务端值覆盖）。
  SessionMetaDto copyWith({
    String? state,
    int? lastSeq,
    String? model,
    String? permissionMode,
    bool? resumable,
    List<PermissionModeDescriptorDto>? permissionModes,
  }) => SessionMetaDto(
    id: id,
    agentId: agentId,
    cwd: cwd,
    permissionMode: permissionMode ?? this.permissionMode,
    permissionModes: permissionModes ?? this.permissionModes,
    state: state ?? this.state,
    lastSeq: lastSeq ?? this.lastSeq,
    createdAt: createdAt,
    updatedAt: updatedAt,
    model: model ?? this.model,
    resumable: resumable ?? this.resumable,
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

  /// 目标 agent 标识；当前版本只支持 claude
  final String agentId;

  /// agent 的工作目录；server 侧需为已存在目录
  final String cwd;

  /// 权限模式：只允许 `default`/`plan`，手机不可提权，服务端另有守卫
  final String permissionMode;

  /// 可选模型名；为 null 时该键不写入 JSON，缺省由服务端选择
  final String? model;

  /// 可选首轮提示词；为 null 时该键不写入 JSON
  final String? initialPrompt;

  /// 序列化为 JSON 对象；键名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。
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

  factory AttachmentDto.fromJson(Map<String, dynamic> json) =>
      AttachmentDto(name: _string(json, 'name'), b64: _string(json, 'b64'));

  /// 附件文件名；服务端校验上限 255 字节，超出即被拒
  final String name;

  /// base64 编码的附件内容；服务端校验上限 1.4 MB，超出即被拒
  final String b64;

  /// 序列化为 JSON 对象；键名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。
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

  /// 按钮文案，直接展示在审批卡上
  final String label;

  /// 审批指令回传的选项值，取值限 once/always/reject
  final String kind;

  /// 序列化为 JSON 对象；键名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。
  Map<String, dynamic> toJson() => {'label': label, 'kind': kind};
}

/// 提问事件的候选项：`value` 用于回填回答指令，`label` 仅用于界面展示。
class ChoiceDto {
  const ChoiceDto({required this.label, required this.value});

  factory ChoiceDto.fromJson(Map<String, dynamic> json) =>
      ChoiceDto(label: _string(json, 'label'), value: _string(json, 'value'));

  /// 展示用的候选项文案，不参与回传
  final String label;

  /// answer 指令回传的值，与展示文案解耦
  final String value;

  /// 序列化为 JSON 对象；键名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。
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
    this.error = false,
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
    this.stderrTail,
    this.model,
  });

  /// 从 JSON 构造；未知 type、取值域越界，或必需字段缺失/类型不符时抛 [FormatException]。
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
        return AgentEventDto(
          type: type,
          text: _string(json, 'text'),
          error: json['error'] == true,
        );
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
          options: _objectList(
            json,
            'options',
          ).map(ApprovalOptionDto.fromJson).toList(),
        );
      case 'question':
        return AgentEventDto(
          type: type,
          id: _string(json, 'id'),
          prompt: _string(json, 'prompt'),
          choices: _objectList(
            json,
            'options',
          ).map(ChoiceDto.fromJson).toList(),
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
      case 'configured':
        return AgentEventDto(type: type, model: _string(json, 'model'));
      case 'exit':
        return AgentEventDto(
          type: type,
          exitCode: _optionalInt(json, 'exitCode'),
          durationMs: _int(json, 'durationMs'),
          stderrTail: _optionalString(json, 'stderrTail'),
        );
      default:
        throw FormatException('未知事件 type：$type');
    }
  }

  /// 事件类型，合法取值共 10 个：state/text_delta/thinking/tool_call/
  /// tool_result/permission/question/usage/notice/exit
  final String type;

  /// text_delta / thinking / notice 的文本负载
  final String? text;

  /// text_delta 是否为失败原因文本；true 时界面以红色渲染（服务端把 agent 错误
  /// 按回复位置送达）；缺省 false——旧服务端不发该键
  final bool error;

  /// state 变体的状态值，只能取白名单内的取值
  final String? state;

  /// tool_call / tool_result / permission / question 的关联 id，工具卡成对折叠靠它配对
  final String? id;

  /// tool_call 的工具名（如 Bash/Edit）
  final String? name;

  /// tool_call 的入参摘要，供手机展示，避免下发完整入参
  final String? summary;

  /// tool_call 入参的摘要哈希，用于判断两次调用是否同参
  final String? inputDigest;

  /// tool_result 是否成功，false 时界面按失败态渲染
  final bool? ok;

  /// tool_result 的输出摘录，server 侧已截断
  final String? outputExcerpt;

  /// tool_result 的进程退出码；`exit` 变体复用该字段，取值为「可空但必填」
  final int? exitCode;

  /// notice 的严重级，取值限 info/warn/error
  final String? severity;

  /// permission 的标题文案（审批卡主标题）
  final String? title;

  /// permission 的详细说明（审批卡正文）
  final String? detail;

  /// permission 变体的候选项，JSON 键为 `options`
  final List<ApprovalOptionDto>? options;

  /// question 变体的候选项，JSON 键同为 `options`（与 permission 的形状不同，
  /// 故选用独立字段承载）
  final List<ChoiceDto>? choices;

  /// question 的问题文案（提问卡主标题）
  final String? prompt;

  /// usage 的输入 token 数
  final int? tokensIn;

  /// usage 的输出 token 数
  final int? tokensOut;

  /// usage 的费用；服务端未提供时为 null
  final double? cost;

  /// exit 变体的会话总时长，单位毫秒
  final int? durationMs;

  /// exit 变体的 stderr 末段摘录（进程异常退出时的崩溃原因观测面）；正常退出或旧服务端缺省 null
  final String? stderrTail;

  /// configured 变体的 CLI 实测模型名；保留为执行记录，不覆盖会话模型选择。
  final String? model;

  /// 序列化为 JSON 对象：可选字段为 null 时省略该键，键名与电脑端协议的对应变体逐字一致，
  /// 任何一方单独改名都会造成解析失败；`exit.exitCode` 例外，协议规定为「可空但必填」，值为 null 也写出。
  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{'type': type};
    switch (type) {
      case 'state':
        json['state'] = state;
      case 'text_delta':
      case 'thinking':
        json['text'] = text;
        if (type == 'text_delta') _putIfNotNull(json, 'error', error);
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
        _putIfNotNull(json, 'stderrTail', stderrTail);
      case 'configured':
        json['model'] = model;
    }
    return json;
  }
}

/// 服务端发往手机的全部帧类型（welcome/pong/bye/session.event/ack/error/update.info），闭集之外一律不解析。
sealed class ServerFrameDto {
  const ServerFrameDto();
}

/// 模型清单项（welcome agents 投影与模型 picker 共用形状）。
class AgentModelOptionDto {
  const AgentModelOptionDto({
    required this.value,
    required this.name,
    this.detail,
  });

  /// 从 JSON 构造；value/name 缺失或类型不符时抛 [FormatException]。
  factory AgentModelOptionDto.fromJson(Map<String, dynamic> json) {
    return AgentModelOptionDto(
      value: _string(json, 'value'),
      name: _string(json, 'name'),
      detail: _optionalString(json, 'detail'),
    );
  }

  /// 协议值（configure.model / 创建 spec 直接回传）。
  final String value;

  /// 显示名（picker 行主标签）。
  final String name;

  /// 一行差异说明；缺省 null。
  final String? detail;

  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{'value': value, 'name': name};
    _putIfNotNull(json, 'detail', detail);
    return json;
  }
}

/// 单个 agent 的能力投影（welcome 帧携带）：手机据此渲染模型清单与权限档位。
class AgentCapabilityDto {
  const AgentCapabilityDto({
    required this.id,
    required this.label,
    required this.permissionCeiling,
    required this.models,
    this.permissionModes,
  });

  /// 从 JSON 构造；校验权限标识格式与可选能力描述，不猜测模式等级。
  factory AgentCapabilityDto.fromJson(Map<String, dynamic> json) {
    final ceiling = _permissionId(json, 'permissionCeiling');
    return AgentCapabilityDto(
      id: _string(json, 'id'),
      label: _string(json, 'label'),
      permissionCeiling: ceiling,
      permissionModes: json['permissionModes'] == null
          ? null
          : _objectList(
              json,
              'permissionModes',
            ).map(PermissionModeDescriptorDto.fromJson).toList(),
      models: _objectList(
        json,
        'models',
      ).map(AgentModelOptionDto.fromJson).toList(),
    );
  }

  /// 适配器标识（spec.agentId）。
  final String id;

  /// 展示名。
  final String label;

  /// 服务端配置的权限上限：手机只展示不超过该档位的选项。
  final String permissionCeiling;

  /// 适配器的模式目录，客户端按服务端顺序显示。
  final List<PermissionModeDescriptorDto>? permissionModes;

  /// 模型清单；空表示适配器无清单概念（手机回退内置清单）。
  final List<AgentModelOptionDto> models;

  Map<String, dynamic> toJson() => {
    'id': id,
    'label': label,
    'permissionCeiling': permissionCeiling,
    if (permissionModes != null)
      'permissionModes': permissionModes!.map((mode) => mode.toJson()).toList(),
    'models': models.map((m) => m.toJson()).toList(),
  };
}

/// 握手成功后的第一帧：服务端版本 + 会话元数据全量（+ 可选 agent 能力投影）。
class WelcomeFrameDto extends ServerFrameDto {
  const WelcomeFrameDto({
    required this.serverVersion,
    required this.sessions,
    this.agents,
    this.features,
  });

  /// 服务端版本；当前版本只用于展示与日志，不做兼容性判断
  final String serverVersion;

  /// 该 server 上的全部会话元数据（全量，非增量）
  final List<SessionMetaDto> sessions;

  /// agent 能力投影（模型清单 + 权限上限）；旧服务端不带该键（null）
  final List<AgentCapabilityDto>? agents;

  /// 显式能力声明，缺省时按旧服务端处理。
  final Map<String, dynamic>? features;
}

/// 服务端已确认的权限状态，独立于会话时间线与事件序号。
class SessionPermissionsFrameDto extends ServerFrameDto {
  /// 当前模式和能力目录须同时替换，不能用待确认的本地选择覆盖。
  const SessionPermissionsFrameDto({
    required this.sessionId,
    required this.currentMode,
    required this.modes,
  });
  final String sessionId;
  final String currentMode;
  final List<PermissionModeDescriptorDto> modes;
}

/// 配对成功帧；明文 token 只在此帧出现一次，调用方必须立即写入安全存储。
class PairedFrameDto extends ServerFrameDto {
  const PairedFrameDto({required this.token, required this.deviceId});

  final String token;
  final String deviceId;
}

/// 心跳回执：nonce 原样回传，用于判定「两拍未回」。
class PongFrameDto extends ServerFrameDto {
  const PongFrameDto({required this.nonce});

  /// 心跳序号；服务端按原值回传，连接层只用来清「未回拍数」，不校验连续性
  final int nonce;
}

/// 服务端主动终结连接（令牌被吊销、连接被其他设备接管、服务端停机）。
class ByeFrameDto extends ServerFrameDto {
  const ByeFrameDto({required this.reason});

  /// 终结原因：taken_over = 连接被其他设备接管，revoked = 令牌被吊销
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

  /// 从 JSON 构造；字段缺失或类型不符，以及 `seq` 为负时抛 [FormatException]。
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

  /// 事件所属会话 id，由 server 生成
  final String sessionId;

  /// 会话内单调递增事件序号，从 0 起；镜像层据它判乱序与重复
  final int seq;

  /// server 侧事件时刻，毫秒时间戳
  final int ts;

  /// 归一化的事件负载，其字段按事件 type 取用
  final AgentEventDto agentEvent;

  /// 序列化为 JSON 对象；键名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。
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

  /// 新建会话 id；手机据此 push 到 `/session/:id` 打开时间线
  final String sessionId;
}

/// 手机命令的终态回执；[clientId] 用于和断线前发出的命令对账。
class CommandAckFrameDto extends ServerFrameDto {
  const CommandAckFrameDto({
    required this.sessionId,
    required this.clientId,
    required this.status,
    this.code,
  });

  /// 命令所属会话。
  final String sessionId;

  /// 手机生成的幂等键。
  final String clientId;

  /// `delivered`、`duplicate` 或 `rejected`；`accepted` 为协议预留状态。
  final String status;

  /// 拒绝时的协议错误码。
  final String? code;
}

/// 错误帧：鉴权失败、会话不存在、服务端繁忙等失败回执；当前版本只记日志，不做界面呈现与自动重试。
class ErrorFrameDto extends ServerFrameDto {
  const ErrorFrameDto({required this.code, required this.message});

  /// 错误码；只能取白名单内的取值，未知码不会被解析成本类型
  final String code;

  /// 人类可读的错误说明，server 侧生成，可直接展示给用户
  final String message;
}

/// 已发布 APK 的元数据（update.info 帧 latest 字段）；[downloadPath] 是相对路径，
/// 手机按自身 WS 连接的 host:port 拼 HTTP(S) 下载 URL，下载时附加自己的设备 token 鉴权。
class AppUpdateManifestDto {
  const AppUpdateManifestDto({
    required this.versionName,
    required this.versionCode,
    required this.size,
    required this.sha256,
    required this.downloadPath,
    this.notes,
  });

  /// 从 JSON 构造；字段缺失、类型不符或取值越界（sha256 非 64 位小写 hex、
  /// downloadPath 不以 `/` 开头、versionCode 非正整数、size 为负）抛 [FormatException]。
  factory AppUpdateManifestDto.fromJson(Map<String, dynamic> json) {
    final versionName = _string(json, 'versionName');
    if (versionName.isEmpty) {
      throw FormatException('versionName 不能为空');
    }
    final versionCode = _int(json, 'versionCode');
    if (versionCode <= 0) {
      throw FormatException('versionCode 必须为正整数：$versionCode');
    }
    final size = _int(json, 'size');
    if (size < 0) {
      throw FormatException('size 不能为负：$size');
    }
    final sha256 = _string(json, 'sha256');
    if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(sha256)) {
      throw FormatException('sha256 必须为 64 位小写十六进制');
    }
    final downloadPath = _string(json, 'downloadPath');
    if (!downloadPath.startsWith('/')) {
      throw FormatException('downloadPath 必须为以 / 开头的相对路径');
    }
    final notes = json['notes'];
    if (notes != null && notes is! String) {
      throw FormatException('字段 notes 不是 string 也不是 null：$notes');
    }
    return AppUpdateManifestDto(
      versionName: versionName,
      versionCode: versionCode,
      size: size,
      sha256: sha256,
      downloadPath: downloadPath,
      notes: notes as String?,
    );
  }

  /// 人类可读版本名（如 "1.0.1"），仅展示用
  final String versionName;

  /// Android versionCode；手机以此为升级判据（严格大于自身才提示）
  final int versionCode;

  /// APK 字节数（下载进度与展示用）
  final int size;

  /// APK 文件 sha256（64 位小写十六进制），下载完成后校验完整性
  final String sha256;

  /// 下载相对路径，如 `/updates/app-2.apk`
  final String downloadPath;

  /// 可选发布说明，展示用
  final String? notes;
}

/// 更新信息帧：服务端当前最新发布版本；[latest] 为 null 表示服务端从未发布过 APK。
class UpdateInfoFrameDto extends ServerFrameDto {
  const UpdateInfoFrameDto({required this.latest});

  /// 最新发布版本的元数据；null = 服务端从未发布过
  final AppUpdateManifestDto? latest;
}

/// 电脑目录子项；path 为服务端规范化绝对路径。
class DirectoryEntryDto {
  const DirectoryEntryDto({required this.name, required this.path});
  final String name;
  final String path;
}

/// 服务端目录浏览结果；error 非空时 entries/path 不可用。
class DirectoryResultFrameDto extends ServerFrameDto {
  const DirectoryResultFrameDto({
    required this.requestId,
    this.path,
    this.parent,
    this.entries,
    this.error,
  });
  final String requestId;
  final String? path;
  final String? parent;
  final List<DirectoryEntryDto>? entries;
  final String? error;
}

/// 服务端帧的解析入口：契约内返回类型化帧，
/// 其余（含未知 type、未知 error code、取值域越界、类型不符、v≠1）一律返回 null。
class ServerFrameParser {
  const ServerFrameParser._();

  /// 解析一帧 JSON 对象：契约内返回对应类型化帧，其余一律返回 null，任何输入都不抛异常。
  static ServerFrameDto? parse(Map<String, dynamic> json) {
    try {
      if (json['v'] != 1) return null;
      switch (json['type']) {
        case 'welcome':
          return WelcomeFrameDto(
            serverVersion: _string(json, 'serverVersion'),
            features: json['features'] == null
                ? null
                : _object(json, 'features'),
            sessions: _objectList(
              json,
              'sessions',
            ).map(SessionMetaDto.fromJson).toList(),
            agents: json['agents'] == null
                ? null
                : _objectList(
                    json,
                    'agents',
                  ).map(AgentCapabilityDto.fromJson).toList(),
          );
        case 'session.permissions':
          return SessionPermissionsFrameDto(
            sessionId: _string(json, 'sessionId'),
            currentMode: _permissionId(json, 'currentMode'),
            modes: _objectList(
              json,
              'modes',
            ).map(PermissionModeDescriptorDto.fromJson).toList(),
          );
        case 'paired':
          return PairedFrameDto(
            token: _string(json, 'token'),
            deviceId: _string(json, 'deviceId'),
          );
        case 'pong':
          return PongFrameDto(nonce: _int(json, 'nonce'));
        case 'bye':
          return ByeFrameDto(reason: _string(json, 'reason'));
        case 'session.event':
          return SessionEventFrameDto.fromJson(json);
        case 'ack':
          return AckFrameDto(sessionId: _string(json, 'sessionId'));
        case 'command.ack':
          final status = _string(json, 'status');
          if (!const {
            'accepted',
            'delivered',
            'duplicate',
            'rejected',
          }.contains(status)) {
            return null;
          }
          final code = json['code'];
          if (code != null &&
              (code is! String || !_frameErrorCodes.contains(code))) {
            return null;
          }
          return CommandAckFrameDto(
            sessionId: _string(json, 'sessionId'),
            clientId: _string(json, 'clientId'),
            status: status,
            code: code as String?,
          );
        case 'error':
          final code = _string(json, 'code');
          if (!_frameErrorCodes.contains(code)) {
            return null;
          }
          return ErrorFrameDto(code: code, message: _string(json, 'message'));
        case 'update.info':
          // latest 缺字段（区别于显式 null）按非契约帧丢弃：无发布状态必须显式表达。
          if (!json.containsKey('latest')) {
            return null;
          }
          final latest = json['latest'];
          if (latest == null) {
            return UpdateInfoFrameDto(latest: null);
          }
          if (latest is! Map<String, dynamic>) {
            return null;
          }
          return UpdateInfoFrameDto(
            latest: AppUpdateManifestDto.fromJson(latest),
          );
        case 'directory.result':
          final rawEntries = json['entries'];
          return DirectoryResultFrameDto(
            requestId: _string(json, 'requestId'),
            path: _optionalString(json, 'path'),
            parent: _optionalString(json, 'parent'),
            entries: rawEntries == null
                ? null
                : _objectList(json, 'entries')
                      .map(
                        (entry) => DirectoryEntryDto(
                          name: _string(entry, 'name'),
                          path: _string(entry, 'path'),
                        ),
                      )
                      .toList(),
            error: _optionalString(json, 'error'),
          );
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

/// 手机发往服务端的全部帧类型（hello/ping/session.create/session.command/update.check），闭集之外不会构造。
sealed class ClientFrameDto {
  const ClientFrameDto();

  /// 握手帧；[token] 为配对时签发的设备令牌。当前版本恒不带 `resume`，连接一律从服务端最新状态开始。
  factory ClientFrameDto.hello({
    required String token,
    Map<String, dynamic>? resume,
    List<String>? permissionModes,
  }) = HelloFrameDto;

  /// 配对握手帧；不带 resume，成功后服务端下发 paired。
  factory ClientFrameDto.pair({
    required String pairingCode,
    required String deviceName,
    List<String>? permissionModes,
  }) = HelloPairFrameDto;

  /// 应用层心跳帧；[nonce] 由发送方自增，服务端按原值回 pong 以配对。
  factory ClientFrameDto.ping(int nonce) = PingFrameDto;

  /// 建会话帧；[spec] 的权限模式受白名单限制，手机不能借此提权。
  factory ClientFrameDto.sessionCreate(SessionSpecDto spec) =
      SessionCreateFrameDto;

  /// 命令帧；`clientId` 供服务端做幂等去重，避免断线重发导致命令执行两次。
  factory ClientFrameDto.sessionCommand({
    required String sessionId,
    required String clientId,
    required AgentCommandDto cmd,
  }) = SessionCommandFrameDto;

  /// 更新检查帧；无载荷，服务端应回一条 update.info。
  factory ClientFrameDto.updateCheck() = UpdateCheckFrameDto;

  /// 请求服务端列出电脑目录的子目录。
  factory ClientFrameDto.directoryList({
    required String requestId,
    required String path,
  }) = DirectoryListFrameDto;

  /// 会话分叉帧；以源会话的续接线索新开会话，服务端按 ack（新 sessionId）应答。
  factory ClientFrameDto.sessionFork({required String sourceId}) =
      SessionForkFrameDto;

  /// 序列化为 JSON 对象；键名与电脑端协议的对应帧类型逐字一致，任何一方单独改名都会造成解析失败。
  Map<String, dynamic> toJson();
}

/// 握手帧；`resume` 恒为 null，本机不向服务端请求补发历史事件，断线缺口不回补。
class HelloFrameDto extends ClientFrameDto {
  const HelloFrameDto({required this.token, this.resume, this.permissionModes});

  /// 设备 token，配对时签发并存入设备安全存储；服务端只保留哈希
  final String token;

  final Map<String, dynamic>? resume;

  final List<String>? permissionModes;

  @override
  Map<String, dynamic> toJson() => {
    'v': 1,
    'type': 'hello',
    'token': token,
    'resume': resume,
    'commandAck': true,
    'capabilities': {
      'dynamicPermissions': true,
      if (permissionModes != null) 'permissionModes': permissionModes,
    },
  };
}

/// 一次性配对码握手帧。
class HelloPairFrameDto extends ClientFrameDto {
  const HelloPairFrameDto({
    required this.pairingCode,
    required this.deviceName,
    this.permissionModes,
  });

  final String pairingCode;
  final String deviceName;
  final List<String>? permissionModes;

  @override
  Map<String, dynamic> toJson() => {
    'v': 1,
    'type': 'hello',
    'pairingCode': pairingCode,
    'deviceName': deviceName,
    'commandAck': true,
    'capabilities': {
      'dynamicPermissions': true,
      if (permissionModes != null) 'permissionModes': permissionModes,
    },
  };
}

/// 应用层心跳帧；与 pong 按 nonce 配对，用于判定链路是否仍然存活。
class PingFrameDto extends ClientFrameDto {
  const PingFrameDto(this.nonce);

  /// 本拍编号，自增；服务端以同值的 pong 回执，连接层据此清「未回拍数」
  final int nonce;

  @override
  Map<String, dynamic> toJson() => {'v': 1, 'type': 'ping', 'nonce': nonce};
}

/// 建会话帧；服务端成功后回 ack（携带新会话 id），失败回 error 帧。
class SessionCreateFrameDto extends ClientFrameDto {
  const SessionCreateFrameDto(this.spec);

  /// 建会话入参；权限模式只允许白名单内的 default/plan，手机不可提权
  final SessionSpecDto spec;

  @override
  Map<String, dynamic> toJson() => {
    'v': 1,
    'type': 'session.create',
    'spec': spec.toJson(),
  };
}

/// 指令帧；服务端执行前按 `clientId` 去重，同一 clientId 只执行一次。
class SessionCommandFrameDto extends ClientFrameDto {
  const SessionCommandFrameDto({
    required this.sessionId,
    required this.clientId,
    required this.cmd,
  });

  /// 目标会话 id，由 server 生成
  final String sessionId;

  /// 幂等键（uuid）：断线重发同一命令时由服务端去重，避免重复执行
  final String clientId;

  /// 发给 agent 的指令；当前版本只会用到 send 与 interrupt
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

/// 会话分叉帧；`sourceId` 为源会话 id，成功应答与建会话同形（ack.sessionId = 新会话）。
class SessionForkFrameDto extends ClientFrameDto {
  const SessionForkFrameDto({required this.sourceId});

  /// 源会话 id（aimi 侧）。
  final String sourceId;

  @override
  Map<String, dynamic> toJson() => {
    'v': 1,
    'type': 'session.fork',
    'sourceId': sourceId,
  };
}

/// 更新检查帧；无载荷，服务端以当前缓存的 update.info 应答。
class UpdateCheckFrameDto extends ClientFrameDto {
  const UpdateCheckFrameDto();

  @override
  Map<String, dynamic> toJson() => {'v': 1, 'type': 'update.check'};
}

/// 目录浏览请求帧。
class DirectoryListFrameDto extends ClientFrameDto {
  const DirectoryListFrameDto({required this.requestId, required this.path});
  final String requestId;
  final String path;
  @override
  Map<String, dynamic> toJson() => {
    'v': 1,
    'type': 'directory.list',
    'requestId': requestId,
    'path': path,
  };
}

/// 手机发往 agent 的统一指令。
/// 当前版本只用 `send`/`interrupt` 两个变体，approve/answer/stop/restart 尚未接入。
sealed class AgentCommandDto {
  const AgentCommandDto();

  /// 发消息指令；[text] 为消息正文（服务端上限 64 KB），[files] 为可选附件。
  factory AgentCommandDto.send(String text, {List<AttachmentDto>? files}) =
      SendCommandDto;

  /// 打断当前回合。
  factory AgentCommandDto.interrupt() = InterruptCommandDto;

  factory AgentCommandDto.approve({
    required String requestId,
    required String decision,
  }) = ApproveCommandDto;

  factory AgentCommandDto.answer({
    required String questionId,
    required String value,
  }) = AnswerCommandDto;

  factory AgentCommandDto.configure({String? model, String? permissionMode}) =
      ConfigureCommandDto;

  /// 序列化为 JSON 对象；键名与电脑端协议的对应变体逐字一致，任何一方单独改名都会造成解析失败。
  Map<String, dynamic> toJson();
}

/// 发消息指令：正文与可选附件，由服务端转交给该会话的 agent。
class SendCommandDto extends AgentCommandDto {
  const SendCommandDto(this.text, {this.files});

  /// 消息正文；服务端校验上限 64 KB，超出即被拒
  final String text;

  /// 可选附件；为 null 或空列表时该键不写入 JSON
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

/// 打断指令：中止该会话当前正在执行的回合，不带额外参数。
class InterruptCommandDto extends AgentCommandDto {
  const InterruptCommandDto();

  @override
  Map<String, dynamic> toJson() => {'cmd': 'interrupt'};
}

/// 审批指令。
class ApproveCommandDto extends AgentCommandDto {
  const ApproveCommandDto({required this.requestId, required this.decision});

  final String requestId;
  final String decision;

  @override
  Map<String, dynamic> toJson() => {
    'cmd': 'approve',
    'requestId': requestId,
    'decision': decision,
  };
}

/// 回答指令。
class AnswerCommandDto extends AgentCommandDto {
  const AnswerCommandDto({required this.questionId, required this.value});

  final String questionId;
  final String value;

  @override
  Map<String, dynamic> toJson() => {
    'cmd': 'answer',
    'questionId': questionId,
    'value': value,
  };
}

/// 运行中更新模型或权限档位。
class ConfigureCommandDto extends AgentCommandDto {
  const ConfigureCommandDto({this.model, this.permissionMode});

  final String? model;
  final String? permissionMode;

  @override
  Map<String, dynamic> toJson() => {
    'cmd': 'configure',
    if (model != null) 'model': model,
    if (permissionMode != null) 'permissionMode': permissionMode,
  };
}
