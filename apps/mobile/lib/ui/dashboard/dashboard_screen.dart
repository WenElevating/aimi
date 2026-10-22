import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../data/connection/aimi_connection.dart';
import '../../data/protocol/frame_dto.dart';
import '../../domain/session_view.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';

export '../widgets/aimi_primitives.dart' show relativeTimeLabel;

/// 看板筛选（原型 dashboard.html 的三个 chip）。
enum DashboardFilter {
  /// 全部会话。
  all('全部'),

  /// 需要我：等待审批/回答。
  needsYou('需要我'),

  /// 运行中：running/starting。
  running('运行中');

  const DashboardFilter(this.label);

  /// chip 文案。
  final String label;

  /// 该会话是否属于本筛选。
  bool matches(SessionMetaDto meta) => switch (this) {
        DashboardFilter.all => true,
        DashboardFilter.needsYou =>
          meta.state == 'waiting_approval' || meta.state == 'waiting_input',
        DashboardFilter.running => meta.state == 'running' || meta.state == 'starting',
      };
}

/// 会话看板：连接 pill + 筛选 chips + 待批卡 + 按项目分组的会话行。
///
/// 职责单一（design.md §3.0）：只浏览/进入，不放 composer、不写 agent 名与路径。
/// 会话行 = 状态字形 + 标题 + 时间；状态只靠字形与颜色，不再配状态文字。
class DashboardScreen extends ConsumerStatefulWidget {
  /// 看板页（路由 `/`），不接受额外参数。
  const DashboardScreen({super.key});

  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  DashboardFilter _filter = DashboardFilter.all;

  /// 服务端终结连接的原因（taken_over / revoked）；非 null 时整屏切到终局覆盖层。
  String? _terminated;

  StreamSubscription<String>? _terminationSub;

  @override
  void initState() {
    super.initState();
    _watchTerminations();
  }

  @override
  void dispose() {
    unawaited(_terminationSub?.cancel());
    super.dispose();
  }

  /// 订阅连接层的终结原因：吊销/被接管不是"暂时断线"，要整屏给出唯一动作。
  ///
  /// 连接实例会随 endpoints 变化重建，因此在 build 里比对实例并重新订阅。
  void _watchTerminations() {
    final connection = ref.read(connectionProvider);
    unawaited(_terminationSub?.cancel());
    _terminationSub = connection?.terminations.listen((reason) {
      if (!mounted) return;
      setState(() => _terminated = reason);
    });
  }

