import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:uuid/uuid.dart';

import '../cache/session_mirror.dart';
import '../logging/aimi_logger.dart';
import '../protocol/frame_dto.dart';
import '../observability/metrics.dart';
import '../observability/client_metrics.dart';

/// 连接的三种状态取值；当前只有局域网直连一条链路，中继链路的细分尚未接入。
enum ConnState {
  /// 未连接（初始态，或用户主动断开）
  offline,

  /// 断开中：已按退避排期下一次尝试
  reconnecting,

  /// 已建立 LAN 直连且完成握手
  onlineLan,

  /// 已建立 relay 中继连接。
  onlineRelay,
}

/// 手机连接服务端所需的三要素（主机、端口、令牌），由用户在设置页填写并存入设备安全存储。
/// 本机 hello 能力声明的权限档位全集（手机→服务端方向；与服务端 PhonePermissionMode 白名单一致）。
/// 收敛单一定义：providers / pairing payload / 连接层共用，防止多处字面量漂移。
const List<String> kPhonePermissionModes = <String>[
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
];

class AimiEndpoints {
  const AimiEndpoints({
    required this.host,
    required this.port,
    required this.token,
    this.scheme = 'ws',
    this.relayUrl,
    this.serverId,
    this.tlsFingerprint,
    this.permissionModes,
  });

  /// 服务端的局域网主机，可填 IP 或主机名；由用户在设置页手填
  final String host;

  /// server 的 LAN 端口，取值 1-65535；越界或非法在设置页即被拒
  final int port;

  /// 设备 token，配对时签发；仅存手机 secure_storage，服务端只保留哈希
  final String token;

  /// WebSocket scheme；默认保留旧版 `ws`，配对二维码可提供 `wss`。
  final String scheme;

  /// relay 设备拨入地址；为空时只使用 LAN。
  final String? relayUrl;

  /// 服务端稳定标识，用于配对端点校验。
  final String? serverId;

  /// QR 提供的 TLS SHA-256 指纹。
  final String? tlsFingerprint;

  /// hello 能力声明；为空保持旧客户端 wire 形态。
  final List<String>? permissionModes;

  /// 手机发往服务端的 WebSocket 地址。
  Uri get webSocketUri =>
      Uri(scheme: scheme, host: host, port: port, path: '/ws');

  Uri? get relayUri {
    final raw = relayUrl;
    if (raw == null) return null;
    final uri = Uri.tryParse(raw);
    if (uri == null || uri.host.isEmpty) return null;
    final id = serverId;
    if (id == null || id.isEmpty) return uri;
    final path = uri.path == '/serve' ? '/device' : uri.path;
    final query = <String, String>{...uri.queryParameters};
    query.putIfAbsent('serverId', () => id);
    return uri.replace(path: path, queryParameters: query);
  }
}

/// 连接状态机：
/// 单向管道为：建立连接 → 发 hello → 收 welcome（元数据写入镜像）→ 事件流持续写入镜像；
/// 断线按 1s→2s→4s→…→30s 封顶并叠加抖动自动重连；应用层心跳每 15s 一次，连续两拍未回即判死重连；
/// `createSession`/`sendCommand` 是对外写入口；状态经 [StateNotifier] 暴露给界面。
///
/// 线程/生命周期约定：本类不持有真实 socket，channel 由 [channelFactory] 注入（测试用流对桩）；
/// [dispose] 后停止一切重连与心跳。错误帧只记日志，不做界面呈现。
class AimiConnection extends StateNotifier<ConnState> {
  /// [channelFactory] 由调用方注入（生产用 `WebSocketChannel.connect`，测试用流对桩）。
  /// [delay] 注入重连等待，便于测试用可放行闸门驱动退避；[pingPeriod]/[connectTimeout]/
  /// [createTimeout] 同理可注入以缩短单测时长；[random] 供退避抖动可复现。
  AimiConnection({
    required this.endpoints,
    required this.cache,
    required WebSocketChannel Function(Uri) channelFactory,
    Future<void> Function(Duration) delay = _defaultDelay,
    Duration pingPeriod = const Duration(seconds: 15),
    Duration connectTimeout = const Duration(seconds: 5),
    // createTimeout 15s：zcode 协议会话首次创建含 app-server 冷启 + 探测（~6s），
    // 5s 会让首个 zcode 会话必然「创建失败」；claude 创建秒级返回，不受影响。
    Duration createTimeout = const Duration(seconds: 15),
    Random? random,
    DateTime Function() now = DateTime.now,
    this.onRevoked,
    MetricRecorder? metrics,
  }) : metricsProvider =
           metrics ??
           MetricRecorder(
             sourceId: 'client.connection',
             descriptors: clientConnectionMetrics,
           ),
       _channelFactory = channelFactory,
       _delay = delay,
       _pingPeriod = pingPeriod,
       _connectTimeout = connectTimeout,
       _createTimeout = createTimeout,
       _random = random ?? Random(),
       _now = now,
       super(ConnState.offline);

