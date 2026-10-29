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

  test('finished 为会话首事件（分叉就绪广播）不通知；常规完成照常', () {
    final policy = NotificationPolicy(enabled: {
      NotificationKind.approval: true,
      NotificationKind.question: true,
      NotificationKind.finished: true,
      NotificationKind.failed: true,
      NotificationKind.stalled: true,
    });
    const finished = AgentEventDto(type: 'state', state: 'finished');

    // 分叉延迟启动的「就绪」广播是该会话第一条事件——不是完成的回合。
    expect(
      policy.derive('s1', '标题', finished, sessionEventCount: 1),
      isNull,
    );
    // 真实回合完成：至少有 starting + finished 两条事件。
    expect(
      policy.derive('s2', '标题', finished, sessionEventCount: 2),
      isNotNull,
    );
    // 缺省计数（=2）保持旧行为，既有调用方不受影响。
    expect(policy.derive('s3', '标题', finished), isNotNull);
  });
}
