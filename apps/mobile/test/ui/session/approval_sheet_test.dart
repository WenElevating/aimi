import 'package:aimi/app/theme.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/domain/session_view.dart';
import 'package:aimi/ui/session/session_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 审批项样本（三档动作，顺序由服务端给出）。
PermissionTimelineItem approvalItem() => PermissionTimelineItem(
      id: 'req-1',
      title: 'Bash · pnpm build',
      detail: 'pnpm build',
      options: const [
        ApprovalOptionDto(label: '允许一次', kind: 'once'),
        ApprovalOptionDto(label: '总是允许', kind: 'always'),
        ApprovalOptionDto(label: '拒绝', kind: 'reject'),
      ],
    );

/// 泵出一个按钮，点开后拿到 sheet 的返回值。
Future<void> showApproval(WidgetTester tester, void Function(String?) onResult) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: AimiTheme.light(),
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () async {
                final result = await showAimiApprovalSheet(context: context, item: approvalItem());
                onResult(result);
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('审批 sheet：标题 + command well + 三键按「允许一次 → 总是允许 → 拒绝」排列', (tester) async {
    await showApproval(tester, (_) {});

    expect(find.text('需要你的批准'), findsOneWidget);
    expect(find.text('Bash'), findsOneWidget);
    expect(find.text('\$ pnpm build'), findsOneWidget);

    // 顺序即语义：推荐动作在前、破坏性动作最后。
    final once = tester.getTopLeft(find.text('允许一次')).dy;
    final always = tester.getTopLeft(find.text('总是允许')).dy;
    final reject = tester.getTopLeft(find.text('拒绝')).dy;
    expect(once < always, isTrue);
    expect(always < reject, isTrue);

    // 隐性上下文不写（design.md §3.4）。
    expect(find.textContaining('项目'), findsNothing);
    expect(find.textContaining('工作目录'), findsNothing);
    expect(find.textContaining('批准后将在本机执行'), findsNothing);
  });

  testWidgets('审批 sheet：点三键分别回传 once / always / reject', (tester) async {
    for (final (label, expected) in const [
      ('允许一次', 'once'),
      ('总是允许', 'always'),
      ('拒绝', 'reject'),
    ]) {
      String? result = 'unset';
      await showApproval(tester, (value) => result = value);
      await tester.tap(find.text(label));
      await tester.pumpAndSettle();
      expect(result, expected, reason: label);
    }
  });

  testWidgets('提问 sheet：与审批同构，选项即动作并回传 value', (tester) async {
    ChoiceDto? answer;
    await tester.pumpWidget(
      MaterialApp(
        theme: AimiTheme.light(),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async {
                  answer = await showAimiQuestionSheet(
                    context: context,
                    item: const QuestionTimelineItem(
                      id: 'q1',
                      prompt: '按哪种口径补？',
                      options: [
                        ChoiceDto(label: '单测', value: 'unit'),
                        ChoiceDto(label: '集成测试', value: 'integration'),
                      ],
                    ),
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('需要你的回答'), findsOneWidget);
    expect(find.text('按哪种口径补？'), findsOneWidget);
    await tester.tap(find.text('集成测试'));
    await tester.pumpAndSettle();
    expect(answer?.value, 'integration');
  });
}
