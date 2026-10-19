import '../protocol/frame_dto.dart';

enum NotificationKind { approval, question, finished, failed, stalled }

class LocalNotificationIntent {
  const LocalNotificationIntent({
    required this.kind,
    required this.sessionId,
    required this.title,
    required this.body,
  });
  final NotificationKind kind;
  final String sessionId;
  final String title;
  final String body;
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
    );
  }
}