  /// 首次重连退避基数（1s）；断开后的前期以 1s、2s 的短间隔积极重试
  static const Duration baseBackoff = Duration(seconds: 1);

  /// 退避上限（30s）：失败无限重试，但间隔不再增长，避免长期离线时脉冲风暴
  static const Duration maxBackoff = Duration(seconds: 30);

  /// 退避抖动上限（ms）；多设备/多会话避免同拍重连，上限有界便于断言
  static const int backoffJitterMillis = 250;

  /// 退避的最大位移次数；1s<<5 即 32s，已超上限，再多算会溢出
  static const int _maxBackoffShift = 5;

  /// 连接三要素（主机、端口、令牌），构造后不变
  final AimiEndpoints endpoints;

  /// 服务端状态的本地镜像（welcome 元数据 + 事件流），由连接层单方写入
  final SessionMirror cache;

  /// 连接组件的指标来源；观测上下文不持有原始帧内容。
  final MetricRecorder metricsProvider;
  late final MetricsEventContext metricsContext = MetricsEventContext(
    metricsProvider,
  );

  final WebSocketChannel Function(Uri) _channelFactory;
  final Future<void> Function(Duration) _delay;
  final Duration _pingPeriod;
  final Duration _connectTimeout;
  final Duration _createTimeout;
  final Random _random;
  final DateTime Function() _now;

  /// token 被吊销时由装配层清理安全存储并回到 welcome。
  final Future<void> Function()? onRevoked;

  final StreamController<SessionEventFrameDto> _events =
      StreamController<SessionEventFrameDto>.broadcast();

  /// 待回执的建会话请求；按发送顺序与回执一一配对，同时只会有一个在途
  final List<Completer<String?>> _pendingCreates = <Completer<String?>>[];

  /// 待回执的手机命令；按 clientId 关联，允许不同会话并发等待。
  final Map<String, Completer<CommandAckFrameDto?>> _pendingCommands =
      <String, Completer<CommandAckFrameDto?>>{};
  final Map<String, Completer<DirectoryResultFrameDto?>> _pendingDirectories =
      <String, Completer<DirectoryResultFrameDto?>>{};

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Completer<WelcomeFrameDto>? _pendingWelcome;
  Timer? _heartbeatTimer;
  Future<void>? _retryTask;
  int _retryAttempt = 0;
  int _missedPongs = 0;
  int _nonce = 0;
  bool _manualClose = false;
  bool _disposed = false;
  bool _preferLanOnNextRetry = false;
  DateTime? _retryStartedAt;

  /// 服务端主动终结连接的原因流（`taken_over` / `revoked` / 其它 bye）。
  ///
  /// why 单独一条流：这类终结不是"暂时断线"，重连也不会自动恢复（吊销需重新配对、
  /// 接管需回到该设备），界面必须切到终局覆盖层而不是一直显示"重连中"。
  final StreamController<String> _terminations =
      StreamController<String>.broadcast();

  /// 服务端主动终结连接的原因（见 [_terminations]）。
  Stream<String> get terminations => _terminations.stream;

  /// 服务端推送的更新信息流（welcome 后直发、发布广播、update.check 应答共用一个入口）。
  final StreamController<UpdateInfoFrameDto> _updates =
      StreamController<UpdateInfoFrameDto>.broadcast();

  /// 服务端推送的更新信息（见 [_updates]）；订阅者自行比较 versionCode 决定是否提示。
  Stream<UpdateInfoFrameDto> get updates => _updates.stream;

  /// 服务端 agent 能力投影流（每次 welcome 到达即发最新快照）。
  final StreamController<List<AgentCapabilityDto>> _caps =
      StreamController<List<AgentCapabilityDto>>.broadcast();

