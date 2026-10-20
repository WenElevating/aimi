import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/ui/session/composer.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 泵出一个接好回调的 composer（真主题，颜色/字阶来自 token）。
Future<
    ({
      TextEditingController controller,
      List<String> sent,
      List<String> queued,
      List<int> interrupts,
      List<int> cancelQueued,
      List<int> sendQueuedNow,
      List<({String? model, String? permissionMode})> configures,
    })> pumpComposer(
  WidgetTester tester, {
  bool running = false,
  OutgoingMessage? queued,
  String? model,
  String permissionMode = 'default',
}) async {
  final controller = TextEditingController();
  final sent = <String>[];
  final queuedTexts = <String>[];
  final interrupts = <int>[];
  final cancelQueued = <int>[];
  final sendQueuedNow = <int>[];
  final configures = <({String? model, String? permissionMode})>[];

  await tester.pumpWidget(
    MaterialApp(
      theme: AimiTheme.light(),
      home: Scaffold(
        body: Composer(
          controller: controller,
          running: running,
          queued: queued,
          model: model,
          permissionMode: permissionMode,
          onSend: sent.add,
          onQueue: queuedTexts.add,
          onInterrupt: () => interrupts.add(1),
          onSendQueued: () => sendQueuedNow.add(1),
          onCancelQueued: () => cancelQueued.add(1),
          onConfigure: ({String? model, String? permissionMode}) =>
              configures.add((model: model, permissionMode: permissionMode)),
        ),
      ),
    ),
  );
  return (
    controller: controller,
    sent: sent,
    queued: queuedTexts,
    interrupts: interrupts,
    cancelQueued: cancelQueued,
    sendQueuedNow: sendQueuedNow,
    configures: configures,
  );
}

/// 待发消息样本。
OutgoingMessage queuedMessage(String text) => OutgoingMessage(
      clientId: 'c1',
      sessionId: 's1',
      text: text,
      ts: 1,
    );

void main() {
  test('composerModeOf：四态转换（待发消息优先于输入非空）', () {
    expect(composerModeOf(running: true, hasText: false, hasQueued: false), ComposerMode.interrupt);
    expect(
      composerModeOf(running: true, hasText: true, hasQueued: false),
      ComposerMode.sendWhileRunning,
    );
    expect(composerModeOf(running: true, hasText: true, hasQueued: true), ComposerMode.queued);
    expect(composerModeOf(running: false, hasText: true, hasQueued: false), ComposerMode.sendIdle);
    // 空闲态即使有空输入也是发送语义（没有可打断的回合）。
    expect(composerModeOf(running: false, hasText: false, hasQueued: false), ComposerMode.sendIdle);
  });

  testWidgets('空闲 + 输入 → 主按钮是「发送」，点击立即发送并清空输入', (tester) async {
    final h = await pumpComposer(tester);
    await tester.enterText(find.byType(TextField), '跑一下测试');
    await tester.pump();

    expect(find.byTooltip('发送'), findsOneWidget);
    expect(find.byTooltip('打断'), findsNothing);

    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    expect(h.sent, ['跑一下测试']);
    expect(h.queued, isEmpty);
    expect(h.controller.text, isEmpty);
  });

  testWidgets('运行 + 输入为空 → 主按钮是「打断」，点击发打断（不发送）', (tester) async {
    final h = await pumpComposer(tester, running: true);
    expect(find.byTooltip('打断'), findsOneWidget);
    await tester.tap(find.byTooltip('打断'));
    await tester.pump();
    expect(h.interrupts, hasLength(1));
    expect(h.sent, isEmpty);
  });

  testWidgets('运行 + 输入非空 → 主按钮仍是「发送」，点击进入待发胶囊（不立即发送）', (tester) async {
    final h = await pumpComposer(tester, running: true);
    await tester.enterText(find.byType(TextField), '顺便调一下超时');
    await tester.pump();

    expect(find.byTooltip('发送'), findsOneWidget);
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    // 运行中的发送只入队：待发消息不进时间线、也不直接发帧。
    expect(h.queued, ['顺便调一下超时']);
    expect(h.sent, isEmpty);
    expect(h.controller.text, isEmpty);
  });

  testWidgets('有待发消息 → 显示胶囊，主按钮回到「打断」，胶囊两个图标各自生效', (tester) async {
    final h = await pumpComposer(tester, running: true, queued: queuedMessage('待发内容'));
    expect(find.text('待发内容'), findsOneWidget);
    // 主按钮回到打断语义。
    expect(find.byTooltip('打断'), findsOneWidget);

    await tester.tap(find.byTooltip('删除待发消息'));
    await tester.pump();
    expect(h.cancelQueued, hasLength(1));

    await tester.tap(find.byTooltip('打断当前回合并发送'));
    await tester.pump();
    expect(h.sendQueuedNow, hasLength(1));
  });

  testWidgets('模型 chip 与权限钮是两个独立入口，各自打开 picker 并回传 configure', (tester) async {
    final h = await pumpComposer(tester, model: 'sonnet');
    // 收起态只有名字（不写说明）。
    expect(find.text('Sonnet 4.6'), findsOneWidget);

    await tester.tap(find.text('Sonnet 4.6'));
    await tester.pumpAndSettle();
    // 展开：三行名字 + 一行差异。
    expect(find.text('Opus 4.6'), findsOneWidget);
    expect(find.text('最强推理，适合复杂重构'), findsOneWidget);
    expect(find.text('Haiku 4.5'), findsOneWidget);
    await tester.tap(find.text('Haiku 4.5'));
    await tester.pumpAndSettle();
    expect(h.configures, [(model: 'haiku', permissionMode: null)]);

    // 权限入口独立：点权限钮只出三档标签，不含模型。
    await tester.tap(find.byTooltip('权限：每次询问'));
    await tester.pumpAndSettle();
    expect(find.text('每次询问'), findsOneWidget);
    expect(find.text('自动编辑'), findsOneWidget);
    expect(find.text('完全放行'), findsOneWidget);
    expect(find.text('Opus 4.6'), findsNothing);
    await tester.tap(find.text('完全放行'));
    await tester.pumpAndSettle();
    expect(h.configures.last, (model: null, permissionMode: 'bypassPermissions'));
  });

  testWidgets('权限钮字形与底色随档位同步变化（不只靠颜色）', (tester) async {
    await pumpComposer(tester, permissionMode: 'default');
    expect(find.byTooltip('权限：每次询问'), findsOneWidget);
    await pumpComposer(tester, permissionMode: 'acceptEdits');
    expect(find.byTooltip('权限：自动编辑'), findsOneWidget);
    await pumpComposer(tester, permissionMode: 'bypassPermissions');
    expect(find.byTooltip('权限：完全放行'), findsOneWidget);
  });
}
