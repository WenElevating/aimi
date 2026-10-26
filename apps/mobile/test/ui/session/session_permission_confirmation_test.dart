import 'dart:async';

import 'package:aimi/app/providers.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/db/persistent_cache.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/ui/session/composer.dart';
import 'package:aimi/ui/session/session_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _modes = [
  PermissionModeDescriptorDto(
    id: 'default',
    name: '逐次确认',
    description: '由用户决定工具执行',
    availability: 'available',
  ),
  PermissionModeDescriptorDto(
    id: 'auto',
    name: '自动评估',
    description: '由 agent 判断风险',
    availability: 'unknown',
  ),
];

/// 模拟 SDK 回退并紧接断线，能力在成功 ACK 的异步 continuation 前已重置。
class _CapabilityResetConnection extends AimiConnection {
  /// 不建立 socket，只控制本次命令的实际结果与连接能力生命周期。
  _CapabilityResetConnection(SessionMirror mirror)
    : super(
        endpoints: const AimiEndpoints(
          host: '127.0.0.1',
          port: 8787,
          token: 'test',
        ),
        cache: mirror,
        channelFactory: (_) => throw StateError('此用例不应创建 socket'),
      ) {
    state = ConnState.onlineLan;
  }

  bool _dynamic = true;
  final List<ConfigureCommandDto> commands = [];

  @override
  bool get supportsDynamicPermissions => _dynamic;

  /// 成功表示 agent 已处理申请，实际生效模式仍以服务端快照为准。
  @override
  Future<CommandAckFrameDto?> sendCommand(
    String sessionId,
    String clientId,
    AgentCommandDto cmd,
  ) async {
    commands.add(cmd as ConfigureCommandDto);
    cache.applyPermissions(
      SessionPermissionsFrameDto(
        sessionId: sessionId,
        currentMode: 'default',
        modes: _modes,
      ),
    );
    _dynamic = false;
    state = ConnState.offline;
    return CommandAckFrameDto(
      sessionId: sessionId,
      clientId: clientId,
      status: 'delivered',
    );
  }
}

/// 按用户真实操作走权限菜单及页面配置回调，避免只测镜像方法掩盖覆盖错误。
void main() {
  testWidgets('申请 auto 后实际回退 default，ACK 前断线不会把申请值写回镜像', (tester) async {
    final cache = SessionMirror();
    cache.noteCreated(
      const SessionMetaDto(
        id: 's1',
        agentId: 'claude',
        cwd: 'C:/project',
        permissionMode: 'default',
        permissionModes: _modes,
        state: 'finished',
        lastSeq: -1,
        createdAt: 1,
        updatedAt: 1,
      ),
    );
    final connection = _CapabilityResetConnection(cache);
    final container = ProviderContainer(
      overrides: [
        cacheProvider.overrideWith((ref) async => cache),
        connectionProvider.overrideWithValue(connection),
        connStateProvider.overrideWith((ref) async* {
          yield ConnState.onlineLan;
          yield* connection.stream;
        }),
        outgoingMessageStoreProvider.overrideWith(
          (ref) => Completer<DriftOutgoingMessageStore>().future,
        ),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(connection.dispose);
    addTearDown(cache.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const SessionScreen(sessionId: 's1'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(connection.supportsDynamicPermissions, isTrue);
    await tester.tap(find.byTooltip('权限：逐次确认'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('自动评估'));
    // 离线横幅有循环状态动效，只推进菜单退出和状态交付所需帧。
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(connection.commands.single.permissionMode, 'auto');
    expect(connection.supportsDynamicPermissions, isFalse);
    expect(cache.session('s1')!.permissionMode, 'default');
    expect(
      tester.widget<Composer>(find.byType(Composer)).permissionMode,
      'default',
    );
    expect(find.byTooltip('权限：逐次确认'), findsOneWidget);
    expect(find.byTooltip('权限：自动评估'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