  /// agent 能力投影（模型清单 + 权限上限；见 [_caps]）——手机渲染选项替代端上硬编码的数据源。
  Stream<List<AgentCapabilityDto>> get caps => _caps.stream;

  bool _supportsDynamicPermissions = false;
  bool _supportsDirectoryBrowsing = false;
  bool _supportsSessionFork = false;
  List<AgentCapabilityDto> _agentCapabilities = const [];

  /// 只有服务端明确发布动态目录，才使用权威权限快照。
  bool get supportsDynamicPermissions => _supportsDynamicPermissions;

  /// 未声明目录能力的旧服务端不能接收 directory.list。
  bool get supportsDirectoryBrowsing => _supportsDirectoryBrowsing;

  /// 旧服务端未声明分叉能力时不显示分叉入口（欢迎帧 features.sessionFork）。
  bool get supportsSessionFork => _supportsSessionFork;

  /// 当前连接的能力快照，覆盖订阅晚于 welcome 到达的场景。
  List<AgentCapabilityDto> get agentCapabilities => _agentCapabilities;

  /// 手动触发一次更新检查：向服务端发 update.check，应答会进入 [updates] 流。
  /// 未连接时返回 false（调用方据此提示"离线"），不做排队重发。
  bool checkForUpdate() => _send(ClientFrameDto.updateCheck().toJson());

  /// 事件流转发：**已写入 cache** 后才发出（订阅者与镜像看到同一序列）
  Stream<SessionEventFrameDto> get events => _events.stream;

  /// 建立连接：成功进 [ConnState.onlineLan]，失败进 [ConnState.reconnecting] 并按退避自动重试。
  ///
  /// 副作用：建立 WebSocket 通道、发 hello、启动心跳计时器，welcome 携带的元数据写入 cache。
  /// 该方法只等待「本次尝试」的结果，不等待整条重连链——故永久失败时也会及时返回。
  /// 并发调用是安全的：拨号单飞（见 [_attemptOnceShared]），后来者共享同一次尝试。
  Future<void> connect() async {
    _manualClose = false;
    _retryAttempt = 0;
    final ok = await _attemptOnceShared(relay: false);
    if (!ok && !_manualClose && !_disposed) {
      _retryStartedAt = _now();
      state = ConnState.reconnecting;
      _ensureRetryLoop();
    }
  }

  /// 主动断开：停止重连与心跳，关闭通道并落 [ConnState.offline]。
  Future<void> disconnect() async {
    _manualClose = true;
    _retryAttempt = 0;
    _retryStartedAt = null;
    _teardownChannel();
    state = ConnState.offline;
  }

  /// 发 `session.create` 并等 ack：拿到 sessionId 返回它；server 回 error 帧或超时返回 null。
  ///
  /// 未在线时直接返回 null，不排队等待；离线期间新建的会话不会在恢复连接后补发。
  Future<String?> createSession(SessionSpecDto spec) async {
    if (state != ConnState.onlineLan && state != ConnState.onlineRelay) {
      return null;
    }
    final completer = Completer<String?>();
    _pendingCreates.add(completer);
    if (!_send(ClientFrameDto.sessionCreate(spec).toJson())) {
      _pendingCreates.remove(completer);
      return null;
    }
    try {
      return await completer.future.timeout(_createTimeout);
    } on TimeoutException {
      _pendingCreates.remove(completer);
      aimiLog(
        AimiLogLevel.warn,
        'conn',
        'session.create 等待 ack 超时（${_createTimeout.inSeconds}s）',
      );
      return null;
    }
  }

  /// 发 `session.fork` 并等 ack：成功返回新 sessionId；未在线/写失败/超时/错误帧返回 null。
  ///
  /// ack 与 session.create 同形且服务端按帧序应答，故补发等待复用 [_pendingCreates]
  /// 的 FIFO 配对；分叉不支持离线排队（时点语义——分叉的是「此刻」的会话线索）。
  Future<String?> forkSession(String sourceId) async {
    if (state != ConnState.onlineLan && state != ConnState.onlineRelay) {
      return null;
    }
    final completer = Completer<String?>();
    _pendingCreates.add(completer);
    if (!_send(ClientFrameDto.sessionFork(sourceId: sourceId).toJson())) {
      _pendingCreates.remove(completer);
      return null;
    }
    try {
      return await completer.future.timeout(_createTimeout);
    } on TimeoutException {
      _pendingCreates.remove(completer);
      aimiLog(
        AimiLogLevel.warn,
        'conn',
        'session.fork 等待 ack 超时（${_createTimeout.inSeconds}s）',
      );
      return null;
    }
  }

