import 'package:aimi/ui/widgets/state_badge.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 会话的七种合法状态。
const _sessionStates = [
  'starting',
  'running',
  'waiting_approval',
  'waiting_input',
  'finished',
  'failed',
  'stopped',
];

void main() {
  test('badgeFor：七种会话状态各有文案/颜色（starting 灰、running 绿、waiting_approval 红、'
      'waiting_input 橙、finished 蓝、failed 深红、stopped 灰暗）', () {
    expect(badgeFor('starting').label, '启动中');
    expect(badgeFor('running').label, '运行中');
    expect(badgeFor('waiting_approval').label, '等待审批');
    expect(badgeFor('waiting_input').label, '等待回答');
    expect(badgeFor('finished').label, '已完成');
    expect(badgeFor('failed').label, '已失败');
    expect(badgeFor('stopped').label, '已停止');

    expect(badgeFor('starting').color, Colors.grey);
    expect(badgeFor('running').color, Colors.green);
    expect(badgeFor('waiting_approval').color, Colors.red);
    expect(badgeFor('waiting_input').color, Colors.orange);
    expect(badgeFor('finished').color, Colors.blue);
    expect(badgeFor('failed').color, Colors.red.shade900);
    expect(badgeFor('stopped').color, Colors.blueGrey.shade700);

    // 七态文案互不相同（否则看板无法区分）。
    expect(
      _sessionStates.map((s) => badgeFor(s).label).toSet(),
      hasLength(_sessionStates.length),
    );
    // 两个「等待」态必须是两种颜色、两种文案（当前无交互，只能靠颜色区分）。
    expect(badgeFor('waiting_approval').color, isNot(badgeFor('waiting_input').color));
    // failed 与 waiting_approval 同族但更深，避免误读为「可审批」。
    expect(badgeFor('failed').color, isNot(badgeFor('waiting_approval').color));
  });

  test('badgeFor：三种连接状态映射为 LAN/重连中/离线', () {
    expect(badgeFor('onlineLan').label, 'LAN');
    expect(badgeFor('onlineLan').color, Colors.green);
    expect(badgeFor('reconnecting').label, '重连中');
    expect(badgeFor('reconnecting').color, Colors.orange);
    expect(badgeFor('offline').label, '离线');
    expect(badgeFor('offline').color, Colors.grey);
  });

  test('badgeFor：未知取值原样回显（不静默吞掉协议新增值），颜色回落中性灰', () {
    expect(badgeFor('paused').label, 'paused');
    expect(badgeFor('paused').color, Colors.grey);
  });

  testWidgets('StateBadge：渲染圆点 + 文案，颜色取自 badgeFor', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: StateBadge(state: 'running'))),
    );
    expect(find.byType(StateBadge), findsOneWidget);
    expect(find.text('运行中'), findsOneWidget);

    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: StateBadge(state: 'onlineLan'))),
    );
    expect(find.text('LAN'), findsOneWidget);
    expect(find.text('运行中'), findsNothing);
  });
}
