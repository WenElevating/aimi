import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../cache/session_cache.dart';
import '../protocol/frame_dto.dart';

/// 连接状态。当前版本只有局域网直连一条链路，中继链路与「在线/中继」的细分尚未接入。
enum ConnState {
  /// 未连接（初始态，或用户主动断开）。
  offline,

  /// 断开中：已按退避排期下一次尝试。
  reconnecting,

  /// 已建立 LAN 直连且完成握手。
  onlineLan,
}

/// 手机连接服务端所需的三要素（主机、端口、令牌），由用户在设置页填写并存入设备安全存储。
class AimiEndpoints {
  const AimiEndpoints({
    required this.host,
    required this.port,
    required this.token,
  });

  /// 服务端的局域网主机，可填 IP 或主机名；由用户在设置页手填。
  final String host;

  /// server 的 LAN 端口。
  final int port;

  /// 设备 token（配对时签发；仅存手机 secure_storage）。
  final String token;

  /// 手机发往服务端的 WebSocket 地址；局域网内直连使用明文 `ws`，加密传输尚未接入。
  Uri get webSocketUri =>
      Uri(scheme: 'ws', host: host, port: port, path: '/ws');
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
    Duration createTimeout = const Duration(seconds: 5),
    Random? random,
  })  : _channelFactory = channelFactory,
        _delay = delay,
        _pingPeriod = pingPeriod,
        _connectTimeout = connectTimeout,
        _createTimeout = createTimeout,
        _random = random ?? Random(),
        super(ConnState.offline);

  /// 首次重连退避基数（1s）。断开后的前期以 1s、2s 的短间隔积极重试。
  static const Duration baseBackoff = Duration(seconds: 1);

  /// 退避上限（30s）：失败无限重试，但间隔不再增长，避免长期离线时脉冲风暴。
  static const Duration maxBackoff = Duration(seconds: 30);

  /// 退避抖动上限（ms）：多设备/多会话避免同拍重连（上限有界，可断言）。
  static const int backoffJitterMillis = 250;

  /// 退避的最大位移次数（1s<<5 = 32s 已超上限，再多算会溢出）。
  static const int _maxBackoffShift = 5;

  /// 连接三要素。
  final AimiEndpoints endpoints;

  /// 服务端状态的本地镜像（welcome 元数据 + 事件流）。
  final SessionCache cache;

  final WebSocketChannel Function(Uri) _channelFactory;
  final Future<void> Function(Duration) _delay;
  final Duration _pingPeriod;
  final Duration _connectTimeout;
  final Duration _createTimeout;
  final Random _random;

  final StreamController<SessionEventFrameDto> _events =
      StreamController<SessionEventFrameDto>.broadcast();

  /// 待回执的建会话请求；按发送顺序与回执一一配对，同时只会有一个在途。
  final List<Completer<String?>> _pendingCreates = <Completer<String?>>[];

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

  /// 事件流转发：**已写入 cache** 后才发出（订阅者与镜像看到同一序列）。
  Stream<SessionEventFrameDto> get events => _events.stream;

  /// 建立连接：成功进 [ConnState.onlineLan]，失败进 [ConnState.reconnecting] 并按退避自动重试。
  ///
  /// 该方法只等待「本次尝试」的结果，不等待整条重连链——故永久失败时也会及时返回。
  Future<void> connect() async {
    _manualClose = false;
    _retryAttempt = 0;
    final ok = await _attemptOnce();
    if (!ok && !_manualClose && !_disposed) {
      state = ConnState.reconnecting;
      _ensureRetryLoop();
    }
  }

  /// 主动断开：停止重连与心跳，关闭通道并落 [ConnState.offline]。
  Future<void> disconnect() async {
    _manualClose = true;
    _retryAttempt = 0;
    _teardownChannel();
    state = ConnState.offline;
  }

  /// 发 `session.create` 并等 ack：拿到 sessionId 返回它；server 回 error 帧或超时返回 null。
  ///
  /// 未在线时直接返回 null，不排队等待；离线期间新建的会话不会在恢复连接后补发。
  Future<String?> createSession(SessionSpecDto spec) async {
    if (state != ConnState.onlineLan) return null;
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
      debugPrint('aimi: session.create 等待 ack 超时（${_createTimeout.inSeconds}s）');
      return null;
    }
  }

  /// 发 `session.command`；`clientId` 由调用方生成（uuid），server 侧据此做幂等去重。
  Future<void> sendCommand(
    String sessionId,
    String clientId,
    AgentCommandDto cmd,
  ) async {
    _send(
      ClientFrameDto.sessionCommand(
        sessionId: sessionId,
        clientId: clientId,
        cmd: cmd,
      ).toJson(),
    );
  }

  @override
  void dispose() {
    _disposed = true;
    _manualClose = true;
    _teardownChannel();
    unawaited(_events.close());
    super.dispose();
  }

  /// 单次连接尝试：建通道 → hello → 等 welcome（入 cache）。
  Future<bool> _attemptOnce() async {
    _teardownChannel();
    final welcome = Completer<WelcomeFrameDto>();
    _pendingWelcome = welcome;

    try {
      // 工厂自身可能同步抛错（端口未开/被拒），必须留在 try 内以便统一收口为重连。
      final channel = _channelFactory(endpoints.webSocketUri);
      _channel = channel;
      _sub = channel.stream.listen(
        _onRaw,
        onError: (Object error) => _onChannelLoss('socket error: $error'),
        onDone: () => _onChannelLoss('socket closed'),
      );

      await channel.ready.timeout(_connectTimeout);
      _send(ClientFrameDto.hello(token: endpoints.token).toJson());
      await welcome.future.timeout(_connectTimeout);
      if (_manualClose || _disposed) return false;
      state = ConnState.onlineLan;
      _missedPongs = 0;
      _startHeartbeat();
      return true;
    } on Object catch (error) {
      debugPrint('aimi: 连接尝试失败：$error');
      _teardownChannel();
      return false;
    }
  }

  /// 退避重连链：每次失败后按 [_backoffFor] 等待再试，直到成功或主动断开。
  Future<void> _retryLoop() async {
    while (!_manualClose && !_disposed) {
      await _delay(_backoffFor(_retryAttempt++));
      if (_manualClose || _disposed) return;
      if (await _attemptOnce()) return;
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

  /// 第 [attempt] 次重连的等待时长：`min(1s << attempt, 30s)` + 0..[_backoffJitterMillis] 抖动。
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

  /// 通道中断（对端关闭/错误/心跳判死）的统一收口：拆通道 → reconnecting → 退避重连。
  void _onChannelLoss(String reason) {
    if (_manualClose || _disposed) return;
    debugPrint('aimi: 连接中断（$reason）');
    _teardownChannel();
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
  }

  /// 单帧入口：JSON 文本 → 契约解析 → 分发。非契约帧只记日志（防协议漂移的最内层）。
  void _onRaw(dynamic raw) {
    if (raw is! String) {
      debugPrint('aimi: 忽略非文本帧（${raw.runtimeType}）');
      return;
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      debugPrint('aimi: 忽略非法 JSON 帧');
      return;
    }
    if (decoded is! Map<String, dynamic>) {
      debugPrint('aimi: 忽略非对象帧');
      return;
    }
    final frame = ServerFrameParser.parse(decoded);
    if (frame == null) {
      debugPrint('aimi: 忽略非契约帧 $decoded');
      return;
    }
    switch (frame) {
      case WelcomeFrameDto():
        final welcome = _pendingWelcome;
        _pendingWelcome = null;
        cache.applyWelcome(frame.sessions);
        if (welcome != null && !welcome.isCompleted) welcome.complete(frame);
      case PongFrameDto():
        _missedPongs = 0;
      case ByeFrameDto():
        // server 主动终结（吊销/接管/停机）：只记日志，重连仍由 onDone 的退避链接管。
        debugPrint('aimi: server 结束连接：${frame.reason}');
      case SessionEventFrameDto():
        if (cache.applyEvent(frame)) {
          _events.add(frame);
        }
      case AckFrameDto():
        _completeCreate(frame.sessionId);
      case ErrorFrameDto():
        debugPrint('aimi: server 错误帧 ${frame.code}：${frame.message}');
        _completeCreate(null);
    }
  }

  /// 按序收口最早一个未决的建会话请求（同时只会有一个在途）。
  void _completeCreate(String? sessionId) {
    if (_pendingCreates.isEmpty) return;
    final pending = _pendingCreates.removeAt(0);
    if (!pending.isCompleted) pending.complete(sessionId);
  }

  /// 发送一帧；通道未就绪时静默丢弃并记日志（返回 false 便于调用方收口）。
  bool _send(Map<String, dynamic> frame) {
    final channel = _channel;
    if (channel == null) {
      debugPrint('aimi: 未连接，丢弃帧 ${frame['type']}');
      return false;
    }
    channel.sink.add(jsonEncode(frame));
    return true;
  }
}

Future<void> _defaultDelay(Duration wait) => Future<void>.delayed(wait);
