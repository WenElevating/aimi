import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../connection/aimi_connection.dart';
import '../protocol/frame_dto.dart';
import 'notification_policy.dart';

/// 允许通知层向应用导航或发审批命令的回调。
typedef NotificationNavigate = void Function(String location);
typedef NotificationApprove = Future<void> Function(
  String sessionId,
  String requestId,
  String decision,
);

/// 本地通知的 Android channel 与 action 标识。
abstract final class AimiNotificationIds {
  static const eventChannel = 'aimi.events';
  static const approvalChannel = 'aimi.approvals';
  static const approveAction = 'approve';
  static const rejectAction = 'reject';
}

/// 将通知事件发布到系统，并把点击/action 回调还原为安全的应用动作。
class LocalNotificationService {
  LocalNotificationService({FlutterLocalNotificationsPlugin? plugin})
    : _plugin = plugin ?? FlutterLocalNotificationsPlugin();

  final FlutterLocalNotificationsPlugin _plugin;
  NotificationNavigate? _navigate;
  NotificationApprove? _approve;
  final List<NotificationResponse> _pendingResponses = <NotificationResponse>[];
  bool _initialized = false;

  /// 初始化插件并请求 Android 13+ 的通知权限；其它平台保持 no-op。
  Future<void> initialize() async {
    if (_initialized || kIsWeb || !Platform.isAndroid) {
      return;
    }
    const settings = InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
    );
    await _plugin.initialize(settings, onDidReceiveNotificationResponse: _onResponse);
    await _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.requestNotificationsPermission();
    _initialized = true;
    final launch = await _plugin.getNotificationAppLaunchDetails();
    final response = launch?.notificationResponse;
    if (launch?.didNotificationLaunchApp == true && response != null) {
      _pendingResponses.add(response);
      _flushPendingResponses();
    }
  }

  /// 绑定应用路由与连接命令入口；绑定前到达的冷启动 action 会在此处补发。
  void bind({required NotificationNavigate navigate, required NotificationApprove approve}) {
    _navigate = navigate;
    _approve = approve;
    _flushPendingResponses();
  }

  /// 从事件意图创建 Android 通知，并在审批通知上附加批准/拒绝 action。
  Future<void> show(LocalNotificationIntent intent) async {
    if (!_initialized) return;
    final actions = <AndroidNotificationAction>[
      if (intent.actions.contains(NotificationAction.approve))
        const AndroidNotificationAction(
          AimiNotificationIds.approveAction,
          '批准',
          showsUserInterface: true,
        ),
      if (intent.actions.contains(NotificationAction.reject))
        const AndroidNotificationAction(
          AimiNotificationIds.rejectAction,
          '拒绝',
          showsUserInterface: true,
        ),
    ];
    final channelId = intent.kind == NotificationKind.approval
        ? AimiNotificationIds.approvalChannel
        : AimiNotificationIds.eventChannel;
    final details = NotificationDetails(
      android: AndroidNotificationDetails(
        channelId,
        intent.kind == NotificationKind.approval ? '审批请求' : '会话事件',
        channelDescription: 'aimi 会话状态通知',
        importance: Importance.high,
        priority: Priority.high,
        actions: actions,
      ),
    );
    final payload = NotificationActionPayload(
      action: NotificationAction.open,
      sessionId: intent.sessionId,
      requestId: intent.requestId,
    ).toJson();
    await _plugin.show(
      _notificationId(intent),
      intent.title,
      intent.body,
      details,
      payload: jsonEncode(payload),
    );
  }

  /// 处理普通点击和 Android action；非法/重复载荷直接丢弃。
  Future<void> dispatchResponse(NotificationResponse response) async {
    final raw = response.payload;
    if (raw == null || raw.isEmpty) return;
    final decoded = jsonDecode(raw);
    if (decoded is! Map) return;
    final actionId = response.actionId;
    final json = <String, dynamic>{
      ...decoded.cast<String, dynamic>(),
      if (actionId != null && actionId.isNotEmpty) 'action': actionId,
    };
    final payload = NotificationActionPayload.fromJson(json);
    if (payload == null) return;
    _navigate?.call(payload.deepLink);
    if (payload.action == NotificationAction.open) return;
    final requestId = payload.requestId;
    final approve = _approve;
    if (requestId == null || approve == null) return;
    await approve(
      payload.sessionId,
      requestId,
      payload.action == NotificationAction.approve ? 'once' : 'reject',
    );
  }

  void _onResponse(NotificationResponse response) {
    if (_navigate == null || _approve == null) {
      _pendingResponses.add(response);
      return;
    }
    unawaited(dispatchResponse(response));
  }

  void _flushPendingResponses() {
    if (_navigate == null || _approve == null) return;
    final responses = List<NotificationResponse>.from(_pendingResponses);
    _pendingResponses.clear();
    for (final response in responses) {
      unawaited(dispatchResponse(response));
    }
  }

  static int _notificationId(LocalNotificationIntent intent) {
    var hash = 17;
    for (final codeUnit in '${intent.sessionId}:${intent.kind.name}'.codeUnits) {
      hash = (hash * 31 + codeUnit) & 0x7fffffff;
    }
    return hash;
  }
}

/// 监听连接事件，按策略派生通知并避免重复发布。
class NotificationEventCoordinator {
  NotificationEventCoordinator({
    required this.connection,
    required this.policy,
    required this.service,
    required this.sessionTitle,
  });

  final AimiConnection connection;
  final NotificationPolicy policy;
  final LocalNotificationService service;
  final String Function(String sessionId) sessionTitle;
  StreamSubscription<SessionEventFrameDto>? _subscription;

  void start() {
    _subscription ??= connection.events.listen((frame) {
      final intent = policy.derive(
        frame.sessionId,
        sessionTitle(frame.sessionId),
        frame.agentEvent,
        // 事件先写镜像后发此流（连接层契约），计数即含当前帧。
        sessionEventCount: connection.cache.eventsFor(frame.sessionId).length,
      );
      if (intent != null) unawaited(service.show(intent));
    });
  }

  Future<void> dispose() async {
    await _subscription?.cancel();
    _subscription = null;
  }
}
