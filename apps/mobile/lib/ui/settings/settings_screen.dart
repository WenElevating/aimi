import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../data/connection/aimi_connection.dart';
import '../../data/notifications/foreground_service.dart';
import '../feedback/feedback_sheet.dart';
import '../../data/notifications/notification_policy.dart';
import '../../data/update/app_updater.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';

/// 设置页（原型 settings.html）：只做配置，不含会话控制、输入框与配对入口。
///
/// 分组：连接（状态 + 重新连接）/ 通知（五个分类开关）/ 后台（常驻运行、**电池优化、开机自启）
/// / Agent（可用性）/ 外观（跟随系统/浅色/深色）/ 关于（版本）。
/// 地址与令牌不在这里——配对是唯一入口（design.md §3.0「同一动作只有一个入口」）。
class SettingsScreen extends ConsumerStatefulWidget {
  /// 设置页（路由 `/settings`），不接受额外参数。
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
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
    final conn = ref.watch(connStateProvider).value ?? ConnState.offline;
    final endpoints = ref.watch(endpointsProvider).value;
    final toggles = ref.watch(notificationTogglesProvider);
    final themeMode = ref.watch(themeModeProvider);
    final versionName = ref.watch(packageInfoProvider).value?.version ?? '…';

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
                      semanticLabel: '返回',
                      onPressed: () => context.canPop() ? context.pop() : context.go('/'),
                      foreground: ai.ink2,
                    ),
                    Text('设置', style: tt.title),
                  ],
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                  children: [
                    _group('连接', ai, [
                      _row(
                        ai: ai,
                        tt: tt,
                        label: '服务器',
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            _statusDot(conn, ai),
                            const SizedBox(width: 6),
                            AimiMono(
                              _serverLabel(endpoints, conn),
                              style: tt.micro.copyWith(fontFamily: 'JetBrainsMono'),
                              color: ai.ink2,
                            ),
                          ],
                        ),
                      ),
                      _row(
                        ai: ai,
                        tt: tt,
                        label: '重新连接',
                        onTap: _reconnect,
                        trailing: Icon(
                          Icons.refresh,
                          size: 16,
                          color: ai.ink3,
                        ),
                      ),
                    ]),
                    _group('通知', ai, [
                      for (final kind in NotificationKind.values)
                        _switchRow(
                          ai: ai,
                          tt: tt,
                          label: _notificationLabel(kind),
                          value: toggles[kind] ?? false,
                          onChanged: (value) =>
                              ref.read(notificationTogglesProvider.notifier).setEnabled(kind, value),
                        ),
                    ]),
                    _group('后台', ai, [
                      _switchRow(
                        ai: ai,
                        tt: tt,
                        label: '常驻运行',
                        value: endpoints != null,
                        onChanged: _setForegroundService,
                      ),
                      _row(
                        ai: ai,
                        tt: tt,
                        label: '电池优化',
                        onTap: () => _snack('请在系统设置里为 aimi 关闭电池优化'),
                        trailing: AimiIcon(data: AimiIcons.chevron, size: 13, color: ai.ink3),
                      ),
                    ]),
                    _group('Agent', ai, [
                      _agentRow(ai, tt, 'claude', true),
                      _agentRow(ai, tt, 'codex', false),
                    ]),
                    _group('外观', ai, [
                      _themeSegment(ai, tt, themeMode),
                    ]),
                    _group('关于', ai, [
                      _row(
                        ai: ai,
                        tt: tt,
                        label: '版本',
                        trailing: AimiMono(versionName, color: ai.ink3),
                      ),
                      _row(
                        ai: ai,
                        tt: tt,
                        label: '检查更新',
                        onTap: _checkUpdate,
                        trailing: AimiIcon(
                          data: AimiIcons.chevron,
                          size: 13,
                          color: ai.ink3,
                        ),
                      ),
                      _row(
                        ai: ai,
                        tt: tt,
                        label: '意见反馈',
                        onTap: () => showAimiFeedbackSheet(context),
                        trailing: AimiIcon(
                          data: AimiIcons.chevron,
                          size: 13,
                          color: ai.ink3,
                        ),
                      ),
                    ]),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 发丝线分组卡：一组行共享一张卡（行间用 1px 发丝线分隔）。
  Widget _group(String title, AimiColors ai, List<Widget> rows) => Padding(
        padding: const EdgeInsets.only(bottom: AimiSpace.groupGap),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 4, bottom: 6),
              child: Text(title, style: context.tt.micro.copyWith(color: ai.ink3)),
            ),
            AimiSurface(
              padding: EdgeInsets.zero,
              child: Column(
                children: [
                  for (var i = 0; i < rows.length; i++) ...[
                    if (i > 0) const Divider(height: 1),
                    rows[i],
                  ],
                ],
              ),
            ),
          ],
        ),
      );

  /// 普通行：标签 + 尾部内容；有 [onTap] 时整行可点（触控 ≥48）。
  Widget _row({
    required AimiColors ai,
    required AimiText tt,
    required String label,
    required Widget trailing,
    VoidCallback? onTap,
  }) {
    final content = Container(
      constraints: const BoxConstraints(minHeight: AimiSpace.setRowHeight),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      child: Row(
        children: [
          Text(label, style: tt.meta.copyWith(color: ai.ink)),
          const Spacer(),
          trailing,
        ],
      ),
    );
    if (onTap == null) return content;
    return AimiPressable(onTap: onTap, child: content);
  }

  /// 开关行：整行是热区，开关本身 `role="switch"`（由 Switch 的 Semantics 提供）。
  Widget _switchRow({
    required AimiColors ai,
    required AimiText tt,
    required String label,
    required bool value,
    required ValueChanged<bool> onChanged,
  }) =>
      AimiPressable(
        onTap: () => onChanged(!value),
        child: Container(
          constraints: const BoxConstraints(minHeight: AimiSpace.setRowHeight),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          child: Row(
            children: [
              Text(label, style: tt.meta.copyWith(color: ai.ink)),
              const Spacer(),
              Switch(value: value, onChanged: onChanged),
            ],
          ),
        ),
      );

  /// Agent 可用性行：可用灰勾，不可用置灰 + 斜杠（不只靠颜色）。
  Widget _agentRow(AimiColors ai, AimiText tt, String name, bool available) => Container(
        constraints: const BoxConstraints(minHeight: AimiSpace.setRowHeight),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Row(
          children: [
            Opacity(
              opacity: available ? 1 : 0.42,
              child: Text(name, style: tt.meta.copyWith(color: ai.ink)),
            ),
            const Spacer(),
            if (available)
              AimiIcon(data: AimiIcons.check, size: 14, color: ai.ink3)
            else
              Row(
                children: [
                  Opacity(
                    opacity: 0.42,
                    child: AimiIcon(data: AimiIcons.slash, size: 13, color: ai.ink3),
                  ),
                  const SizedBox(width: 4),
                  Text('暂不可用', style: tt.micro.copyWith(color: ai.ink3)),
                ],
              ),
          ],
        ),
      );

  /// 外观分段：跟随系统 / 浅色 / 深色（选中即生效并持久化）。
  Widget _themeSegment(AimiColors ai, AimiText tt, AimiThemeMode current) => Padding(
        padding: const EdgeInsets.all(10),
        child: Row(
          children: [
            for (final mode in AimiThemeMode.values) ...[
              if (mode != AimiThemeMode.values.first) const SizedBox(width: 6),
              Expanded(
                child: Semantics(
                  button: true,
                  selected: mode == current,
                  child: AimiPressable(
                    onTap: () => ref.read(themeModeProvider.notifier).setMode(mode),
                    borderRadius: const BorderRadius.all(AimiRadius.pill),
                    child: Container(
                      height: 34,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: mode == current ? ai.ink : ai.surface2,
                        borderRadius: const BorderRadius.all(AimiRadius.pill),
                      ),
                      child: Text(
                        _themeLabel(mode),
                        style: tt.micro.copyWith(
                          color: mode == current ? ai.canvas : ai.ink2,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
      );

  /// 连接状态点（通=绿、重连中=琥珀、离线=灰）。
  Widget _statusDot(ConnState conn, AimiColors ai) {
    final color = switch (conn) {
      ConnState.onlineLan || ConnState.onlineRelay => ai.green,
      ConnState.reconnecting => ai.amber,
      ConnState.offline => ai.ink4,
    };
    return Container(
      width: 6,
      height: 6,
      decoration: BoxDecoration(shape: BoxShape.circle, color: color),
    );
  }

  /// 服务器行文本：有端点时 `host · 局域网/中继`，否则「未配对」。
  String _serverLabel(AimiEndpoints? endpoints, ConnState conn) {
    if (endpoints == null) return '未配对';
    final link = conn == ConnState.onlineRelay ? '中继' : '局域网';
    return '${endpoints.host} · $link';
  }

  /// 通知分类的中文标签。
  String _notificationLabel(NotificationKind kind) => switch (kind) {
        NotificationKind.approval => '待审批',
        NotificationKind.question => '待回答',
        NotificationKind.finished => '完成',
        NotificationKind.failed => '失败',
        NotificationKind.stalled => '可能卡住',
      };

  /// 外观档位标签。
  String _themeLabel(AimiThemeMode mode) => switch (mode) {
        AimiThemeMode.system => '跟随系统',
        AimiThemeMode.light => '浅色',
        AimiThemeMode.dark => '深色',
      };

  /// 重新连接：必须先 disconnect 再 connect（`connect()` 非重入）。
  Future<void> _reconnect() async {
    final connection = ref.read(connectionProvider);
    if (connection == null) {
      _snack('尚未配对：请从入口页完成配对');
      return;
    }
    await connection.disconnect();
    await connection.connect();
    _snack('已重新连接');
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

  /// 检查更新：置 checking 态、发 update.check，并弹出更新流程面板（阶段实时刷新）。
  void _checkUpdate() {
    final connection = ref.read(connectionProvider);
    ref
        .read(appUpdaterProvider.notifier)
        .startCheck(() => connection?.checkForUpdate() ?? false);
    showAimiUpdateSheet(context);
  }
}

/// 更新流程面板（底部弹层）：按 [UpdatePhase] 渲染检查/可更新/下载进度/安装/失败各阶段。
///
/// why 弹层而非整页：更新是设置页"关于"区的一个动作，流程短暂且需要进度反馈，
/// 底部弹层与审批面板（showAimiApprovalSheet）同一交互语言。
Future<void> showAimiUpdateSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: context.ai.surfaceSolid,
    barrierColor: context.ai.scrim,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: AimiRadius.sheet),
    ),
    isScrollControlled: true,
    builder: (sheetContext) => const _UpdateSheetBody(),
  );
}

/// 更新面板内容：Consumer 订阅 [appUpdaterProvider]，各阶段一个视图。
class _UpdateSheetBody extends ConsumerWidget {
  const _UpdateSheetBody();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ai = context.ai;
    final tt = context.tt;
    final state = ref.watch(appUpdaterProvider);
    final manifest = state.manifest;
    final children = <Widget>[
      Text('软件更新', style: tt.sheetTitle.copyWith(color: ai.ink)),
      const SizedBox(height: AimiSpace.s4),
    ];

    switch (state.phase) {
      case UpdatePhase.idle:
      case UpdatePhase.checking:
        children.addAll([
          Text('正在检查更新…', style: tt.body.copyWith(color: ai.ink2)),
        ]);
      case UpdatePhase.upToDate:
        children.addAll([
          Text('已是最新版本', style: tt.body.copyWith(color: ai.ink2)),
        ]);
      case UpdatePhase.available:
      case UpdatePhase.failed:
      case UpdatePhase.permissionNeeded:
        children.addAll([
          if (manifest != null) ...[
            Text(
              '发现新版本 ${manifest.versionName}',
              style: tt.body.copyWith(color: ai.ink),
            ),
            const SizedBox(height: 6),
            Text(
              '大小 ${(manifest.size / 1024 / 1024).toStringAsFixed(1)} MB'
              '${manifest.notes == null ? '' : ' · ${manifest.notes}'}',
              style: tt.micro.copyWith(color: ai.ink3),
            ),
          ],
          if (state.phase == UpdatePhase.failed && state.error != null) ...[
            const SizedBox(height: 6),
            Text(
              state.error!,
              style: tt.micro.copyWith(color: ai.red),
            ),
          ],
          if (state.phase == UpdatePhase.permissionNeeded && state.error != null) ...[
            const SizedBox(height: 6),
            Text(
              state.error!,
              style: tt.micro.copyWith(color: ai.amber),
            ),
          ],
          const SizedBox(height: AimiSpace.s4),
          if (state.phase == UpdatePhase.permissionNeeded)
            FilledButton(
              onPressed: () =>
                  ref.read(appUpdaterProvider.notifier).retryAfterPermission(),
              child: const Text('重试安装'),
            )
          else
            FilledButton(
              onPressed: state.manifest == null
                  ? null
                  : () => ref
                        .read(appUpdaterProvider.notifier)
                        .downloadAndInstall(),
              child: const Text('下载并安装'),
            ),
        ]);
      case UpdatePhase.downloading:
        final total = state.total <= 0 ? 1 : state.total;
        children.addAll([
          Text(
            '正在下载 ${manifest?.versionName ?? ''}',
            style: tt.body.copyWith(color: ai.ink),
          ),
          const SizedBox(height: AimiSpace.s4),
          ClipRRect(
            borderRadius: const BorderRadius.all(AimiRadius.pill),
            child: LinearProgressIndicator(
              value: state.received / total,
              minHeight: 6,
              backgroundColor: ai.surface2,
              valueColor: AlwaysStoppedAnimation<Color>(ai.ink),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            '${(state.received / 1024 / 1024).toStringAsFixed(1)} / ${(state.total / 1024 / 1024).toStringAsFixed(1)} MB',
            style: tt.micro.copyWith(color: ai.ink3),
          ),
        ]);
      case UpdatePhase.installing:
        children.addAll([
          Text(
            '已调起系统安装器，请在系统界面确认安装',
            style: tt.body.copyWith(color: ai.ink2),
          ),
        ]);
    }

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        ),
      ),
    );
  }
}