  @override
  Widget build(BuildContext context) {
    // 连接实例可能已被重建（重新配对）：跟随当前实例重新订阅。
    ref.listen<AimiConnection?>(connectionProvider, (previous, next) {
      if (!identical(previous, next)) _watchTerminations();
    });
    final terminated = _terminated;
    if (terminated != null) {
      return _TerminalOverlay(
        reason: terminated,
        onAction: () {
          setState(() => _terminated = null);
          if (terminated == 'revoked') {
            unawaited(ref.read(secureStorageProvider).delete(key: tokenStorageKey));
            ref.invalidate(endpointsProvider);
            context.go('/welcome');
          } else {
            // 接管：重新连一次即重新接管该设备。
            unawaited(ref.read(connectionProvider)?.connect() ?? Future<void>.value());
          }
        },
      );
    }
    final ai = context.ai;
    final tt = context.tt;
    final conn = ref.watch(connStateProvider).value ?? ConnState.offline;
    final endpoints = ref.watch(endpointsProvider);
    final sessions = ref.watch(sessionsProvider);

    final configured = endpoints.value != null;
    final filtered = sessions.where(_filter.matches).toList(growable: false);
    final needsYou = sessions.where(DashboardFilter.needsYou.matches).toList(growable: false);

    return Scaffold(
      backgroundColor: ai.canvas,
      body: AimiPageBackground(
        child: SafeArea(
          bottom: false,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _Header(
                conn: conn,
                configured: configured,
                host: endpoints.value?.host ?? '',
                onSettings: () => context.push('/settings'),
                onCreate: configured ? () => context.push('/new-session') : null,
              ),
              if (conn == ConnState.reconnecting) const _ReconnectingBanner(),
              // 原型结构：chips 是**固定行**（.chips padding 14px 20px 0），
              // 不随列表滚动、也不与列表 padding 叠加。
              if (configured && sessions.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, AimiSpace.chipRowTop, 20, 0),
                  child: _FilterChips(
                    current: _filter,
                    counts: <DashboardFilter, int>{
                      DashboardFilter.all: sessions.length,
                      DashboardFilter.needsYou: needsYou.length,
                      DashboardFilter.running: sessions
                          .where(DashboardFilter.running.matches)
                          .length,
                    },
                    onSelect: (filter) => setState(() => _filter = filter),
                  ),
                ),
              Expanded(
                child: !configured
                    ? _NotPairedGuide(onPair: () => context.go('/welcome'))
                    : sessions.isEmpty
                        ? _EmptyGuide(onCreate: () => context.push('/new-session'))
                        : ListView(
                            // 原型 .scroll：padding 0 16px 28px；.section padding-top 13。
                            padding: const EdgeInsets.fromLTRB(16, 13, 16, 96),
                            children: [
                              if (needsYou.isNotEmpty && _filter == DashboardFilter.all) ...[
                                _NeedsAttentionCard(
                                  meta: needsYou.first,
                                  onTap: () => context.push('/session/${needsYou.first.id}'),
                                ),
                              ],
                              ..._groupedRows(filtered),
                              if (filtered.isEmpty)
                                Padding(
                                  padding: const EdgeInsets.only(top: 40),
                                  child: Center(
                                    child: Text(
                                      '这个筛选下没有会话',
                                      style: tt.meta.copyWith(color: ai.ink3),
                                    ),
                                  ),
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

  /// 按项目目录（cwd 末段）分组的会话行；组内保持镜像的 updatedAt 降序。
  List<Widget> _groupedRows(List<SessionMetaDto> sessions) {
    final tt = context.tt;
    final ai = context.ai;
    final groups = <String, List<SessionMetaDto>>{};
    for (final meta in sessions) {
      groups.putIfAbsent(projectNameOf(meta.cwd), () => <SessionMetaDto>[]).add(meta);
    }
    final widgets = <Widget>[];
    groups.forEach((project, metas) {
      widgets.add(
        // 原型 .project-head：padding 7px 4px 3px、12px/500 ink-2、gap 6、图标 13。
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 7, 4, 3),
          child: Row(
            children: [
              AimiIcon(data: AimiIcons.folder, size: 13, color: ai.ink3),
              const SizedBox(width: 6),
              Text(
                project,
                style: tt.micro.copyWith(
                  fontSize: 12,
                  height: 1.25,
                  fontWeight: FontWeight.w500,
                  color: ai.ink2,
                ),
              ),
            ],
          ),
        ),
      );
      for (final meta in metas) {
        widgets.add(
          Padding(
            padding: const EdgeInsets.only(bottom: AimiSpace.cardGap),
            child: _SessionRow(
              meta: meta,
              title: _titleOf(meta),
              onTap: () => context.push('/session/${meta.id}'),
            ),
          ),
        );
      }
    });
    return widgets;
  }

  /// 会话行的标题：优先取本会话首条 agent 文本，其次项目名。
  ///
  /// 列表行只放「标题 + 时间」（design.md §2.4）：不写副标题、状态文字、agent 名与路径。
  /// 用户提问不回显进镜像，故标题只能取 agent 首句。
  String _titleOf(SessionMetaDto meta) {
    for (final event in ref.read(sessionEventsProvider(meta.id))) {
      if (event.type == 'text_delta' && (event.text ?? '').trim().isNotEmpty) {
        return event.text!.trim().split('\n').first;
      }
    }
    return projectNameOf(meta.cwd);
  }
}

/// 终局覆盖层（原型 dashboard.html `?state=takenover|revoked`）：一句状态 + 一个动作。
///
/// 这类状态不是"暂时断线"：接管要重新连、吊销要重新配对，所以整屏只给一个动作，
/// 不显示会话列表（避免用户以为还能操作）。
class _TerminalOverlay extends StatelessWidget {
  const _TerminalOverlay({required this.reason, required this.onAction});

  /// 服务端 bye 原因（`taken_over` / `revoked`，其它按通用终止处理）。
  final String reason;

  /// 唯一动作（接管=重新打开；吊销=去配对）。
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final revoked = reason == 'revoked';
    return Scaffold(
      backgroundColor: ai.canvas,
      body: AimiPageBackground(
        child: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: revoked ? ai.redSoft : ai.amberSoft,
                    ),
                    alignment: Alignment.center,
                    child: AimiIcon(
                      data: revoked ? AimiIcons.linkOff : AimiIcons.lock,
                      size: 20,
                      color: revoked ? ai.red : ai.amberStrong,
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text(revoked ? '设备已被移除' : '已在别处接管', style: tt.row),
                  const SizedBox(height: 6),
                  Text(
                    revoked ? '在电脑上重新配对后可用' : '这台设备已断开；重新打开会再次接管',
                    style: tt.meta.copyWith(color: ai.ink3),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 20),
                  SizedBox(
                    width: 200,
                    height: 50,
                    child: FilledButton(
                      onPressed: onAction,
                      child: Text(revoked ? '重新配对' : '重新打开'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 目录末段作为项目名（界面不显示完整路径）。
String projectNameOf(String cwd) {
  final parts = cwd.split(RegExp(r'[\\/]')).where((s) => s.isNotEmpty).toList();
  return parts.isEmpty ? cwd : parts.last;
}

/// 看板头部：标题「会话」+ 机器 pill + 新建/设置两个图标入口。
class _Header extends StatelessWidget {
  const _Header({
    required this.conn,
    required this.configured,
    required this.host,
    required this.onSettings,
    this.onCreate,
  });

  final ConnState conn;
  final bool configured;
  final String host;
  final VoidCallback onSettings;
  final VoidCallback? onCreate;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
          AimiSpace.headerLeft,
          AimiSpace.statusbarCompensation,
          AimiSpace.headerRight - 10,
          0,
        ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text('会话', style: tt.display)),
              AimiIconButton(
                icon: AimiIcons.plus,
                semanticLabel: '新建会话',
                onPressed: onCreate,
                foreground: ai.ink2,
              ),
              AimiIconButton(
                icon: AimiIcons.gear,
                semanticLabel: '设置',
                onPressed: onSettings,
                foreground: ai.ink2,
              ),
            ],
          ),
          if (configured) ...[
            // 原型 .machine-row：padding 7px 20px 0。
            const SizedBox(height: 7),
            _MachinePill(conn: conn, host: host),
          ],
        ],
      ),
    );
  }
}

/// 机器 pill：呼吸点 + 主机 · 链路（不写「已连接/在线」）。
class _MachinePill extends StatelessWidget {
  const _MachinePill({required this.conn, required this.host});

  final ConnState conn;
  final String host;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final online = conn == ConnState.onlineLan || conn == ConnState.onlineRelay;
    final color = switch (conn) {
      ConnState.onlineLan || ConnState.onlineRelay => ai.green,
      ConnState.reconnecting => ai.amber,
      ConnState.offline => ai.ink4,
    };
    final linkKind = conn == ConnState.onlineRelay ? '中继' : '局域网';
    // 原型 .machine-pill：26 高、padding 0 10、surface 底 + 1px 发丝线、
    // 11.5/500 ink-2，点 6px 带 3px 软环，分隔点 ink-4，链路延迟用 10.5 mono ink-3。
    final label = host.isEmpty ? linkKind : host;
    return Container(
      height: 26,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: ai.surfaceSolid,
        borderRadius: const BorderRadius.all(AimiRadius.pill),
        border: Border.all(color: ai.line),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (online)
            AimiBreathingDot(color: color, size: 6, halo: ai.greenSoft)
          else
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(shape: BoxShape.circle, color: color),
            ),
          const SizedBox(width: 6),
          Text(
            label,
            style: tt.micro.copyWith(
              fontSize: 11.5,
              height: 1.3,
              fontWeight: FontWeight.w500,
              color: ai.ink2,
            ),
          ),
          _sep(ai),
          Text(
            linkKind,
            style: tt.micro.copyWith(
              fontSize: 11.5,
              height: 1.3,
              fontWeight: FontWeight.w500,
              color: ai.ink2,
            ),
          ),
        ],
      ),
    );
  }

