import 'package:aimi/data/notifications/notification_policy.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:flutter_test/flutter_test.dart';

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
}
