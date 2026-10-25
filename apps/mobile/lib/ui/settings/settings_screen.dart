import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../data/connection/aimi_connection.dart';
import '../../data/update/app_updater.dart';
import '../feedback/feedback_sheet.dart';
import '../icons/aimi_icons.dart';
import '../session/composer.dart';
import '../widgets/aimi_primitives.dart';
import 'settings_widgets.dart';

/// 设置一级页（原型 settings.html 两级结构）：只放「一眼能决定」的项。
///
/// 分组：连接（服务器状态 + 重新连接）/ 偏好（通知→二级、后台→二级、
/// Agent 下拉、外观下拉）/ 关于（版本、检查更新、意见反馈）。
/// 通知分类开关、后台保活下沉到二级页（design.md §3.0：一级不铺开关墙）；
/// 地址与令牌不在这里——配对是唯一入口（「同一动作只有一个入口」）。
class SettingsScreen extends ConsumerStatefulWidget {
  /// 设置页（路由 `/settings`），不接受额外参数。
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  /// 下拉触发行锚点：picker 用它定位到行下方（实机反馈 20261025-142036）。
  final _agentRowKey = GlobalKey();
  final _themeRowKey = GlobalKey();

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final conn = ref.watch(connStateProvider).value ?? ConnState.offline;
    final endpoints = ref.watch(endpointsProvider).value;
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
                    _connectionGroup(ai, tt, conn, endpoints),
                    _preferenceGroup(ai, tt, themeMode),
                    _aboutGroup(ai, tt, versionName),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 连接组：服务器（状态点 + host · 链路，不可点）+ 重新连接。
  Widget _connectionGroup(
    AimiColors ai,
    AimiText tt,
    ConnState conn,
    AimiEndpoints? endpoints,
  ) {
    return SettingsGroup(title: '连接', rows: [
      SettingsRow(
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
      SettingsRow(
        label: '重新连接',
        onTap: _reconnect,
        trailing: const SettingsChevron(),
      ),
    ]);
  }

  /// 偏好组：两个 link row（进二级页）+ 两个 select row（行内下拉）。
  Widget _preferenceGroup(AimiColors ai, AimiText tt, AimiThemeMode themeMode) {
    return SettingsGroup(title: '偏好', rows: [
      SettingsRow(
        label: '通知',
        onTap: () => context.push('/settings/notifications'),
        trailing: const SettingsChevron(),
      ),
      SettingsRow(
        label: '后台',
        onTap: () => context.push('/settings/background'),
        trailing: const SettingsChevron(),
      ),
      SettingsRow(
        key: _agentRowKey,
        label: 'Agent',
        onTap: _pickAgent,
        trailing: const SettingsSelectValue(value: 'claude'),
      ),
      SettingsRow(
        key: _themeRowKey,
        label: '外观',
        onTap: () => unawaited(_pickTheme(themeMode)),
        trailing: SettingsSelectValue(value: _themeLabel(themeMode)),
      ),
    ]);
  }

  /// 关于组：版本（只读）+ 检查更新 + 意见反馈。
  Widget _aboutGroup(AimiColors ai, AimiText tt, String versionName) {
    return SettingsGroup(title: '关于', rows: [
      SettingsRow(
        label: '版本',
        trailing: AimiMono(versionName, color: ai.ink3),
      ),
      SettingsRow(
        label: '检查更新',
        onTap: _checkUpdate,
        trailing: const SettingsChevron(),
      ),
      SettingsRow(
        label: '意见反馈',
        onTap: () => showAimiFeedbackSheet(context),
        trailing: const SettingsChevron(),
      ),
    ]);
  }

  /// Agent 下拉：目前仅 claude 可用；codex 置灰 + 原因（disabled picker 行）。
  Future<void> _pickAgent() async {
    await showAimiPicker<String>(
      context: context,
      title: 'Agent',
      anchorKey: _agentRowKey,
      options: const [
        AimiPickerOption(label: 'claude', value: 'claude', checked: true),
        AimiPickerOption(
          label: 'codex',
          value: 'codex',
          detail: '暂不可用',
          disabled: true,
        ),
      ],
    );
    // 选中 claude 不需要落盘：当前唯一可用项即默认项；codex 解禁时再接持久化。
  }

  /// 外观下拉：三档，选中即生效并持久化（themeModeProvider）。
  Future<void> _pickTheme(AimiThemeMode current) async {
    final mode = await showAimiPicker<AimiThemeMode>(
      context: context,
      title: '外观',
      anchorKey: _themeRowKey,
      options: [
        for (final mode in AimiThemeMode.values)
          AimiPickerOption(
            label: _themeLabel(mode),
            value: mode,
            checked: mode == current,
          ),
      ],
    );
    if (mode == null || mode == current) return;
    await ref.read(themeModeProvider.notifier).setMode(mode);
  }

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

  /// 轻量提示。
  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  /// 检查更新（实机反馈 20261025-142036）：无更新→顶部轻提示；有更新→中间模态确认；
  /// 失败→顶部轻提示。不再无条件弹底部抽屉。
  Future<void> _checkUpdate() async {
    final connection = ref.read(connectionProvider);
    final updater = ref.read(appUpdaterProvider.notifier);
    // 先订阅、后 startCheck：StateNotifier.stream 是广播流，startCheck 的同步
    // 失败路径（未连接立即 failed）不会重放事件，后订阅会永远等不到。
    final settled = updater.stream
        .firstWhere((state) => state.phase != UpdatePhase.checking)
        .timeout(
          const Duration(seconds: 8),
          onTimeout: () => const UpdateState(
            phase: UpdatePhase.failed,
            error: '检查更新超时，请稍后重试',
          ),
        );
    updater.startCheck(() => connection?.checkForUpdate() ?? false);
    final UpdateState result;
    try {
      result = await settled;
    } on StateError {
      // provider 被 dispose（页面退出）等边界：静默放弃。
      return;
    }
    if (!mounted) return;
    switch (result.phase) {
      case UpdatePhase.upToDate:
        showAimiTopToast(context, '当前已是最新版本');
      case UpdatePhase.failed:
        showAimiTopToast(context, result.error ?? '检查更新失败');
      case UpdatePhase.available:
        await showAimiUpdateDialog(context);
      default:
        // checking/idle 不该出现在这里；downloading 等属模态内推进的后续阶段。
        break;
    }
  }
}

/// 更新确认模态（实机反馈：有更新弹中间模态而非底部抽屉）。
///
/// 打开时处于 available，之后 downloading/installing/failed/permissionNeeded
/// 全部在这一个对话框里原地跟随；关闭对话框不打断下载（AppUpdater 是全局
/// 状态，重开检查更新会再次看到进度）。等待安装确认的 installing 阶段在
/// 对话框外到达时由 [_UpdateDialogBody] 消失前的 build 收口提示。
Future<void> showAimiUpdateDialog(BuildContext context) {
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: false,
    barrierLabel: '软件更新',
    barrierColor: context.ai.scrim,
    transitionDuration: AimiMotion.fast,
    pageBuilder: (dialogContext, _, _) => const _UpdateDialogBody(),
    transitionBuilder: (dialogContext, animation, _, child) => FadeTransition(
      opacity: CurvedAnimation(parent: animation, curve: AimiMotion.ease),
      child: ScaleTransition(
        scale: Tween<double>(begin: 0.96, end: 1).animate(
          CurvedAnimation(parent: animation, curve: AimiMotion.ease),
        ),
        child: child,
      ),
    ),
  );
}

