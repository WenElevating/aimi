import 'package:flutter/material.dart';

import '../../data/connection/aimi_connection.dart';

/// 徽标外观：文案 + 颜色（纯数据，便于单测直接断言映射表）。
@immutable
class BadgeSpec {
  /// 指定徽标文案与颜色（通常由 [badgeFor] 产出，测试也直接构造）。
  const BadgeSpec({required this.label, required this.color});

  /// 展示文案；未知状态时原样回显协议值
  final String label;

  /// 圆点与文字的强调色；未知状态回落中性灰
  final Color color;

  @override
  bool operator ==(Object other) =>
      other is BadgeSpec && other.label == label && other.color == color;

  @override
  int get hashCode => Object.hash(label, color);
}

/// 会话七态（协议 state 取值域）+ 连接三态的徽标映射。
///
/// 配色：starting 灰 / running 绿 / waiting_approval 红 / waiting_input 橙 /
/// finished 蓝 / failed 深红 / stopped 灰暗；连接态 `onlineLan` 绿「LAN」、
/// `reconnecting` 橙「重连中」、`offline` 灰「离线」。
///
/// 未知取值**原样回显**（与 `stateLabel` 同一原则：协议新增值不静默吞掉），颜色回落中性灰。
BadgeSpec badgeFor(String state) => switch (state) {
      'starting' => const BadgeSpec(label: '启动中', color: Colors.grey),
      'running' => const BadgeSpec(label: '运行中', color: Colors.green),
      'waiting_approval' => const BadgeSpec(label: '等待审批', color: Colors.red),
      'waiting_input' => const BadgeSpec(label: '等待回答', color: Colors.orange),
      'finished' => const BadgeSpec(label: '已完成', color: Colors.blue),
      'failed' => BadgeSpec(label: '已失败', color: Colors.red.shade900),
      'stopped' => BadgeSpec(label: '已停止', color: Colors.blueGrey.shade700),
      'onlineLan' => const BadgeSpec(label: 'LAN', color: Colors.green),
      'reconnecting' => const BadgeSpec(label: '重连中', color: Colors.orange),
      'offline' => const BadgeSpec(label: '离线', color: Colors.grey),
      _ => BadgeSpec(label: state, color: Colors.grey),
    };

/// 连接状态的徽标入口；内部按 `ConnState.name` 复用 [badgeFor]，避免调用侧手写字符串。
BadgeSpec badgeForConn(ConnState conn) => badgeFor(conn.name);

/// 状态徽标：圆点 + 文案（会话状态与连接状态共用同一张映射表）。
class StateBadge extends StatelessWidget {
  /// [state] 为协议状态字符串（会话态七值或 `ConnState.name` 三值）。
  const StateBadge({super.key, required this.state, this.compact = false});
  /// 原始状态值：会话态七值或连接态三值；取值域外的值原样回显
  final String state;

  /// 紧凑模式：只显示圆点与更小字号（用于看板卡右侧）
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final spec = badgeFor(state);
    final fontSize = compact ? 11.0 : 13.0;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: compact ? 7 : 9,
          height: compact ? 7 : 9,
          decoration: BoxDecoration(color: spec.color, shape: BoxShape.circle),
        ),
        SizedBox(width: compact ? 4 : 6),
        Text(
          spec.label,
          style: TextStyle(
            fontSize: fontSize,
            color: spec.color,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}
