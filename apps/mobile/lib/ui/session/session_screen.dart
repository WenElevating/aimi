import 'dart:async';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../app/providers.dart';
import '../../app/session_render_provider.dart';
import '../../app/theme.dart';
import '../../data/cache/session_mirror.dart';
import '../../data/connection/aimi_connection.dart';
import '../../data/protocol/frame_dto.dart';
import '../../data/observability/client_metrics.dart';
import '../../domain/session_view.dart';
import '../feedback/turn_feedback_sheet.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';
import '../widgets/timeline_view.dart';
import 'composer.dart';

/// 会话页：时间线（回合制）+ composer（单主按钮状态机）+ 审批/提问 sheet。
///
/// 状态来源全部是服务端事实：`sessionsProvider`（state/model/permissionMode）与
/// `sessionEventsProvider`（事件流）。本页只持有「输入文本」「待发消息」两类本地状态。
class SessionScreen extends ConsumerStatefulWidget {
  /// [sessionId] 来自路由 `/session/:id`。
  const SessionScreen({super.key, required this.sessionId});

  /// 会话 id，由 server 生成，重连后保持不变。
  final String sessionId;

  @override
  ConsumerState<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends ConsumerState<SessionScreen> {
  final TextEditingController _input = TextEditingController();
  final FocusNode _composerFocus = FocusNode();
  final ScrollController _scroll = ScrollController();
  static const Uuid _uuid = Uuid();

  /// 当前待发消息（最多一条：原型胶囊是单条语义）。
  OutgoingMessage? _queued;

  /// 已发起、尚未被任何事件确认的发送（用于回合锚定，避免与镜像重复渲染）。
  final List<SentPrompt> _sent = <SentPrompt>[];

  /// 最近一次同步时刻（断线横幅的「上次同步」）。
  int? _lastSyncedAt;

  /// 模型请求等待回执期间防止重复提交。
  bool _modelConfiguring = false;
  bool _followOutput = true;
  bool _userScrolling = false;
  bool _frameQueued = false;
  bool _alignmentRetryQueued = false;
  Timer? _alignmentRetryTimer;
  int _lastRenderedEventCount = 0;
  final ConversationProjection _projection = ConversationProjection();
  Object? _composerSignature;
  Widget? _composerWidget;
  Object? _chromeSignature;
  Widget? _chromeWidget;
  SessionPageMetrics? _pageMetrics;

  @override
  void initState() {
    super.initState();
    _input.addListener(_onInputChanged);
    _scroll.addListener(_onScrollChanged);
    final runtime = ref.read(metricsRuntimeProvider);
    _pageMetrics = SessionPageMetrics(
      runtime.create('client.page', clientPageMetrics),
      sessionId: widget.sessionId,
      eventContext: null,
    );
    WidgetsBinding.instance.addTimingsCallback(_onFrameTimings);
  }

  @override
  void dispose() {
    _input.removeListener(_onInputChanged);
    _input.dispose();
    _composerFocus.dispose();
    _scroll.removeListener(_onScrollChanged);
    _scroll.dispose();
    _alignmentRetryTimer?.cancel();
    _alignmentRetryTimer = null;
    WidgetsBinding.instance.removeTimingsCallback(_onFrameTimings);
    _pageMetrics?.recorder.close();
    super.dispose();
  }

  /// FrameTiming 只代表 Flutter build/raster 阶段，不宣称像素已显示。
  void _onFrameTimings(List<FrameTiming> timings) {
    _pageMetrics?.timings(timings);
  }

  /// 输入变化时刷新主按钮语义（四态之一）。
  void _onInputChanged() {
    if (mounted) setState(() {});
  }

  /// 用户接近底部时才跟随流式输出；主动上滑后保持阅读位置。
  void _onScrollChanged() {
    if (!_scroll.hasClients || _userScrolling) return;
    final distance = _scroll.position.maxScrollExtent - _scroll.position.pixels;
    if (distance <= 1) _followOutput = true;
  }

  /// 用户开始拖动就暂停跟随，只有实际回到底部才恢复，避免小幅上滑被下一 token 抢回。
  bool _onUserScroll(ScrollNotification notification) {
    if (notification is ScrollStartNotification &&
        notification.dragDetails != null) {
      _userScrolling = true;
      _followOutput = false;
    } else if (notification is ScrollEndNotification) {
      _userScrolling = false;
      _onScrollChanged();
    }
    return false;
  }

  /// 同一帧只安排一次底部对齐；执行时再检查用户是否已经上滑。
  void _scheduleOutputFollow(int eventCount) {
    if (eventCount == _lastRenderedEventCount) return;
    _lastRenderedEventCount = eventCount;
    _queueBottomAlignment();
  }

  /// 布局增长和键盘改变共用一次帧尾对齐，避免双层 post-frame 延迟。
  void _queueBottomAlignment() {
    if (_frameQueued) return;
    _frameQueued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _frameQueued = false;
      if (!mounted || !_followOutput || !_scroll.hasClients) return;
      if (_scroll.position.maxScrollExtent <= 0 && !_alignmentRetryQueued) {
        _alignmentRetryQueued = true;
        _alignmentRetryTimer = Timer(const Duration(milliseconds: 16), () {
          _alignmentRetryTimer = null;
          _alignmentRetryQueued = false;
          if (mounted && _followOutput) _queueBottomAlignment();
        });
        return;
      }
      _pageMetrics?.scroll(
        offset: _scroll.position.pixels,
        extent: _scroll.position.maxScrollExtent,
        follow: _followOutput,
      );
      unawaited(
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 90),
          curve: Curves.linear,
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final events = ref.watch(sessionRenderEventsProvider(widget.sessionId));
    _scheduleOutputFollow(events.length);
    final meta = ref.watch(
      sessionsProvider.select((sessions) {
        final session = sessions
            .where((s) => s.id == widget.sessionId)
            .firstOrNull;
        if (session == null) return null;
        // lastSeq/updatedAt 每个 token 都变；输入区和顶栏只依赖这些业务字段。
        return (
          state: session.state,
          model: session.model,
          permissionMode: session.permissionMode,
          agentId: session.agentId,
          cwd: session.cwd,
          createdAt: session.createdAt,
        );
      }),
    );
    final connState = ref.watch(connStateProvider).value ?? ConnState.offline;
    final online =
        connState == ConnState.onlineLan || connState == ConnState.onlineRelay;
    if (online && events.isNotEmpty) {
      // 有事件到达即视为已同步（横幅只在重连期间出现）。
      _lastSyncedAt = DateTime.now().millisecondsSinceEpoch;
    }

    final running = _isRunning(meta?.state);
    final persisted =
        ref
            .watch(outgoingMessageStoreProvider)
            .value
            ?.messagesFor(widget.sessionId)
            .map(
              (message) => SentPrompt(
                clientId: message.clientId,
                text: message.text,
                ts: message.ts,
                status: message.status.name,
              ),
            )
            .toList(growable: false) ??
        const <SentPrompt>[];
    final prompts = <String, SentPrompt>{
      for (final prompt in persisted) prompt.clientId: prompt,
      for (final prompt in _sent) prompt.clientId: prompt,
    }.values.toList(growable: false);
    final projectionStarted = _pageMetrics?.recorder.monotonicMs;
    final view = _projection.update(events, prompts);
    if (projectionStarted != null) {
      _pageMetrics?.recorder.record(
        'client.page.projection',
        _pageMetrics!.recorder.monotonicMs - projectionStarted,
        context: {'sessionId': widget.sessionId},
      );
    }
    final waiting =
        meta?.state == 'waiting_approval' || meta?.state == 'waiting_input';

    // 生成状态由**客户端**决定，不等服务端 init→running 的秒级空窗：
    // - 会话在跑（starting/running，无论回合由谁触发——本机发送、initialPrompt、
    //   通知点进来）；或
    // - 本机刚发送、回合尚未开盘（消息挂在 trailing 等 starting 锚定）——CLI 起帧/
    //   续接的 1-2s 延迟由起势覆盖，发送瞬间即有反馈。
    // 状态只看**当前会话是否仍在生成**：上一回合的输出不压制新回合状态；
    // 会话已死（failed/stopped）、等待用户处理或离线排队中的消息不起势。
    final dead = meta?.state == 'failed' || meta?.state == 'stopped';
    // trailing 非空 = 待开局回合（消息刚发出，必然无输出）；否则由运行态维持尾部状态。
    final showShimmer =
        !dead && !waiting && (running || (online && view.trailing.isNotEmpty));

    final dark = Theme.of(context).brightness == Brightness.dark;
    final permissionOptions = ref.watch(
      permissionOptionsProvider(widget.sessionId),
    );
    final modelOptions = ref.watch(modelOptionsProvider);
    final permissionCeiling = ref
        .watch(agentCapabilitiesProvider)
        .where((agent) => agent.id == meta?.agentId)
        .firstOrNull
        ?.permissionCeiling;
    // 输入框的内部状态由控制器驱动；token 追加不重建输入区。
    final composerSignature = (
      running,
      _queued,
      meta?.model,
      meta?.permissionMode,
      permissionOptions,
      modelOptions,
      permissionCeiling,
      online,
      _modelConfiguring,
    );
    if (_composerWidget == null || composerSignature != _composerSignature) {
      _composerSignature = composerSignature;
      _composerWidget = Composer(
        controller: _input,
        focusNode: _composerFocus,
        running: running,
        queued: _queued,
        model: meta?.model,
        permissionMode: meta?.permissionMode ?? 'default',
        permissionOptions: permissionOptions,
        enabled: online,
        modelEnabled: !_modelConfiguring,
        modelOptions: modelOptions,
        permissionCeiling: permissionCeiling,
        onSend: (text) => _sendText(text),
        onQueue: (text) => _queueText(text),
        onInterrupt: _interrupt,
        onSendQueued: _sendQueuedNow,
        onCancelQueued: _cancelQueued,
        onConfigure: _configure,
      );
    }
    // 事件数最多每秒更新一次；模式/标题/运行状态变化仍立即呈现。
    final chromeSignature = (
      _titleOf(meta?.cwd, view),
      meta?.state,
      meta?.createdAt,
      Theme.of(context),
      MediaQuery.paddingOf(context),
      DateTime.now().millisecondsSinceEpoch ~/ 1000,
    );
    if (_chromeWidget == null || chromeSignature != _chromeSignature) {
      _chromeSignature = chromeSignature;
      _chromeWidget = DecoratedBox(
        key: const ValueKey('session-chrome'),
        decoration: BoxDecoration(
          // 顶栏并入画布色：整页一体的灰面（feedback #20261025-192751-348465
          // 「只有中间是灰色的」），仅以底线区分正文。
          color: ai.canvas,
          border: Border(bottom: BorderSide(color: ai.line)),
        ),
        child: SafeArea(
          bottom: false,
          child: Column(
            children: [
              _SessionHeader(
                title: _titleOf(meta?.cwd, view),
                onBack: () => Navigator.of(context).maybePop(),
                onMore: _interrupt,
              ),
              _StatusLine(
                state: meta?.state,
                durationMs: meta == null
                    ? 0
                    : DateTime.now().millisecondsSinceEpoch - meta.createdAt,
                eventCount: events.length,
              ),
            ],
          ),
        ),
      );
    }
    return AnnotatedRegion<SystemUiOverlayStyle>(
      key: const ValueKey('session-system-overlay'),
      value: SystemUiOverlayStyle(
        statusBarColor: ai.canvas,
        statusBarIconBrightness: dark ? Brightness.light : Brightness.dark,
        statusBarBrightness: dark ? Brightness.dark : Brightness.light,
        systemStatusBarContrastEnforced: false,
      ),
      child: Scaffold(
        backgroundColor: ai.canvas,
        body: Column(
          children: [
            _chromeWidget!,
            if (connState == ConnState.reconnecting ||
                connState == ConnState.offline)
              _ReconnectBanner(lastSyncedAt: _lastSyncedAt),
            Expanded(
              child: ColoredBox(
                color: ai.canvas,
                child: view.isEmpty && !showShimmer
                    ? Center(
                        child: Text(
                          '还没有事件',
                          style: tt.meta.copyWith(color: ai.ink3),
                        ),
                      )
                    : NotificationListener<ScrollMetricsNotification>(
                        onNotification: (notification) {
                          if (notification.metrics is FixedScrollMetrics) {
                            _pageMetrics?.scroll(
                              offset: notification.metrics.pixels,
                              extent: notification.metrics.maxScrollExtent,
                              follow: _followOutput,
                            );
                          }
                          if (_followOutput) _queueBottomAlignment();
                          return false;
                        },
                        child: NotificationListener<ScrollNotification>(
                          onNotification: _onUserScroll,
                          child: SingleChildScrollView(
                            key: const ValueKey('session-timeline-scroll'),
                            controller: _scroll,
                            padding: const EdgeInsets.fromLTRB(
                              AimiSpace.sessionPageH,
                              10,
                              AimiSpace.sessionPageH,
                              20,
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                TimelineView(
                                  view: view,
                                  agentLabel: _agentLabel(meta?.agentId),
                                  pendingRequestId: _pendingPermissionId(
                                    events,
                                  ),
                                  onOpenApproval: (item) =>
                                      _openApprovalSheet(item),
                                  onOpenQuestion: (item) =>
                                      _openQuestionSheet(item),
                                  onTurnFeedback: () =>
                                      unawaited(_openTurnFeedback()),
                                  showShimmer: showShimmer,
                                  // 终态（finished/failed/stopped）才给最后回合挂动作行；
                                  // 历史回合无条件视为已收盘。
                                  settled:
                                      dead ||
                                      meta?.state == 'finished' ||
                                      meta?.state == null,
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
              ),
            ),
            // 等待你时不显示 composer（design.md §3.1：答复在 sheet 上完成）。
            if (!waiting)
              Padding(
                padding: EdgeInsets.fromLTRB(
                  12,
                  6,
                  12,
                  12 + MediaQuery.paddingOf(context).bottom,
                ),
                child: _composerWidget!,
              ),
          ],
        ),
        // 待批/待答 sheet 由事件驱动自动弹出一次（用户关掉后不再骚扰；卡片仍可点开）。
        bottomSheet: null,
      ),
    );
  }

  // ---- 发送与队列 ----

  /// 空闲态直接发送：写入本地回显 + 发帧；失败回填到输入框并提示。
  Future<void> _sendText(String text) async {
    final connection = ref.read(connectionProvider);
    if (!_ensureOnline(connection)) return;
    final prompt = SentPrompt(
      clientId: _uuid.v4(),
      text: text,
      ts: DateTime.now().millisecondsSinceEpoch,
      status: 'sent',
    );
    final store = await ref.read(outgoingMessageStoreProvider.future);
    store.enqueue(
      clientId: prompt.clientId,
      sessionId: widget.sessionId,
      text: prompt.text,
      ts: prompt.ts,
    );
    store.markSent(prompt.clientId);
    setState(() => _sent.add(prompt));
    _scrollToBottom();
    final ack = await connection!.sendCommand(
      widget.sessionId,
      prompt.clientId,
      AgentCommandDto.send(text),
    );
    if (ack == null || ack.status == 'rejected') {
      _markPromptFailed(prompt.clientId);
      _snack('发送失败：服务端没有确认（可重试）');
    }
  }

  /// 运行态发送：进入待发胶囊（不立即执行、不进时间线）。
  void _queueText(String text) {
    final message = OutgoingMessage(
      clientId: _uuid.v4(),
      sessionId: widget.sessionId,
      text: text,
      ts: DateTime.now().millisecondsSinceEpoch,
    );
    setState(() => _queued = message);
  }

  /// 胶囊 ↑：先打断当前回合，再立即发送待发消息。
  Future<void> _sendQueuedNow() async {
    final queued = _queued;
    if (queued == null) return;
    await _interrupt();
    setState(() => _queued = null);
    await _sendText(queued.text);
  }

  /// 胶囊垃圾桶：删除待发消息。
  void _cancelQueued() => setState(() => _queued = null);

  /// 打断：服务端事实先行（stopped 事件由服务端发布）。
  Future<void> _interrupt() async {
    final connection = ref.read(connectionProvider);
    if (!_ensureOnline(connection)) return;
    await connection!.sendCommand(
      widget.sessionId,
      _uuid.v4(),
      const InterruptCommandDto(),
    );
  }

  /// 模型/权限变更：走 configure 帧；成功后立即在本页生效，被拒绝时提示（不静默）。
  Future<void> _configure({String? model, String? permissionMode}) async {
    if (model != null && _modelConfiguring) return;
    final connection = ref.read(connectionProvider);
    if (!_ensureOnline(connection)) return;
    final mirror = ref.read(cacheProvider).value;
    final dynamicPermissions = connection!.supportsDynamicPermissions;
    if (model != null) setState(() => _modelConfiguring = true);
    try {
      final ack = await connection.sendCommand(
        widget.sessionId,
        _uuid.v4(),
        AgentCommandDto.configure(model: model, permissionMode: permissionMode),
      );
      final confirmed = ack?.status == 'delivered';
      if (!confirmed) {
        if (mounted) {
          _snack('设置未确认：未收到成功回执，请检查连接或会话状态');
        }
        return;
      }
      // 命令属于会话：即使用户已离开页面，成功结果仍须进入镜像与持久层。
      mirror?.noteConfigured(
        widget.sessionId,
        model: model,
        permissionMode: dynamicPermissions ? null : permissionMode,
      );
    } finally {
      if (mounted && model != null) {
        setState(() => _modelConfiguring = false);
      }
    }
  }

  /// 审批决策：允许一次 → 总是允许 → 拒绝。
  Future<void> _decide(PermissionTimelineItem item, String decision) async {
    final connection = ref.read(connectionProvider);
    if (!_ensureOnline(connection)) return;
    final ack = await connection!.sendCommand(
      widget.sessionId,
      _uuid.v4(),
      AgentCommandDto.approve(requestId: item.id, decision: decision),
    );
    if (ack == null || ack.status == 'rejected') {
      _snack('审批未生效（可能已失效）');
    }
  }

  /// 提问答复：选项即动作。
  Future<void> _answer(QuestionTimelineItem item, ChoiceDto choice) async {
    final connection = ref.read(connectionProvider);
    if (!_ensureOnline(connection)) return;
    final ack = await connection!.sendCommand(
      widget.sessionId,
      _uuid.v4(),
      AgentCommandDto.answer(questionId: item.id, value: choice.value),
    );
    if (ack == null || ack.status == 'rejected') {
      _snack('回答未生效（可能已失效）');
    }
  }

  // ---- sheet ----

  /// 审批 sheet：标题 + command well（工具名 + mono 命令 + 复制）+ 三文字键。
  Future<void> _openApprovalSheet(PermissionTimelineItem item) async {
    final decision = await showAimiApprovalSheet(context: context, item: item);
    if (decision == null || !mounted) return;
    await _decide(item, decision);
  }

  /// 提问 sheet：与审批同构，选项即动作。
  Future<void> _openQuestionSheet(QuestionTimelineItem item) async {
    final choice = await showAimiQuestionSheet(context: context, item: item);
    if (choice == null || !mounted) return;
    await _answer(item, choice);
  }

  /// 回合反馈弹层（动作行「没帮助」触发）：反馈不阻塞对话，打开即可继续输入。
  Future<void> _openTurnFeedback() async {
    await showAimiTurnFeedbackSheet(context);
  }

  // ---- 辅助 ----

  /// 在线判定（离线时给出明确提示，而不是静默丢弃）。
  bool _ensureOnline(AimiConnection? connection) {
    if (connection == null) {
      _snack('未配置连接：请先完成配对');
      return false;
    }
    final state = ref.read(connStateProvider).value;
    if (state != ConnState.onlineLan && state != ConnState.onlineRelay) {
      _snack('未连接：消息未发出（等连接恢复后再发）');
      return false;
    }
    return true;
  }

  /// 把某个已发起消息标记为失败（时间线里显示「发送失败」）。
  void _markPromptFailed(String clientId) {
    final index = _sent.indexWhere((p) => p.clientId == clientId);
    if (index < 0) return;
    final old = _sent[index];
    setState(() {
      _sent[index] = SentPrompt(
        clientId: old.clientId,
        text: old.text,
        ts: old.ts,
        status: 'failed',
      );
    });
  }

  /// 会话是否运行中（running/starting）。
  static bool _isRunning(String? state) =>
      state == 'running' || state == 'starting';

  /// 最近一次待批请求 id（用于把对应卡片渲染为可点入口）。
  static String? _pendingPermissionId(List<AgentEventDto> events) =>
      (_latestPending(events, 'permission') as PermissionTimelineItem?)?.id;

  /// 取最后一条指定类型的事件并转成领域项（没有则 null）。
  ///
  /// 只服务「当前是否还有一次待决策」这一用途：审批与提问是互斥的会话态，
  /// 因此两类共用一个入口，由 [type] 决定转换结果。
  static TimelineItem? _latestPending(List<AgentEventDto> events, String type) {
    for (var i = events.length - 1; i >= 0; i--) {
      final event = events[i];
      if (event.type != type) continue;
      if (type == 'permission') {
        return PermissionTimelineItem(
          id: event.id ?? '',
          title: event.title ?? '需要审批',
          detail: event.detail ?? '',
          options: event.options ?? const [],
        );
      }
      return QuestionTimelineItem(
        id: event.id ?? '',
        prompt: event.prompt ?? '',
        options: event.choices ?? const [],
      );
    }
    return null;
  }

  /// 会话标题：本机首条提问 → 首条 agent 文本 → 目录名。
  String _titleOf(String? sessionCwd, ConversationView view) {
    for (final prompt in [
      ...view.turns.expand((t) => t.prompts),
      ...view.trailing,
    ]) {
      if (prompt is UserMessageTimelineItem && prompt.text.trim().isNotEmpty) {
        return prompt.text.trim().split('\n').first;
      }
    }
    for (final turn in view.turns) {
      for (final item in turn.items) {
        if (item is TextTimelineItem && item.text.trim().isNotEmpty) {
          return item.text.trim().split('\n').first;
        }
      }
    }
    final cwd = sessionCwd ?? '';
    final name = cwd
        .split(RegExp(r'[\\/]'))
        .where((s) => s.isNotEmpty)
        .lastOrNull;
    return name ??
        widget.sessionId.substring(
          0,
          widget.sessionId.length <= 8 ? widget.sessionId.length : 8,
        );
  }

  /// agent 显示名（回合标签）。
  static String _agentLabel(String? agentId) => switch (agentId) {
    'claude' => 'Claude Code',
    null || '' => 'Agent',
    final other => other,
  };

  /// 滚动到底（新消息/首 token 到达）。
  void _scrollToBottom({bool animate = true}) {
    _followOutput = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      final target = _scroll.position.maxScrollExtent;
      if (animate) {
        _scroll.animateTo(
          target,
          duration: AimiMotion.fast,
          curve: AimiMotion.ease,
        );
      } else {
        _scroll.jumpTo(target);
      }
    });
  }

  /// 统一 SnackBar（浮起胶囊样式由主题提供）。
  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }
}

/// 会话 header（原型 `.session-head`）：返回 + 居中标题 + ⋯。
///
/// 标题单行（15/19 600），不重复 agent 名（agent 在回合标签里）；
/// 高度按用户反馈收紧到 40（feedback #20261025-233103-a30d0e
/// 「和标题的间距太远」，偏离原型的 52），且标题锚底贴近时间行——
/// 见 build 内 Expanded 注释。
class _SessionHeader extends StatelessWidget {
  const _SessionHeader({
    required this.title,
    required this.onBack,
    required this.onMore,
  });

  /// 会话标题（单行截断）。
  final String title;

  /// 返回。
  final VoidCallback onBack;

  /// 右侧「更多」——当前承载打断（原型为 ⋯ 菜单，M1 只保留打断语义）。
  final VoidCallback onMore;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return SizedBox(
      height: AimiSpace.sessionHeadHeight,
      child: DecoratedBox(
        // 与 chrome 同为画布色：header 不再自带更亮的底。
        decoration: BoxDecoration(color: ai.canvas),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(6, 0, 10, 0),
          child: Row(
            children: [
              AimiIconButton(
                icon: AimiIcons.back,
                semanticLabel: '返回',
                onPressed: onBack,
                foreground: ai.ink2,
              ),
              Expanded(
                // 标题锚定 header 底部：时间行本就贴着 chrome 底界，标题若垂直
                // 居中会与时间行隔出 ~12px 空档（feedback #20261025-233103-a30d0e
                // 第二轮「离标题还是很远」）；锚底后标题-时间行空档收窄到 ~5px，
                // 与时间行-底界间隙对称。图标热区 40×40 不受影响。
                child: Align(
                  alignment: Alignment.bottomCenter,
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 3),
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: tt.sessionTitle,
                    ),
                  ),
                ),
              ),
              AimiIconButton(
                icon: AimiIcons.more,
                semanticLabel: '打断',
                onPressed: onMore,
                foreground: ai.ink2,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 会话状态行（原型 `.session-statusline`）：24 高、居中呼吸点 + 事件数。
///
/// 只给点色与机器声计数，不写「运行中/等待你」文字（design.md §2.3）。
class _StatusLine extends StatelessWidget {
  const _StatusLine({
    required this.state,
    required this.eventCount,
    required this.durationMs,
  });

  final String? state;
  final int eventCount;

  /// 会话已持续时长（毫秒）；原型在状态行展示为「N 分钟」。
  final int durationMs;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final (color, animated) = switch (state) {
      'running' || 'starting' => (ai.green, true),
      'waiting_approval' || 'waiting_input' => (ai.amberStrong, true),
      'failed' => (ai.red, false),
      _ => (ai.ink4, false),
    };
    return SizedBox(
      height: AimiSpace.sessionStatusHeight,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (animated)
            AimiBreathingDot(
              color: color,
              size: 5,
              halo: state == 'failed'
                  ? null
                  : (state == 'running' || state == 'starting'
                        ? ai.greenSoft
                        : ai.amberSoft),
            )
          else
            Container(
              width: 5,
              height: 5,
              decoration: BoxDecoration(shape: BoxShape.circle, color: color),
            ),
          const SizedBox(width: 7),
          Text(
            _durationLabel,
            style: tt.micro.copyWith(fontSize: 11, color: ai.ink3),
          ),
          const SizedBox(width: 5),
          Text('·', style: tt.micro.copyWith(fontSize: 11, color: ai.ink4)),
          const SizedBox(width: 5),
          AimiMono(_eventLabel, style: tt.mono, color: ai.ink3),
        ],
      ),
    );
  }

  /// 持续时间文案（原型「12 分钟」）：<1 分钟按「刚刚」，小时级给「N 小时」。
  String get _durationLabel {
    final minutes = durationMs ~/ 60000;
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return '$minutes 分钟';
    return '${minutes ~/ 60} 小时';
  }

  /// 事件数文案（原型用千分位：1,284 事件）。
  String get _eventLabel {
    final digits = eventCount.toString();
    final buffer = StringBuffer();
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 == 0) buffer.write(',');
      buffer.write(digits[i]);
    }
    return '$buffer 事件';
  }
}

/// 断线横幅：琥珀静态条（design.md §2.3「可能卡住/重连」不闪烁）。
class _ReconnectBanner extends StatelessWidget {
  const _ReconnectBanner({this.lastSyncedAt});