/// 更新模态内容：Consumer 订阅 [appUpdaterProvider]，各阶段一个视图。
class _UpdateDialogBody extends ConsumerWidget {
  const _UpdateDialogBody();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ai = context.ai;
    final tt = context.tt;
    final state = ref.watch(appUpdaterProvider);
    final updater = ref.read(appUpdaterProvider.notifier);
    final manifest = state.manifest;

    Widget body;
    switch (state.phase) {
      case UpdatePhase.idle:
      case UpdatePhase.checking:
      case UpdatePhase.upToDate:
        // 模态只在 available 及之后存在；期间被新检查重置时直接关闭。
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (context.mounted) Navigator.of(context).pop();
        });
        body = const SizedBox.shrink();
      case UpdatePhase.available:
        body = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
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
              const SizedBox(height: AimiSpace.s4),
            ],
            FilledButton(
              onPressed: manifest == null
                  ? null
                  : () => updater.downloadAndInstall(),
              child: const Text('下载并安装'),
            ),
            const SizedBox(height: AimiSpace.s2),
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('以后再说'),
            ),
          ],
        );
      case UpdatePhase.downloading:
        final total = state.total <= 0 ? 1 : state.total;
        body = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
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
            const SizedBox(height: AimiSpace.s2),
            // 下载不可逆（已写缓存），但允许用户收起对话框后台继续。
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('后台下载'),
            ),
          ],
        );
      case UpdatePhase.installing:
        body = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              '已调起系统安装器，请在系统界面确认安装',
              style: tt.body.copyWith(color: ai.ink2),
            ),
            const SizedBox(height: AimiSpace.s2),
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('关闭'),
            ),
          ],
        );
      case UpdatePhase.failed:
        body = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('下载或校验失败', style: tt.body.copyWith(color: ai.ink)),
            const SizedBox(height: 6),
            if (state.error != null)
              Text(state.error!, style: tt.micro.copyWith(color: ai.red)),
            const SizedBox(height: AimiSpace.s4),
            FilledButton(
              onPressed: () => updater.downloadAndInstall(),
              child: const Text('重试'),
            ),
            const SizedBox(height: AimiSpace.s2),
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('取消'),
            ),
          ],
        );
      case UpdatePhase.permissionNeeded:
        body = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('需要安装权限', style: tt.body.copyWith(color: ai.ink)),
            const SizedBox(height: 6),
            if (state.error != null)
              Text(state.error!, style: tt.micro.copyWith(color: ai.amber)),
            const SizedBox(height: AimiSpace.s4),
            FilledButton(
              onPressed: () => updater.retryAfterPermission(),
              child: const Text('去开启权限'),
            ),
            const SizedBox(height: AimiSpace.s2),
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('取消'),
            ),
          ],
        );
    }

    return Dialog(
      backgroundColor: Colors.transparent,
      child: AimiSurface(
        radius: AimiRadius.card,
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('软件更新', style: tt.sheetTitle.copyWith(color: ai.ink)),
            const SizedBox(height: AimiSpace.s4),
            // Flexible 防长 notes 把对话框撑出屏。
            Flexible(child: SingleChildScrollView(child: body)),
          ],
        ),
      ),
    );
  }
}
