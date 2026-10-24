import 'dart:async';

import 'package:aimi/app/providers.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/feedback/feedback_uploader.dart';
import 'package:aimi/ui/feedback/turn_feedback_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// 泵出反馈 sheet 骨架：connState 与 uploader 走 overrides。
///
/// why 不在 widget 用例里跑真实 submit：`FeedbackUploader.submit` 会打包
/// 日志 zip（真实文件 IO），在测试的 fake async 区永不完成。提交链路的
/// 网络契约由 data 层测试覆盖，这里只验证表单交互与错误呈现。
Future<ProviderContainer> pumpSheet(
  WidgetTester tester, {
  ConnState connState = ConnState.onlineLan,
  FeedbackUploader? uploader,
}) async {
  final container = ProviderContainer(
    overrides: [
      connStateProvider.overrideWith((ref) => Stream.value(connState)),
      feedbackUploaderProvider.overrideWithValue(uploader),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: AimiTheme.light(),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => unawaited(showAimiTurnFeedbackSheet(context)),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return container;
}

void main() {
  test('turnFeedbackDesc：原因按固定顺序排列，补充可选', () {
    // 乱序勾选 → desc 按固定顺序输出（服务端检索口径稳定）。
    expect(
      turnFeedbackDesc({'卡住', '答错了'}, ''),
      '[回合反馈] 原因：答错了、卡住',
    );
    // 补充说明去掉首尾空白后追加。
    expect(
      turnFeedbackDesc({'没按要求'}, '  第一句就跑偏 '),
      '[回合反馈] 原因：没按要求；补充：第一句就跑偏',
    );
    // 全部原因都能按预定义顺序覆盖。
    expect(
      turnFeedbackDesc(
        {'没跑完', '代码有问题', '卡住', '答错了', '没按要求'},
        '',
      ),
      '[回合反馈] 原因：答错了、没按要求、代码有问题、卡住、没跑完',
    );
  });

  testWidgets('打开即见标题、副文案与五个原因 chip；未勾选时提交禁用', (tester) async {
    await pumpSheet(tester);

    expect(find.text('反馈问题'), findsOneWidget);
    expect(find.text('这条回答哪里不对？'), findsOneWidget);
    for (final reason in ['答错了', '没按要求', '代码有问题', '卡住', '没跑完']) {
      expect(find.text(reason), findsOneWidget);
    }
    final button = tester.widget<FilledButton>(
      find.ancestor(of: find.text('提交反馈'), matching: find.byType(FilledButton)),
    );
    expect(button.onPressed, isNull);
  });

  testWidgets('至少勾一个原因后提交可用；可再点一次取消勾选', (tester) async {
    await pumpSheet(tester);

    FilledButton submitButton() => tester.widget<FilledButton>(
      find.ancestor(of: find.text('提交反馈'), matching: find.byType(FilledButton)),
    );
    await tester.tap(find.text('答错了'));
    await tester.pump();
    expect(submitButton().onPressed, isNotNull);

    // 再点一次 = 取消勾选，门控回落为禁用。
    await tester.tap(find.text('答错了'));
    await tester.pump();
    expect(submitButton().onPressed, isNull);
  });

  testWidgets('未配对（无上传器）提交给出页内错误而不是崩溃', (tester) async {
    await pumpSheet(tester, uploader: null);
    await tester.tap(find.text('答错了'));
    await tester.pump();
    await tester.tap(find.text('提交反馈'));
    await tester.pump();
    await tester.pumpAndSettle();
    expect(find.textContaining('尚未配对'), findsOneWidget);
    // sheet 未关闭，可重试。
    expect(find.text('提交反馈'), findsOneWidget);
  });

  testWidgets('离线时提交禁用并提示连接后可提交', (tester) async {
    await pumpSheet(tester, connState: ConnState.offline);
    await tester.tap(find.text('答错了'));
    await tester.pump();
    final button = tester.widget<FilledButton>(
      find.ancestor(
        of: find.text('未连接服务器，连接后可提交'),
        matching: find.byType(FilledButton),
      ),
    );
    expect(button.onPressed, isNull);
  });
}