  /// 发送一条 agent 指令并等待 server 按 [clientId] 返回终态回执。
  /// 离线、写入失败或超时返回 null；server 侧仍按 clientId 做幂等去重。
  Future<CommandAckFrameDto?> sendCommand(
    String sessionId,
    String clientId,
    AgentCommandDto cmd,
  ) async {
    if (state != ConnState.onlineLan && state != ConnState.onlineRelay) {
      return null;
    }
    final completer = Completer<CommandAckFrameDto?>();
    _pendingCommands[clientId] = completer;
    // 命令生命周期节点①：send（卡死排查主线：后续 ack/starting/首 token/exit
    // 各节点均入日志，时间戳即耗时口径——断在哪一环、卡了多久一眼可见）。
    aimiLog(
      AimiLogLevel.info,
      'cmd',
      'session=$sessionId send clientId=$clientId ${_cmdDigest(cmd)}',
    );
    if (!_send(
      ClientFrameDto.sessionCommand(
        sessionId: sessionId,
        clientId: clientId,
        cmd: cmd,
      ).toJson(),
    )) {
      _pendingCommands.remove(clientId);
      aimiLog(
        AimiLogLevel.warn,
        'cmd',
        'session=$sessionId clientId=$clientId 未连接，发送丢弃',
      );
      return null;
    }
    try {
      return await completer.future.timeout(_createTimeout);
    } on TimeoutException {
      if (identical(_pendingCommands[clientId], completer)) {
        _pendingCommands.remove(clientId);
      }
      aimiLog(
        AimiLogLevel.warn,
        'cmd',
        'session=$sessionId clientId=$clientId 等待回执超时（${_createTimeout.inSeconds}s）——卡死排查：ack 未到',
      );
      return null;
    }
  }

  /// 请求电脑目录，返回请求匹配的结果；本地失败使用独立错误码，不发送不支持的帧。
  Future<DirectoryResultFrameDto?> listDirectory(String path) async {
    if (state != ConnState.onlineLan && state != ConnState.onlineRelay) {
      return const DirectoryResultFrameDto(requestId: '', error: 'offline');
    }
    if (!_supportsDirectoryBrowsing) {
      return const DirectoryResultFrameDto(requestId: '', error: 'unsupported');
    }
    final requestId = const Uuid().v4();
    final completer = Completer<DirectoryResultFrameDto?>();
    _pendingDirectories[requestId] = completer;
    if (!_send(
      ClientFrameDto.directoryList(requestId: requestId, path: path).toJson(),
    )) {
      _pendingDirectories.remove(requestId);
      return DirectoryResultFrameDto(requestId: requestId, error: 'offline');
    }
    try {
      return await completer.future.timeout(_createTimeout);
    } on TimeoutException {
      _pendingDirectories.remove(requestId);
      return DirectoryResultFrameDto(requestId: requestId, error: 'timeout');
    }
  }

  /// 命令摘要（日志用）：文本前 50 字，不落全文防日志膨胀。
  String _cmdDigest(AgentCommandDto cmd) {
    if (cmd is SendCommandDto) {
      final text = cmd.text;
      final head = text.length <= 50 ? text : '${text.substring(0, 50)}…';
      return 'send "$head"${cmd.files == null ? '' : ' +${cmd.files!.length}附件'}';
    }
    if (cmd is InterruptCommandDto) return 'interrupt';
    return 'cmd(${cmd.runtimeType})';
  }

  @override
  void dispose() {
    _disposed = true;
    metricsProvider.close();
    _manualClose = true;
    _teardownChannel();
    unawaited(_events.close());
    unawaited(_terminations.close());
    unawaited(_updates.close());
    unawaited(_caps.close());
    super.dispose();
  }

  /// 在途拨号（单飞句柄）；null 表示当前无拨号。
  Future<bool>? _connectAttempt;

