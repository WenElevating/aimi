import 'package:aimi/app/providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:flutter_test/flutter_test.dart';

/// Agent 权限标识保持不透明，由服务端能力描述决定展示。
void main() {
  test('会话权限快照保留自定义模式并更新权威镜像', () {
    final parsed = ServerFrameParser.parse({
      'v': 1,
      'type': 'session.permissions',
      'sessionId': 's1',
      'currentMode': 'workspaceOnly',
      'modes': [
        {
          'id': 'workspaceOnly',
          'name': '工作区内',
          'description': '仅修改工作区',
          'availability': 'available',
        },
      ],
    });
    expect(parsed, isA<SessionPermissionsFrameDto>());
    final frame = parsed! as SessionPermissionsFrameDto;
    final cache = SessionMirror();
    addTearDown(cache.dispose);
    cache.noteCreated(
      const SessionMetaDto(
        id: 's1',
        agentId: 'custom',
        cwd: '/',
        permissionMode: 'default',
        state: 'running',
        lastSeq: -1,
        createdAt: 1,
        updatedAt: 1,
      ),
    );
    cache.applyPermissions(frame);
    expect(cache.session('s1')!.permissionMode, 'workspaceOnly');
    expect(cache.session('s1')!.permissionModes!.single.name, '工作区内');
    expect(cache.eventsFor('s1'), isEmpty);
  });

  test('创建回执前到达的权限快照在本机会话写入后仍保留', () {
    final cache = SessionMirror();
    addTearDown(cache.dispose);
    cache.applyPermissions(
      const SessionPermissionsFrameDto(
        sessionId: 'early',
        currentMode: 'plan',
        modes: [],
      ),
    );
    cache.noteCreated(
      const SessionMetaDto(
        id: 'early',
        agentId: 'claude',
        cwd: '/',
        permissionMode: 'default',
        state: 'starting',
        lastSeq: -1,
        createdAt: 1,
        updatedAt: 1,
      ),
    );
    expect(cache.session('early')!.permissionMode, 'plan');
  });

  test('权限目录依据会话 agentId 而不是全局 Claude 能力', () async {
    final cache = SessionMirror();
    addTearDown(cache.dispose);
    cache.noteCreated(
      const SessionMetaDto(
        id: 'custom-session',
        agentId: 'custom',
        cwd: '/',
        permissionMode: 'workspaceOnly',
        state: 'running',
        lastSeq: -1,
        createdAt: 1,
        updatedAt: 1,
      ),
    );
    const customMode = PermissionModeDescriptorDto(
      id: 'workspaceOnly',
      name: '工作区模式',
      description: '自定义 agent',
      availability: 'available',
    );
    final container = ProviderContainer(
      overrides: [
        cacheProvider.overrideWith((ref) async => cache),
        cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
        agentCapabilitiesProvider.overrideWith(
          (ref) => const [
            AgentCapabilityDto(
              id: 'claude',
              label: 'Claude',
              permissionCeiling: 'default',
              models: [],
              permissionModes: [],
            ),
            AgentCapabilityDto(
              id: 'custom',
              label: 'Custom',
              permissionCeiling: 'workspaceOnly',
              models: [],
              permissionModes: [customMode],
            ),
          ],
        ),
      ],
    );
    addTearDown(container.dispose);
    await container.read(cacheProvider.future);
    expect(
      container.read(permissionOptionsProvider('custom-session'))!.single.id,
      'workspaceOnly',
    );
  });

  test('描述拒绝未知可用状态，接受未来 agent 模式', () {
    final meta = SessionMetaDto.fromJson({
      'id': 's1',
      'agentId': 'future',
      'cwd': '/',
      'permissionMode': 'custom-mode',
      'state': 'running',
      'lastSeq': 1,
      'createdAt': 1,
      'updatedAt': 1,
    });
    expect(meta.permissionMode, 'custom-mode');
    expect(
      () => PermissionModeDescriptorDto.fromJson({
        'id': 'mode',
        'name': '模式',
        'description': '',
        'availability': 'maybe',
      }),
      throwsFormatException,
    );
  });
}
