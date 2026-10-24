import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../data/notifications/foreground_service.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';
import 'settings_widgets.dart';

/// 后台保活二级页（原型 settings-background.html）：常驻运行 + 电池优化。
///
/// 一级页只留「后台」入口；前台服务开关在这里控制（配对后生效——
/// 服务需要服务器端点才 meaningful），电池优化跳系统设置的动作
/// 在无系统直达时给出明确提示。
class SettingsBackgroundScreen extends ConsumerStatefulWidget {
  /// 后台设置页（路由 `/settings/background`）。
  const SettingsBackgroundScreen({super.key});

  @override
  ConsumerState<SettingsBackgroundScreen> createState() =>
      _SettingsBackgroundScreenState();
}

class _SettingsBackgroundScreenState
    extends ConsumerState<SettingsBackgroundScreen> {
  /// 前台服务桥（常驻运行开关的读写目标）。
  ForegroundServiceBridge? _service;

  @override
  void initState() {
    super.initState();
    _service = ref.read(foregroundServiceBootstrapProvider);
  }

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final endpoints = ref.watch(endpointsProvider).value;

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
                      onPressed: () =>
                          context.canPop() ? context.pop() : context.go('/settings'),
                      foreground: ai.ink2,
                    ),
                    Text('后台', style: tt.title),
                  ],
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                  children: [
                    SettingsGroup(
                      title: '保活',
                      rows: [
                        SettingsSwitchRow(
                          label: '常驻运行',
                          // 与原实现同口径：有端点即视为服务在跑（bridge 无查询接口）。
                          value: endpoints != null,
                          onChanged: _setForegroundService,
                        ),
                        SettingsRow(
                          label: '电池优化',
                          onTap: () => _snack('请在系统设置里为 aimi 关闭电池优化'),
                          trailing: const SettingsChevron(),
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

  /// 常驻运行开关：控制 Android 前台服务（其他平台为 no-op）。
  Future<void> _setForegroundService(bool enabled) async {
    final service = _service;
    if (service == null) {
      _snack('尚未配对：常驻运行在配对后生效');
      return;
    }
    if (enabled) {
      await service.start();
    } else {
      await service.stop();
    }
    if (!mounted) return;
    setState(() {});
  }

  /// 轻量提示。
  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }
}