  /// 分隔点（原型 `.machine-pill .sep`：ink-4）。
  Widget _sep(AimiColors ai) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 5),
        child: Text('·', style: TextStyle(fontSize: 11.5, color: ai.ink4)),
      );
}

/// 筛选 chips：选中反色；计数只保留有决策价值的数字。
class _FilterChips extends StatelessWidget {
  const _FilterChips({
    required this.current,
    required this.counts,
    required this.onSelect,
  });

  final DashboardFilter current;
  final Map<DashboardFilter, int> counts;
  final ValueChanged<DashboardFilter> onSelect;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Row(
      children: [
        for (final filter in DashboardFilter.values) ...[
          if (filter != DashboardFilter.values.first) const SizedBox(width: 6),
          Semantics(
            button: true,
            selected: filter == current,
            child: AimiPressable(
              onTap: () => onSelect(filter),
              borderRadius: const BorderRadius.all(AimiRadius.pill),
              child: Container(
                height: 32,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                decoration: BoxDecoration(
                  color: filter == current ? ai.ink : ai.surface2,
                  borderRadius: const BorderRadius.all(AimiRadius.pill),
                ),
                alignment: Alignment.center,
                child: Text(
                  '${filter.label} ${counts[filter] ?? 0}',
                  style: tt.chip.copyWith(
                    color: filter == current ? ai.canvas : ai.ink2,
                  ),
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// 待批卡：琥珀渐变卡，点进会话（决策在会话 sheet，不在看板）。
class _NeedsAttentionCard extends StatelessWidget {
  const _NeedsAttentionCard({required this.meta, required this.onTap});

  final SessionMetaDto meta;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Semantics(
      button: true,
      label: '待批：${projectNameOf(meta.cwd)}',
      child: AimiPressable(
        onTap: onTap,
        borderRadius: const BorderRadius.all(AimiRadius.card),
        child: Container(
          padding: const EdgeInsets.all(13),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: <Color>[ai.amberSoft, ai.surface],
            ),
            borderRadius: const BorderRadius.all(AimiRadius.card),
            border: Border.all(color: ai.amberLine),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  AimiBreathingDot(color: ai.amberStrong, size: 6, halo: ai.amberSoft),
                  const SizedBox(width: 6),
                  Text(
                    meta.state == 'waiting_input' ? '待回答' : '待批',
                    style: tt.micro.copyWith(color: ai.amberStrong),
                  ),
                  const Spacer(),
                  Text(
                    relativeTimeLabel(meta.updatedAt),
                    style: tt.micro.copyWith(color: ai.ink3),
                  ),
                  const SizedBox(width: 2),
                  AimiIcon(data: AimiIcons.chevron, size: 13, color: ai.ink3),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                projectNameOf(meta.cwd),
                style: tt.needsTitle,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 会话行：32px 状态气泡 + 标题 + 时间（不写 agent 名/路径/状态文字）。
class _SessionRow extends StatelessWidget {
  const _SessionRow({
    required this.meta,
    required this.title,
    required this.onTap,
  });

  final SessionMetaDto meta;
  final String title;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Semantics(
      button: true,
      label: '$title，${stateLabel(meta.state)}，${relativeTimeLabel(meta.updatedAt)}',
      child: AimiPressable(
        onTap: onTap,
        borderRadius: const BorderRadius.all(AimiRadius.card),
        child: Container(
          // 原型 min-height 60（32 气泡 + 上下 9 + 边框 = 52，由 min-height 补到 60）。
          constraints: const BoxConstraints(minHeight: AimiSpace.rowMinHeight),
          padding: const EdgeInsets.symmetric(
            horizontal: AimiSpace.rowPadH,
            vertical: AimiSpace.rowPadV,
          ),
          decoration: BoxDecoration(
            color: ai.surfaceSolid,
            borderRadius: const BorderRadius.all(AimiRadius.card),
            border: Border.all(color: ai.line),
            boxShadow: AimiShadow.card(Theme.of(context).brightness == Brightness.dark),
          ),
          child: Row(
            children: [
              AimiStatusGlyph(
                shape: statusShapeOf(meta.state),
                size: 32,
                color: statusColorOf(meta.state, ai),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: tt.row),
              ),
              const SizedBox(width: 10),
              // 原型 .session-time：11px / ink-3（右侧单行，不写状态文字）。
              Text(
                relativeTimeLabel(meta.updatedAt),
                style: tt.micro.copyWith(fontSize: 11, height: 1.3, color: ai.ink3),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 会话状态 → 字形（与颜色组成三重编码）。
AimiStatusShape statusShapeOf(String state) => switch (state) {
      'running' || 'starting' => AimiStatusShape.running,
      'waiting_approval' || 'waiting_input' => AimiStatusShape.waiting,
      'finished' => AimiStatusShape.done,
      'stopped' => AimiStatusShape.stopped,
      'failed' => AimiStatusShape.failed,
      _ => AimiStatusShape.idle,
    };

/// 会话状态 → 语义色。
Color statusColorOf(String state, AimiColors ai) => switch (state) {
      'running' || 'starting' => ai.green,
      'waiting_approval' || 'waiting_input' => ai.amber,
      'failed' => ai.red,
      'finished' || 'stopped' => ai.ink3,
      _ => ai.ink4,
    };

/// 重连横幅：琥珀静态条（不闪烁、不堆链路细节）。
class _ReconnectingBanner extends StatelessWidget {
  const _ReconnectingBanner();

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: ai.amberSoft,
        borderRadius: const BorderRadius.all(AimiRadius.well),
        border: Border.all(color: ai.amberLine),
      ),
      child: Row(
        children: [
          SizedBox.square(
            dimension: 12,
            child: CircularProgressIndicator(
              strokeWidth: 1.6,
              valueColor: AlwaysStoppedAnimation<Color>(ai.amberStrong),
            ),
          ),
          const SizedBox(width: 8),
          Text('正在重连', style: tt.micro.copyWith(color: ai.amberStrong)),
        ],
      ),
    );
  }
}

/// 未配对引导：一句状态 + 一个主按钮（配对入口只在 welcome 页）。
class _NotPairedGuide extends StatelessWidget {
  const _NotPairedGuide({required this.onPair});

  final VoidCallback onPair;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(shape: BoxShape.circle, color: ai.surface2),
              alignment: Alignment.center,
              child: AimiIcon(data: AimiIcons.linkOff, size: 20, color: ai.ink3),
            ),
            const SizedBox(height: 14),
            Text('还没有连接电脑', style: tt.row),
            const SizedBox(height: 16),
            SizedBox(
              width: 200,
              child: FilledButton(onPressed: onPair, child: const Text('去配对')),
            ),
          ],
        ),
      ),
    );
  }
}

/// 空态：还没有会话 + 一个主按钮。
class _EmptyGuide extends StatelessWidget {
  const _EmptyGuide({required this.onCreate});

  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(shape: BoxShape.circle, color: ai.surface2),
            alignment: Alignment.center,
            child: AimiIcon(data: AimiIcons.spark, size: 20, color: ai.ink3),
          ),
          const SizedBox(height: 14),
          Text('还没有会话', style: tt.row),
          const SizedBox(height: 16),
          FilledButton(onPressed: onCreate, child: const Text('新建会话')),
        ],
      ),
    );
  }
}