  final int? lastSyncedAt;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final suffix = lastSyncedAt == null
        ? ''
        : ' · 上次同步 ${formatClock(lastSyncedAt!)}';
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 6),
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
          Text('正在重连$suffix', style: tt.micro.copyWith(color: ai.amberStrong)),
        ],
      ),
    );
  }
}

/// 审批 sheet：标题 + command well + 三键（允许一次 → 总是允许 → 拒绝）。
///
/// 返回值是 `once` / `always` / `reject`（协议 decision 取值）。
Future<String?> showAimiApprovalSheet({
  required BuildContext context,
  required PermissionTimelineItem item,
}) {
  final (tool, command) = _splitCommand(item);
  return showModalBottomSheet<String>(
    context: context,
    backgroundColor: context.ai.surfaceSolid,
    barrierColor: context.ai.scrim,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: AimiRadius.sheet),
    ),
    isScrollControlled: true,
    builder: (sheetContext) {
      final ai = sheetContext.ai;
      final tt = sheetContext.tt;
      return Padding(
        // 原型 .sheet：padding 8px 18px 22px。
        padding: EdgeInsets.fromLTRB(
          18,
          8,
          18,
          22 + MediaQuery.viewInsetsOf(sheetContext).bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _SheetGrabber(),
            Text('需要你的批准', style: tt.sheetTitle.copyWith(color: ai.ink)),
            const SizedBox(height: AimiSpace.s4),
            // command well：工具头 + mono 命令 + 复制（原型 command-well：12px 圆角、mono 12/19）。
            Container(
              padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
              decoration: BoxDecoration(
                color: ai.codeBg,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      AimiIcon(
                        data: AimiIcons.terminal,
                        size: 13,
                        color: ai.ink3,
                      ),
                      const SizedBox(width: 6),
                      Text(tool, style: tt.micro.copyWith(color: ai.ink3)),
                      const Spacer(),
                      AimiIconButton(
                        icon: AimiIcons.copy,
                        semanticLabel: '复制命令',
                        onPressed: () => copyToClipboard(sheetContext, command),
                        foreground: ai.ink3,
                        boxSize: 28,
                        iconSize: 13,
                        // 原型 .command-well .copy：8px 圆角方块，不是正圆。
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  SelectableText(
                    '\$ $command',
                    style: tt.mono.copyWith(
                      fontSize: 12,
                      height: 19 / 12,
                      color: ai.codeInk,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AimiSpace.s5),
            // 顺序即语义：推荐动作在前，破坏性动作最后。
            _SheetAction(
              label: '允许一次',
              primary: true,
              onTap: () => Navigator.of(sheetContext).pop('once'),
            ),
            const SizedBox(height: AimiSpace.s2),
            _SheetAction(
              label: '总是允许',
              onTap: () => Navigator.of(sheetContext).pop('always'),
            ),
            const SizedBox(height: AimiSpace.s2),
            _SheetAction(
              label: '拒绝',
              danger: true,
              onTap: () => Navigator.of(sheetContext).pop('reject'),
            ),
          ],
        ),
      );
    },
  );
}

/// 提问 sheet：与审批同构；选项即动作（推荐在最前）。
Future<ChoiceDto?> showAimiQuestionSheet({
  required BuildContext context,
  required QuestionTimelineItem item,
}) {
  return showModalBottomSheet<ChoiceDto>(
    context: context,
    backgroundColor: context.ai.surfaceSolid,
    barrierColor: context.ai.scrim,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: AimiRadius.sheet),
    ),
    isScrollControlled: true,
    builder: (sheetContext) {
      final ai = sheetContext.ai;
      final tt = sheetContext.tt;
      return Padding(
        // 原型 .sheet：padding 8px 18px 22px。
        padding: EdgeInsets.fromLTRB(
          18,
          8,
          18,
          22 + MediaQuery.viewInsetsOf(sheetContext).bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _SheetGrabber(),
            Text('需要你的回答', style: tt.sheetTitle.copyWith(color: ai.ink)),
            const SizedBox(height: AimiSpace.s4),
            Text(item.prompt, style: tt.body.copyWith(color: ai.ink)),
            const SizedBox(height: AimiSpace.s5),
            for (var i = 0; i < item.options.length; i++) ...[
              if (i > 0) const SizedBox(height: AimiSpace.s2),
              _SheetAction(
                label: item.options[i].label,
                primary: i == 0,
                onTap: () => Navigator.of(sheetContext).pop(item.options[i]),
              ),
            ],
          ],
        ),
      );
    },
  );
}

