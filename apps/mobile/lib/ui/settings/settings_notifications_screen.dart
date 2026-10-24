import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../data/notifications/notification_policy.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';
import 'settings_widgets.dart';

/// 通知分类二级页（原型 settings-notification.html）：五个分类开关。
///
/// 一级页只留「通知」入口；每类是否发系统通知在此决定
/// （notificationTogglesProvider 持久化）。分类口径：待审批/待回答/
/// 完成/失败/可能卡住（卡住默认关——提醒频次高，按需开启）。
class SettingsNotificationsScreen extends ConsumerWidget {
  /// 通知设置页（路由 `/settings/notifications`）。
  const SettingsNotificationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ai = context.ai;
    final tt = context.tt;
    final toggles = ref.watch(notificationTogglesProvider);

    return Scaffold(
      backgroundColor: ai.canvas,
      body: AimiPageBackground(
        child: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 6, 16, 8),
                child: Row(
                  children: [
                    AimiIconButton(
                      icon: AimiIcons.back,
                      semanticLabel: '返回设置',
                      // 新鲜栈打开时退不回去，落回一级页而不是空白。
                      onPressed: () =>
                          context.canPop() ? context.pop() : context.go('/settings'),
                      foreground: ai.ink2,
                    ),
                    Text('通知', style: tt.title),
                  ],
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                  children: [
                    SettingsGroup(
                      title: '分类',
                      rows: [
                        for (final kind in NotificationKind.values)
                          SettingsSwitchRow(
                            label: switch (kind) {
                              NotificationKind.approval => '待审批',
                              NotificationKind.question => '待回答',
                              NotificationKind.finished => '完成',
                              NotificationKind.failed => '失败',
                              NotificationKind.stalled => '可能卡住',
                            },
                            value: toggles[kind] ?? false,
                            onChanged: (value) => ref
                                .read(notificationTogglesProvider.notifier)
                                .setEnabled(kind, value),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
