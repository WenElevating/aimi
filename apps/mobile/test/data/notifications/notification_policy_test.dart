import 'package:aimi/data/notifications/notification_policy.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:aimi/app/router.dart';

void main() {
  test('notification policy defaults, de-duplicates, and respects toggles', () {
    final policy = NotificationPolicy();
    final approval = AgentEventDto(type: 'permission', id: 'p1', title: '允许写入');
    expect(
      policy.derive('s1', '任务', approval)?.kind,
      NotificationKind.approval,
    );
    expect(policy.derive('s1', '任务', approval), isNull);
    policy.setEnabled(NotificationKind.approval, false);
    expect(policy.derive('s2', '任务', approval), isNull);
  });

  test(
    'approval intent exposes stable actions and a tamper-resistant deep link',
    () {
      final intent = NotificationPolicy().derive(
        'session/1',
        '任务',
        AgentEventDto(type: 'permission', id: 'p1', title: '允许写入'),
      )!;
      expect(intent.actions, [
        NotificationAction.approve,
        NotificationAction.reject,
      ]);
      final payload = intent.payloadFor(NotificationAction.approve);
      expect(payload.toJson(), {
        'action': 'approve',
        'sessionId': 'session/1',
        'deepLink': '/session/session%2F1',
        'requestId': 'p1',
      });
      expect(
        AimiDeepLink.fromNotification(payload.toJson()),
        '/session/session%2F1',
      );
      expect(
        AimiDeepLink.fromNotification({
          ...payload.toJson(),
          'deepLink': '/settings',
        }),
        isNull,
      );
    },
  );

  test('non-approval intent only allows opening the session', () {
    final intent = NotificationPolicy().derive(
      's1',
      '任务',
      AgentEventDto(type: 'state', state: 'finished'),
    )!;
    expect(intent.actions, [NotificationAction.open]);
    expect(
      () => intent.payloadFor(NotificationAction.approve),
      throwsArgumentError,
    );
  });

  test('deep link parser rejects non-session routes and empty ids', () {
    expect(AimiDeepLink.sessionId(Uri.parse('/session/s1')), 's1');
    expect(AimiDeepLink.sessionId(Uri.parse('/settings')), isNull);
    expect(AimiDeepLink.sessionId(Uri.parse('/session/')), isNull);
    expect(NotificationActionPayload.fromJson({'action': 'open'}), isNull);
  });
}