  /// 拨号单飞：同一时刻至多一次 [_attemptOnce] 在跑，后来者直接共享其结果。
  ///
  /// why：冷启动双拨号竞态——两次 attempt 共享 `_channel`/`_pendingWelcome` 字段，
  /// 失败方的 teardown 会拆掉成功方的健康连接并取消其心跳与订阅（取消的订阅
  /// 不触发 onDone，也无重连）→ 僵尸在线（UI 已连接、socket 已死、重放永不到）。
  /// connect() 与重连链都经此入口，让「至多一次拨号」成为结构不变量。
  Future<bool> _attemptOnceShared({required bool relay}) {
    final inFlight = _connectAttempt;
    if (inFlight != null) return inFlight;
    final task = _attemptOnce(relay: relay);
    _connectAttempt = task;
    unawaited(
      task.whenComplete(() {
        if (identical(_connectAttempt, task)) _connectAttempt = null;
      }),
    );
    return task;
  }

  /// 执行一次连接尝试：成功则把 welcome 元数据写入 cache 并返回 true，失败返回 false。
  Future<bool> _attemptOnce({required bool relay}) async {
    _teardownChannel();
    final welcome = Completer<WelcomeFrameDto>();
    _pendingWelcome = welcome;

    // 代次快照：本 attempt 自己创建的通道与 welcome。过时 attempt 收口时
    // 不得触碰共享字段（可能已是后继 attempt 的健康通道）。
    WebSocketChannel? myChannel;
    try {
      // 工厂自身可能同步抛错（端口未开/被拒），必须留在 try 内以便统一收口为重连。
      final uri = relay ? endpoints.relayUri : endpoints.webSocketUri;
      if (uri == null) return false;
      aimiLog(AimiLogLevel.info, 'conn', '拨号尝试#${_retryAttempt + 1}: $uri');
      final channel = _channelFactory(uri);
      myChannel = channel;
      _channel = channel;
      _sub = channel.stream.listen(
        _onRaw,
        onError: (Object error) => _onChannelLoss('socket error: $error'),
        onDone: () => _onChannelLoss('socket closed'),
      );

      await channel.ready.timeout(_connectTimeout);
      // 挂起期间通道被顶替（重连链已接管）：本 attempt 已过时，按失败收口且不碰共享状态。
      if (!identical(_channel, myChannel)) return false;
      final cursors = cache.resumeCursors();
      _send(
        ClientFrameDto.hello(
          token: endpoints.token,
          resume: cursors.isEmpty ? null : cursors,
          permissionModes: endpoints.permissionModes,
        ).toJson(),
      );
      final w = await welcome.future.timeout(_connectTimeout);
      if (_manualClose || _disposed) return false;
      // 代次守卫（welcome 完成点）：_onRaw 收到 welcome 即把 _pendingWelcome
      // 置 null，故此处校验的是通道代次——通道已被后继 attempt 顶替则本
      // attempt 过时，不再置状态/启心跳（防未来重构引入并发双拨号）。
      if (!identical(_channel, myChannel)) return false;
      state = relay ? ConnState.onlineRelay : ConnState.onlineLan;
      _missedPongs = 0;
      _startHeartbeat();
      aimiLog(
        AimiLogLevel.info,
        'conn',
        '已连接（${w.sessions.length} 个会话, server ${w.serverVersion}）',
      );
      return true;
    } on Object catch (error) {
      aimiLog(AimiLogLevel.warn, 'conn', '连接尝试失败：$error');
      // 代次守卫：仅当仍持有自己创建的通道才允许 teardown。过时 attempt 的
      // 超时拆掉后继健康通道正是僵尸在线的根源，此处是最后防线。
      if (identical(_channel, myChannel)) _teardownChannel();
      return false;
    }
  }

  /// 退避重连循环：每次失败后等待递增的间隔再试，直到连接成功或主动断开。
  Future<void> _retryLoop() async {
    while (!_manualClose && !_disposed) {
      await _delay(_backoffFor(_retryAttempt++));
      if (_manualClose || _disposed) return;
      final elapsed = _retryStartedAt == null
          ? Duration.zero
          : _now().difference(_retryStartedAt!);
      final useRelay =
          !_preferLanOnNextRetry &&
          endpoints.relayUri != null &&
          elapsed >= const Duration(seconds: 3);
      _preferLanOnNextRetry = false;
      if (await _attemptOnceShared(relay: useRelay)) return;
    }
  }