/// sheet 动作键：主（ink 底）/ 次（surface-2）/ 危险（红字）。
class _SheetAction extends StatelessWidget {
  const _SheetAction({
    required this.label,
    required this.onTap,
    this.primary = false,
    this.danger = false,
  });

  final String label;
  final VoidCallback onTap;
  final bool primary;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final bg = primary
        ? ai.primaryBtnBg
        : (danger ? Colors.transparent : ai.secondaryBtnBg);
    final fg = primary ? ai.primaryBtnInk : (danger ? ai.red : ai.ink);
    return Semantics(
      button: true,
      label: label,
      child: AimiPressable(
        onTap: onTap,
        scale: 0.992,
        borderRadius: const BorderRadius.all(AimiRadius.pill),
        child: Container(
          height: 50,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: bg,
            borderRadius: const BorderRadius.all(AimiRadius.pill),
          ),
          child: Text(
            label,
            style: tt.meta.copyWith(color: fg, fontWeight: FontWeight.w600),
          ),
        ),
      ),
    );
  }
}

/// 把 permission 项拆成（工具名，命令文本）：服务端 title 形如 "Bash · pnpm build"。
(String, String) _splitCommand(PermissionTimelineItem item) {
  final title = item.title;
  final separator = title.indexOf('·');
  if (separator > 0) {
    return (
      title.substring(0, separator).trim(),
      title.substring(separator + 1).trim(),
    );
  }
  final detail = item.detail.trim();
  return (title, detail.isEmpty ? title : detail);
}

/// sheet 顶部拖拽指示条（原型 `.grabber`：36×4、radius 2、line-strong 底、下距 14）。
class _SheetGrabber extends StatelessWidget {
  const _SheetGrabber();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: 36,
        height: 4,
        margin: const EdgeInsets.only(bottom: 14),
        decoration: BoxDecoration(
          color: context.ai.lineStrong,
          borderRadius: BorderRadius.circular(2),
        ),
      ),
    );
  }
}
