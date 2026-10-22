import 'package:aimi/app/providers.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/ui/new_session/new_session_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('新建会话聚焦预填目录时全选，并提供清空操作', (tester) async {
    const cwd = r'D:\AiProject\aimi-smoke-sandbox';
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          endpointsProvider.overrideWith((ref) async => null),
          cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
          sessionsProvider.overrideWith(
            (ref) => const [
              SessionMetaDto(
                id: 's1',
                agentId: 'claude',
                cwd: cwd,
                permissionMode: 'default',
                state: 'finished',
                lastSeq: 0,
                createdAt: 1,
                updatedAt: 1,
              ),
            ],
          ),
        ],
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const NewSessionScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 目录预填最近会话的 cwd（mono 井里的第二个 TextField）。
    final cwdField = tester.widget<TextField>(find.byType(TextField).at(1));
    expect(cwdField.controller!.text, cwd);

    // 聚焦即全选：用户接着输入会整体替换，而不是插在路径中间。
    await tester.tap(find.byType(TextField).at(1));
    await tester.pump();
    expect(cwdField.controller!.selection.baseOffset, 0);
    expect(cwdField.controller!.selection.extentOffset, cwd.length);

    // 清除按钮：一键清空，避免残留旧路径。
    await tester.tap(find.byTooltip('清除目录'));
    await tester.pump();
    expect(cwdField.controller!.text, isEmpty);
  });

  testWidgets('新建会话页只决定任务/目录/agent/模型，不含权限与审批', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          endpointsProvider.overrideWith((ref) async => null),
          cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
          sessionsProvider.overrideWith((ref) => const <SessionMetaDto>[]),
        ],
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const NewSessionScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('任务'), findsOneWidget);
    expect(find.text('默认模型'), findsOneWidget);
    expect(find.text('Opus 4.6'), findsNothing);
    expect(find.text('目录'), findsOneWidget);
    expect(find.text('Agent'), findsOneWidget);
    expect(find.text('模型'), findsOneWidget);
    expect(find.text('开始'), findsOneWidget);
    // codex 不可用：置灰 + 斜杠 + 可访问说明（三重编码；标签在 Semantics 节点上）。
    final codexSemantics = tester.widgetList<Semantics>(find.byType(Semantics)).where(
          (widget) => widget.properties.label == 'codex，暂不可用',
        );
    expect(codexSemantics, isNotEmpty);
    expect(codexSemantics.first.properties.enabled, isFalse);
    // 权限档位与审批不应出现在这一层（design.md §2.2）。
    expect(find.text('每次询问'), findsNothing);
    expect(find.text('允许一次'), findsNothing);
  });

  testWidgets('空目录点击开始 → 页内错误提示且不发起创建', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          endpointsProvider.overrideWith((ref) async => null),
          cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
          sessionsProvider.overrideWith((ref) => const <SessionMetaDto>[]),
        ],
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const NewSessionScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('开始'));
    await tester.pumpAndSettle();
    expect(find.text('请先填写目标目录'), findsOneWidget);
  });

  testWidgets('空任务点击开始 → 提示填写目标和期望结果', (tester) async {
    const cwd = r'D:\AiProject\aimi-smoke-sandbox';
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          endpointsProvider.overrideWith((ref) async => null),
          cacheTicksProvider.overrideWith((ref) => const Stream<int>.empty()),
          sessionsProvider.overrideWith(
            (ref) => const [
              SessionMetaDto(
                id: 's1',
                agentId: 'claude',
                cwd: cwd,
                permissionMode: 'default',
                state: 'finished',
                lastSeq: 0,
                createdAt: 1,
                updatedAt: 1,
              ),
            ],
          ),
        ],
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const NewSessionScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('开始'));
    await tester.pumpAndSettle();
    expect(find.text('请描述任务目标和期望结果'), findsOneWidget);
  });
}