  /// 保证同一时刻只有一条重连链（connect 失败与中途断线可能同时触发）。
  void _ensureRetryLoop() {
    if (_manualClose || _disposed || _retryTask != null) return;
    final task = _retryLoop();
    _retryTask = task;
    unawaited(
      task.whenComplete(() {
        if (identical(_retryTask, task)) _retryTask = null;
      }),
    );
  }

  /// 第 [attempt] 次重连要等待的时长：1s 起按 2 的幂增长、30s 封顶，另加有界的随机抖动。
  Duration _backoffFor(int attempt) {
    final shift = min(attempt, _maxBackoffShift);
    final base = min(
      baseBackoff.inMilliseconds << shift,
      maxBackoff.inMilliseconds,
    );
    return Duration(
      milliseconds: base + _random.nextInt(backoffJitterMillis + 1),
    );
  }

  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(_pingPeriod, (_) => _onHeartbeatTick());
  }

  /// 心跳拍：上一拍未收到回执即判死（两拍未回，最迟约 30s 内检出）。
  void _onHeartbeatTick() {
    if (_manualClose || _disposed) return;
    if (_missedPongs >= 1) {
      _onChannelLoss('心跳两拍未回');
      return;
    }
    _missedPongs++;
    _send(ClientFrameDto.ping(_nonce++).toJson());
  }

  /// 通道中断的统一收口：对端关闭、错误、心跳判死都走这里，落 [ConnState.reconnecting] 并排期重试。
  void _onChannelLoss(String reason) {
    if (_manualClose || _disposed) return;
    aimiLog(AimiLogLevel.warn, 'conn', '连接中断（$reason）');
    _teardownChannel();
    // 每次链路中断都从 LAN 重新探测；LAN 恢复后才继续留在直连态。
    _retryStartedAt = _now();
    _preferLanOnNextRetry = true;
    state = ConnState.reconnecting;
    _ensureRetryLoop();
  }

  /// 拆掉当前通道相关的一切句柄；未决的 `session.create` 一律以 null 收口（断线=失败）。
  void _teardownChannel() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _pendingWelcome = null;
    final subscription = _sub;
    _sub = null;
    if (subscription != null) unawaited(subscription.cancel());
    final channel = _channel;
    _channel = null;
    if (channel != null) unawaited(channel.sink.close());
    for (final pending in _pendingCreates) {
      if (!pending.isCompleted) pending.complete(null);
    }
    _pendingCreates.clear();
    for (final pending in _pendingCommands.values) {
      if (!pending.isCompleted) pending.complete(null);
    }
    _pendingCommands.clear();
    for (final pending in _pendingDirectories.values) {
      if (!pending.isCompleted) pending.complete(null);
    }
    _pendingDirectories.clear();
    _supportsDynamicPermissions = false;
    _supportsDirectoryBrowsing = false;
    _supportsSessionFork = false;
    _agentCapabilities = const [];
  }

  /// 处理一条原始入帧：非文本、非法 JSON、非契约帧一律只记日志丢弃（防协议漂移的最内层）。
  void _onRaw(dynamic raw) {
    final receivedAt = metricsProvider.monotonicMs;
    if (raw is! String) {
      aimiLog(AimiLogLevel.debug, 'conn', '忽略非文本帧（${raw.runtimeType}）');
      return;
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      aimiLog(AimiLogLevel.debug, 'conn', '忽略非法 JSON 帧');
      return;
    }
    if (decoded is! Map<String, dynamic>) {
      aimiLog(AimiLogLevel.debug, 'conn', '忽略非对象帧');
      return;
    }
    final frame = ServerFrameParser.parse(decoded);
    if (frame == null) {
      aimiLog(AimiLogLevel.debug, 'conn', '忽略非契约帧 $decoded');
      return;
    }
    switch (frame) {
      case WelcomeFrameDto():
        final welcome = _pendingWelcome;
        _pendingWelcome = null;
        cache.upsertWelcome(frame.sessions);
        final agents = frame.agents ?? const <AgentCapabilityDto>[];
        _agentCapabilities = agents;
        _supportsDynamicPermissions =
            frame.features?['dynamicPermissions'] == true ||
            agents.any((agent) => agent.permissionModes != null);
        _supportsDirectoryBrowsing =
            frame.features?['directoryBrowsing'] == true;
        _supportsSessionFork = frame.features?['sessionFork'] == true;
        if (!_caps.isClosed) _caps.add(agents);
        if (welcome != null && !welcome.isCompleted) welcome.complete(frame);
      case SessionPermissionsFrameDto():
        cache.applyPermissions(frame);
      case PairedFrameDto():
        // 配对页消费 paired；常驻连接收到该帧时只保留解析能力，不重复写 token。
        aimiLog(
          AimiLogLevel.info,
          'conn',
          '收到 paired 帧（deviceId=${frame.deviceId}）',
        );
      case PongFrameDto():
        _missedPongs = 0;
      case ByeFrameDto():
        // server 主动终结（吊销/接管/停机）：记日志并把原因交给界面；
        // 重连仍由 onDone 的退避链接管（吊销后服务端会拒绝重连）。
        aimiLog(AimiLogLevel.warn, 'conn', 'server 结束连接：${frame.reason}');
        if (!_terminations.isClosed) _terminations.add(frame.reason);
        if (frame.reason == 'revoked') {
          unawaited(onRevoked?.call());
        }
      case SessionEventFrameDto():
        metricsContext.receive(frame, metricsProvider.monotonicMs - receivedAt);
        final applyStarted = metricsProvider.monotonicMs;
        final applied = cache.applyEvent(frame);
        metricsProvider.record(
          'client.connection.apply',
          metricsProvider.monotonicMs - applyStarted,
          context: metricsContext.frameContext(frame),
        );
        if (applied) {
          _events.add(frame);
        }
      case AckFrameDto():
        _completeCreate(frame.sessionId);
      case CommandAckFrameDto():
        // 命令生命周期节点②：ack（delivered=已投递 agent；rejected/duplicate 也是有效终态）。
        aimiLog(
          AimiLogLevel.info,
          'cmd',
          'session=${frame.sessionId} clientId=${frame.clientId} ack=${frame.status}'
              '${frame.code == null ? '' : ' code=${frame.code}'}',
        );
        final pending = _pendingCommands.remove(frame.clientId);
        if (pending != null && !pending.isCompleted) pending.complete(frame);
      case ErrorFrameDto():
        aimiLog(
          AimiLogLevel.error,
          'conn',
          'server 错误帧 ${frame.code}：${frame.message}',
        );
        _completeCreate(null);
      case UpdateInfoFrameDto():
        if (!_updates.isClosed) _updates.add(frame);
      case DirectoryResultFrameDto():
        final pending = _pendingDirectories.remove(frame.requestId);
        if (pending != null && !pending.isCompleted) pending.complete(frame);
    }
  }

  /// 按序收口最早一个未决的建会话请求（同时只会有一个在途）；[sessionId] 为 null 表示失败。
  void _completeCreate(String? sessionId) {
    if (_pendingCreates.isEmpty) return;
    final pending = _pendingCreates.removeAt(0);
    if (!pending.isCompleted) pending.complete(sessionId);
  }

  /// 发送一帧 JSON；通道未就绪时静默丢弃并记日志（返回 false 便于调用方收口）。
  bool _send(Map<String, dynamic> frame) {
    final channel = _channel;
    if (channel == null) {
      aimiLog(AimiLogLevel.debug, 'conn', '未连接，丢弃帧 ${frame['type']}');
      return false;
    }
    channel.sink.add(jsonEncode(frame));
    return true;
  }
}

