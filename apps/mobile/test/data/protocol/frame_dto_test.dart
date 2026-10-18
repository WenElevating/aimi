import 'dart:convert';

import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:flutter_test/flutter_test.dart';

/// 客户端出帧与帧解析器的契约测试：覆盖各类帧的 JSON 形状，以及非法帧一律返回 null。
void main() {
  test('客户端帧：toJson 字段名与 TS 逐字一致（含 resume 恒 null）', () {
    expect(ClientFrameDto.hello(token: 'token-12345678').toJson(), {
      'v': 1,
      'type': 'hello',
      'token': 'token-12345678',
      'resume': null,
    });
    expect(ClientFrameDto.ping(7).toJson(), {'v': 1, 'type': 'ping', 'nonce': 7});
    expect(
      ClientFrameDto.sessionCreate(
        const SessionSpecDto(agentId: 'claude', cwd: r'D:\proj', permissionMode: 'plan'),
      ).toJson(),
      {
        'v': 1,
        'type': 'session.create',
        'spec': {'agentId': 'claude', 'cwd': r'D:\proj', 'permissionMode': 'plan'},
      },
    );
    expect(
      ClientFrameDto.sessionCommand(
        sessionId: 'sess-1',
        clientId: 'client-abcdefgh',
        cmd: AgentCommandDto.send('hi', files: const [
          AttachmentDto(name: 'a.txt', b64: 'aGk='),
        ]),
      ).toJson(),
      {
        'v': 1,
        'type': 'session.command',
        'sessionId': 'sess-1',
        'clientId': 'client-abcdefgh',
        'cmd': {
          'cmd': 'send',
          'text': 'hi',
          'files': [{'name': 'a.txt', 'b64': 'aGk='}],
        },
      },
    );
    expect(AgentCommandDto.interrupt().toJson(), {'cmd': 'interrupt'});
  });

  test('ServerFrameParser：合法帧全部类型化解析', () {
    expect(
      ServerFrameParser.parse({
        'v': 1,
        'type': 'welcome',
        'serverVersion': '0.1.0',
        'sessions': [
          {
            'id': 'sess-1',
            'agentId': 'claude',
            'cwd': r'D:\proj',
            'permissionMode': 'default',
            'state': 'waiting_input',
            'lastSeq': 4,
            'createdAt': 1,
            'updatedAt': 2,
          },
        ],
      }),
      isA<WelcomeFrameDto>()
          .having((f) => f.serverVersion, 'serverVersion', '0.1.0')
          .having((f) => f.sessions.single.lastSeq, 'lastSeq', 4),
    );
    expect(
      ServerFrameParser.parse({'v': 1, 'type': 'pong', 'nonce': 3}),
      isA<PongFrameDto>().having((f) => f.nonce, 'nonce', 3),
    );
    expect(
      ServerFrameParser.parse({'v': 1, 'type': 'bye', 'reason': 'taken_over'}),
      isA<ByeFrameDto>().having((f) => f.reason, 'reason', 'taken_over'),
    );
    expect(
      ServerFrameParser.parse({'v': 1, 'type': 'ack', 'sessionId': 'sess-9'}),
      isA<AckFrameDto>().having((f) => f.sessionId, 'sessionId', 'sess-9'),
    );
    expect(
      ServerFrameParser.parse({
        'v': 1,
        'type': 'error',
        'code': 'session.not_found',
        'message': '没有这个会话',
      }),
      isA<ErrorFrameDto>().having((f) => f.code, 'code', 'session.not_found'),
    );
  });

  test('session.event：解析后 toJson 与 TS 逐字回环一致', () {
    final raw = {
      'v': 1,
      'type': 'session.event',
      'sessionId': 'sess-1',
      'seq': 12,
      'ts': 1700000000000,
      'agentEvent': {
        'type': 'tool_result',
        'id': 't1',
        'ok': false,
        'outputExcerpt': 'boom',
        'exitCode': 1,
      },
    };
    final frame = ServerFrameParser.parse(
      jsonDecode(jsonEncode(raw)) as Map<String, dynamic>,
    ) as SessionEventFrameDto;

    expect(frame.agentEvent.type, 'tool_result');
    expect(frame.agentEvent.ok, isFalse);
    expect(frame.toJson(), raw);
  });

  test('ServerFrameParser：非契约帧一律 null（对齐 zodFrames 宽进严出）', () {
    expect(
      ServerFrameParser.parse({
        'v': 2,
        'type': 'welcome',
        'serverVersion': 'x',
        'sessions': <Object?>[],
      }),
      isNull,
      reason: 'v 必须为 1',
    );
    expect(ServerFrameParser.parse({'v': 1, 'type': 'unknown'}), isNull);
    expect(
      ServerFrameParser.parse({'v': 1, 'type': 'error', 'code': 'made.up', 'message': 'x'}),
      isNull,
      reason: '未知 error code 非契约帧',
    );
    expect(
      ServerFrameParser.parse({
        'v': 1,
        'type': 'session.event',
        'sessionId': 'sess-1',
        'seq': -1,
        'ts': 1,
        'agentEvent': {'type': 'state', 'state': 'running'},
      }),
      isNull,
      reason: 'seq 必须非负',
    );
    expect(
      ServerFrameParser.parse({
        'v': 1,
        'type': 'session.event',
        'sessionId': 'sess-1',
        'seq': 0,
        'ts': 1,
        'agentEvent': {'type': 'state', 'state': 'nonsense'},
      }),
      isNull,
      reason: 'state 取值域与 TS 一致',
    );
    expect(
      ServerFrameParser.parse({
        'v': 1,
        'type': 'welcome',
        'serverVersion': 'x',
        'sessions': [
          {
            'id': 'sess-1',
            'agentId': 'claude',
            'cwd': r'D:\proj',
            'permissionMode': 'bypassPermissions',
            'state': 'running',
            'lastSeq': 0,
            'createdAt': 1,
            'updatedAt': 2,
          },
        ],
      }),
      isNull,
      reason: 'permissionMode 白名单锁死（C3：手机不可升权）',
    );
  });
}
