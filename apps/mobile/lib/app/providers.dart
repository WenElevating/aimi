import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../data/cache/session_cache.dart';
import '../data/connection/aimi_connection.dart';
import '../data/protocol/frame_dto.dart';

/// 接线层：界面与数据层之间的唯一入口。
///
/// 依赖方向：本文件是 `ui → app → data/domain` 的汇聚点；`ui/` 允许 import 本文件、
/// `data/connection` 的连接接口（`AimiConnection`/`ConnState`）与协议 DTO，
/// 但不直接 import 数据层实现细节——WebSocket 通道与镜像实现在本层装配。
///
/// 当前只做「能用、清晰」的接线，不做视觉终态；视觉细化另行安排。

/// 安全存储中主机键的键名；值为用户手填的 IP 或主机名，配对功能接入后沿用同一组键。
const String hostStorageKey = 'aimi.host';

/// 安全存储中端口键的键名；值以十进制字符串存放，解析失败按未配置处理。
const String portStorageKey = 'aimi.port';

/// 安全存储中令牌键的键名；配对时签发，只写设备安全存储。
const String tokenStorageKey = 'aimi.token';

/// 安全存储单例：令牌只写入设备安全存储，不落普通偏好设置或数据库。
final secureStorageProvider = Provider<FlutterSecureStorage>(
  (ref) => const FlutterSecureStorage(),
);

/// 连接三要素：从 secure_storage 异步读出；缺项或非法（端口不是数字）时值为 null（未配置）。
///
/// 取不出值（未配置、或平台插件不可用——单测/桌面）一律回落 null，让 UI 走引导态而非崩溃。
/// 设置页保存后 `ref.invalidate(endpointsProvider)` 即可触发重新读取与重连。
final endpointsProvider = FutureProvider<AimiEndpoints?>((ref) async {
  final storage = ref.watch(secureStorageProvider);
  try {
    final host = (await storage.read(key: hostStorageKey))?.trim() ?? '';
    final portText = (await storage.read(key: portStorageKey))?.trim() ?? '';
    final token = (await storage.read(key: tokenStorageKey))?.trim() ?? '';
    final port = int.tryParse(portText);
    if (host.isEmpty || token.isEmpty || port == null) return null;
    if (port <= 0 || port > 65535) return null;
    return AimiEndpoints(host: host, port: port, token: token);
  } on Object catch (error) {
    debugPrint('aimi: 读取 secure_storage 失败（按未配置处理）：$error');
    return null;
  }
});

/// 全局会话镜像单例：当前为内存实现，应用退出即清空；改为持久化时这里只替换实现类。
final cacheProvider = Provider<SessionCache>((ref) => SessionCache());

/// 全局单连接：endpoints 就绪才构建；endpoints 变更（设置页保存）会 dispose 旧实例并新建实例。
///
/// `channelFactory` 注入真实 `WebSocketChannel.connect`（连接层只依赖抽象，测试侧用流对桩）。
/// 非 autoDispose：连接是应用级资源，不随临时离开看板而断开。
final connectionProvider = Provider<AimiConnection?>((ref) {
  final endpoints = ref.watch(endpointsProvider).value;
  if (endpoints == null) return null;
  final connection = AimiConnection(
    endpoints: endpoints,
    cache: ref.watch(cacheProvider),
    channelFactory: WebSocketChannel.connect,
  );
  ref.onDispose(connection.dispose);
  return connection;
});

/// 镜像版本号：`SessionCache` 不提供变更通知流，故用「事件帧 + 连接状态」
/// 合成一个自增 tick——UI `watch` 它即可在数据变化后重读 cache 的同步快照。
///
/// 细节：`AimiConnection.events` 是 broadcast 流，`connection.stream`（[StateNotifier]）在订阅时会
/// 同步补发当前状态；用一个**异步** `StreamController` 承接，避免在 widget build 期间同步
/// 修改 provider 状态（Riverpod 会断言）。自增 int 而非 void：`AsyncData<void>` 的前后值相等
/// 会被 Riverpod 判为「无变化」，tick 就会丢。
final cacheTicksProvider = StreamProvider<int>((ref) {
  final connection = ref.watch(connectionProvider);
  if (connection == null) return const Stream<int>.empty();

  final controller = StreamController<int>();
  var tick = 0;
  void bump() => controller.add(++tick);

  final subscriptions = <StreamSubscription<Object?>>[
    connection.events.listen((_) => bump()),
    connection.stream.listen((_) => bump()),
  ];
  // 订阅时补一拍：覆盖「订阅前已完成握手/已有事件」的情形（welcome 不产生事件帧）。
  bump();

  ref.onDispose(() {
    for (final subscription in subscriptions) {
      unawaited(subscription.cancel());
    }
    unawaited(controller.close());
  });
  return controller.stream;
});

/// 当前连接状态（`reconnecting` 常驻提示条与设置页徽标都读它）。
///
/// 连接状态由 [StateNotifier] 持有，其 `state` 对外不可读，故只能经
/// `connection.stream` 观察。`StateNotifier.stream` 在**订阅时同步补发**当前状态，直接交给
/// Riverpod 会在 widget build 期间修改 provider 状态（调试断言）；[connectionStates] 用
/// `async*` 包装，把交付推迟到微任务后。
final connStateProvider = StreamProvider<ConnState>((ref) {
  final connection = ref.watch(connectionProvider);
  if (connection == null) return Stream<ConnState>.value(ConnState.offline);
  return connectionStates(connection);
});

/// 把连接状态的同步补发推迟到微任务后，避免在 widget build 期间修改 provider 状态而触发断言。
Stream<ConnState> connectionStates(AimiConnection connection) async* {
  yield* connection.stream;
}

/// 看板会话列表（按 `updatedAt` 降序，同刻按 id 稳定）。
final sessionsProvider = Provider<List<SessionMetaDto>>((ref) {
  ref.watch(cacheTicksProvider);
  return ref.watch(cacheProvider).sessionsSnapshot();
});

/// 某会话已入镜像的归一化事件（seq 升序）：`dashboardSubtitle`/`timelineOf` 的输入。
final sessionEventsProvider = Provider.family<List<AgentEventDto>, String>(
  (ref, sessionId) {
    ref.watch(cacheTicksProvider);
    final frames = ref.watch(cacheProvider).eventsFor(sessionId);
    return [for (final frame in frames) frame.agentEvent];
  },
);

/// 自启动接线：endpoints 就绪即 `connect()`；`main.dart` watch 它，使连接不依赖某个页面是否在栈顶。
///
/// 只在**新建连接实例**时连一次：`connect()` 非重入，重连一律走
/// 设置页的 `disconnect()` → `connect()`，避免对同一实例重复 connect 叠加两条重连链。
final connectionBootstrapProvider = Provider<AimiConnection?>((ref) {
  final connection = ref.watch(connectionProvider);
  if (connection != null) unawaited(connection.connect());
  return connection;
});