Future<void> _defaultDelay(Duration wait) => Future<void>.delayed(wait);

/// 配对握手的结果：签发的设备 token 与服务端标识。
class PairingResult {
  /// @param token - 服务端签发的设备令牌（仅此一次下发）
  /// @param deviceId - 服务端登记的设备 id
  const PairingResult({required this.token, required this.deviceId});

  /// 设备令牌明文（存 secure_storage；服务端只留哈希）。
  final String token;

  /// 设备 id（审计与排障用）。
  final String deviceId;
}

/// 用 8 位配对码完成一次真实配对握手（手动配对路径）。
///
/// 与 [AimiConnection] 的区别：此时还没有 token，因此不复用连接实例，
/// 只借用同一套通道工厂与帧 DTO：连上 → `hello{pairingCode}` → 等 `paired{token, deviceId}`。
///
/// @param lanUrl - 电脑地址（如 `ws://127.0.0.1:8787` 或 `192.168.1.10:8787`）
/// @param pairingCode - 8 位配对码（服务端一次性核销、5 分钟有效）
/// @param deviceName - 本机显示名（服务端设备列表可见）
/// @param channelFactory - 通道工厂（生产为真实 WebSocket，测试可注入流对桩）
/// @param timeout - 建链 + 等待 paired 的总超时
/// @returns 签发结果；服务端拒绝或超时抛 [PairingException]
/// @throws PairingException - 地址非法、配对码过期/已用/无效、连接失败或超时
Future<PairingResult> pairWithCode({
  required String lanUrl,
  required String pairingCode,
  required String deviceName,
  required WebSocketChannel Function(Uri) channelFactory,
  Duration timeout = const Duration(seconds: 10),
}) async {
  final uri = _parseLanUrl(lanUrl);
  final code = pairingCode.trim();
  if (!RegExp(r'^\d{8}$').hasMatch(code)) {
    throw const PairingException(code: 'invalid_code', message: '配对码是 8 位数字');
  }
  final channel = channelFactory(uri);
  final paired = Completer<PairingResult>();
  StreamSubscription<dynamic>? subscription;
  try {
    subscription = channel.stream.listen(
      (raw) {
        if (raw is! String) return;
        final Object? decoded;
        try {
          decoded = jsonDecode(raw);
        } on FormatException {
          return;
        }
        if (decoded is! Map) return;
        final frame = ServerFrameParser.parse(decoded.cast<String, dynamic>());
        switch (frame) {
          case PairedFrameDto(:final token, :final deviceId):
            if (!paired.isCompleted) {
              paired.complete(PairingResult(token: token, deviceId: deviceId));
            }
          case ErrorFrameDto(:final code, :final message):
            if (!paired.isCompleted) {
              paired.completeError(
                PairingException(code: code, message: message),
              );
            }
          default:
            // paired 之前到达的其它帧（hello 回显/心跳）不参与配对判定。
            break;
        }
      },
      onError: (Object error) {
        if (!paired.isCompleted) {
          paired.completeError(
            PairingException(code: 'network', message: '$error'),
          );
        }
      },
      onDone: () {
        if (!paired.isCompleted) {
          paired.completeError(
            const PairingException(code: 'network', message: '连接已关闭'),
          );
        }
      },
    );
    await channel.ready.timeout(timeout);
    channel.sink.add(
      jsonEncode(
        ClientFrameDto.pair(
          pairingCode: code,
          deviceName: deviceName,
          permissionModes: kPhonePermissionModes,
        ).toJson(),
      ),
    );
    return await paired.future.timeout(timeout);
  } on TimeoutException {
    throw const PairingException(code: 'timeout', message: '配对超时：检查地址与配对码');
  } finally {
    await subscription?.cancel();
    await channel.sink.close();
  }
}

