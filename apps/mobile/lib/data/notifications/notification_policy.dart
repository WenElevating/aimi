import '../protocol/frame_dto.dart';

enum NotificationKind { approval, question, finished, failed, stalled }

/// 通知点击或审批操作的稳定动作名；平台层只传递这些字符串，不携带令牌。
enum NotificationAction { open, approve, reject }

/// 通知 action 传给平台层的最小载荷，并提供统一的会话深链。
class NotificationActionPayload {
  const NotificationActionPayload({
    required this.action,
    required this.sessionId,
    this.requestId,
  });

  final NotificationAction action;
  final String sessionId;
  final String? requestId;

  /// go_router 可直接消费的会话路径。
  String get deepLink => '/session/${Uri.encodeComponent(sessionId)}';

  Map<String, String> toJson() => {
    'action': action.name,
    'sessionId': sessionId,
    'deepLink': deepLink,
    ...?requestId == null ? null : {'requestId': requestId!},
  };

  /// 平台回调只接受白名单动作和非空会话 id，非法载荷静默丢弃。
  static NotificationActionPayload? fromJson(Map<String, dynamic> json) {
    final sessionId = json['sessionId'];
    final actionName = json['action'];
    if (sessionId is! String || sessionId.isEmpty || actionName is! String) {
      return null;
    }
    final action = switch (actionName) {
      'open' => NotificationAction.open,
      'approve' => NotificationAction.approve,
      'reject' => NotificationAction.reject,
      _ => null,
    };
    if (action == null) return null;
    final requestId = json['requestId'];
    if ((action == NotificationAction.approve ||
            action == NotificationAction.reject) &&
        (requestId is! String || requestId.isEmpty)) {
      return null;
    }
    final deepLink = json['deepLink'];
    final expected = '/session/${Uri.encodeComponent(sessionId)}';
    if (deepLink case final String value when value != expected) return null;
    return NotificationActionPayload(
      action: action,
      sessionId: sessionId,
      requestId: requestId is String ? requestId : null,
    );
  }
}

class LocalNotificationIntent {
  const LocalNotificationIntent({
    required this.kind,
    required this.sessionId,
    required this.title,
    required this.body,
    required this.actions,
    this.requestId,
  });
  final NotificationKind kind;
  final String sessionId;
  final String title;
  final String body;
  final List<NotificationAction> actions;
  final String? requestId;

  /// 通知点击默认进入会话页；审批通知额外暴露批准/拒绝 action。
  NotificationActionPayload payloadFor(NotificationAction action) {
    if (!actions.contains(action)) {
      throw ArgumentError.value(action, 'action', '该通知不支持此 action');
    }
    return NotificationActionPayload(
      action: action,
      sessionId: sessionId,
      requestId: requestId,
    );
  }
}

/// 将事件映射为本地通知意图；真正的平台发布由 FGS bridge 负责。
class NotificationPolicy {
  NotificationPolicy({Map<NotificationKind, bool>? enabled})
    : _enabled = {
        NotificationKind.approval: true,
        NotificationKind.question: true,
        NotificationKind.finished: true,
        NotificationKind.failed: true,
        NotificationKind.stalled: false,
        ...?enabled,
      };

  final Map<NotificationKind, bool> _enabled;
  final Set<String> _seen = <String>{};

  void setEnabled(NotificationKind kind, bool value) => _enabled[kind] = value;

  LocalNotificationIntent? derive(
    String sessionId,
    String sessionTitle,
    AgentEventDto event,
  ) {
    final kind = switch (event.type) {
      'permission' => NotificationKind.approval,
      'question' => NotificationKind.question,
      'notice' when event.text?.contains('stalled') == true =>
        NotificationKind.stalled,
      'state' when event.state == 'finished' => NotificationKind.finished,
      'state' when event.state == 'failed' => NotificationKind.failed,
      _ => null,
    };
    if (kind == null || _enabled[kind] != true) return null;
    final key =
        '$sessionId:${event.type}:${event.id ?? event.state ?? event.text ?? ''}';
    if (!_seen.add(key)) return null;
    return LocalNotificationIntent(
      kind: kind,
      sessionId: sessionId,
      title: sessionTitle,
      body:
          event.title ??
          event.prompt ??
          event.text ??
          (event.state == 'finished' ? '已完成' : '已失败'),
      actions: kind == NotificationKind.approval
          ? const [NotificationAction.approve, NotificationAction.reject]
          : const [NotificationAction.open],
      requestId: kind == NotificationKind.approval ? event.id : null,
    );
  }
}