/// 解析用户输入的电脑地址：支持 `ws://host:port`、`wss://host:port` 与裸 `host:port`。
///
/// @throws PairingException - 缺主机或端口非法
Uri _parseLanUrl(String raw) {
  final text = raw.trim();
  if (text.isEmpty) {
    throw const PairingException(code: 'invalid_address', message: '先填电脑地址');
  }
  final withScheme = text.contains('://') ? text : 'ws://$text';
  final uri = Uri.tryParse(withScheme);
  if (uri == null || uri.host.isEmpty) {
    throw const PairingException(
      code: 'invalid_address',
      message: '地址形如 192.168.1.10:8787',
    );
  }
  final port = uri.hasPort ? uri.port : 8787;
  if (port <= 0 || port > 65535) {
    throw const PairingException(
      code: 'invalid_address',
      message: '地址形如 192.168.1.10:8787',
    );
  }
  final scheme = uri.scheme == 'wss' ? 'wss' : 'ws';
  // 服务端 WebSocket 端点是 /ws（与 AimiEndpoints.webSocketUri 一致）。
  return Uri(scheme: scheme, host: uri.host, port: port, path: '/ws');
}

/// 配对失败：携带服务端错误码与可直接展示的中文说明。
class PairingException implements Exception {
  /// @param code - 服务端错误码或本地分类（invalid_address/invalid_code/network/timeout）
  /// @param message - 可直接展示的说明
  const PairingException({required this.code, required this.message});

  /// 错误码。
  final String code;

  /// 展示文案。
  final String message;

  @override
  String toString() => 'PairingException($code): $message';
}
