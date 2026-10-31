import 'package:aimi/app/theme.dart';
import 'package:aimi/data/cache/session_mirror.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/ui/session/composer.dart';
import 'package:aimi/ui/widgets/aimi_primitives.dart';
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
  })
>
pumpComposer(
  WidgetTester tester, {
  bool running = false,
  OutgoingMessage? queued,
  String? model,
  String permissionMode = 'default',
  List<PermissionModeDescriptorDto>? permissionOptions,
  String? permissionCeiling,
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
          permissionOptions: permissionOptions,
          permissionCeiling: permissionCeiling,
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
OutgoingMessage queuedMessage(String text) =>
    OutgoingMessage(clientId: 'c1', sessionId: 's1', text: text, ts: 1);

void main() {
  test('composerModeOf：四态转换（待发消息优先于输入非空）', () {
    expect(
      composerModeOf(running: true, hasText: false, hasQueued: false),
      ComposerMode.interrupt,
    );
    expect(
      composerModeOf(running: true, hasText: true, hasQueued: false),
      ComposerMode.sendWhileRunning,
    );
    expect(
      composerModeOf(running: true, hasText: true, hasQueued: true),
      ComposerMode.queued,
    );
    expect(
      composerModeOf(running: false, hasText: true, hasQueued: false),
      ComposerMode.sendIdle,
    );
    // 空闲态即使有空输入也是发送语义（没有可打断的回合）。
    expect(
      composerModeOf(running: false, hasText: false, hasQueued: false),
      ComposerMode.sendIdle,
    );
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
    final h = await pumpComposer(
      tester,
      running: true,
      queued: queuedMessage('待发内容'),
    );
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
    final h = await pumpComposer(
      tester,
      model: 'sonnet',
      permissionCeiling: 'bypassPermissions',
    );
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
    expect(h.configures.last, (
      model: null,
      permissionMode: 'bypassPermissions',
    ));
  });

  testWidgets('未来 agent 权限显示服务端名称并拒绝不可用选项', (tester) async {
    final h = await pumpComposer(
      tester,
      permissionMode: 'custom',
      permissionOptions: const [
        PermissionModeDescriptorDto(
          id: 'custom',
          name: '工作区内',
          description: '限制到当前目录',
          availability: 'available',
        ),
        PermissionModeDescriptorDto(
          id: 'remote',
          name: '远程执行',
          description: '访问远程服务',
          availability: 'unavailable',
          reason: '服务器策略禁止',
        ),
        PermissionModeDescriptorDto(
          id: 'adaptive',
          name: '自适应',
          description: '由 agent 判断',
          availability: 'unknown',
          reason: '需要 agent 确认',
        ),
      ],
    );
    await tester.tap(find.byTooltip('权限：工作区内'));
    await tester.pumpAndSettle();
    expect(find.text('限制到当前目录'), findsOneWidget);
    expect(find.textContaining('服务器策略禁止'), findsOneWidget);
    await tester.tap(find.text('远程执行'));
    await tester.pump();
    expect(h.configures, isEmpty);
    await tester.tap(find.text('自适应'));
    await tester.pumpAndSettle();
    expect(h.configures.last.permissionMode, 'adaptive');
  });

  testWidgets('旧服务端缺少权限上限时仅显示保守默认项', (tester) async {
    await pumpComposer(tester);
    await tester.tap(find.byTooltip('权限：每次询问'));
    await tester.pumpAndSettle();
    expect(find.text('每次询问'), findsOneWidget);
    expect(find.text('完全放行'), findsNothing);
    expect(find.text('自动编辑'), findsNothing);
  });

  testWidgets('小屏六种权限含说明可滚动，不产生溢出', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(340, 480);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final h = await pumpComposer(
      tester,
      permissionMode: 'mode0',
      permissionOptions: [
        for (var i = 0; i < 6; i++)
          PermissionModeDescriptorDto(
            id: 'mode$i',
            name: '权限$i',
            description: '这是由 agent 提供的模式说明，保留详细含义',
            availability: 'available',
          ),
      ],
    );
    await tester.tap(find.byTooltip('权限：权限0'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.drag(
      find.byType(SingleChildScrollView).last,
      const Offset(0, -400),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('权限5'));
    await tester.pumpAndSettle();
    expect(h.configures.last.permissionMode, 'mode5');
  });

  testWidgets('权限钮字形与底色随档位同步变化（不只靠颜色）', (tester) async {
    await pumpComposer(tester, permissionMode: 'default');
    expect(find.byTooltip('权限：每次询问'), findsOneWidget);
    await pumpComposer(tester, permissionMode: 'acceptEdits');
    expect(find.byTooltip('权限：自动编辑'), findsOneWidget);
    await pumpComposer(tester, permissionMode: 'bypassPermissions');
    expect(find.byTooltip('权限：完全放行'), findsOneWidget);
  });

  testWidgets('输入舱为浅灰平舱（参考图风格）：surface2 底、无描边、无阴影', (tester) async {
    await pumpComposer(tester, queued: queuedMessage('待发内容'));
    final ai = tester.element(find.byType(Composer)).ai;
    // 舱体：浅灰底、透明描边、无阴影——白纸画布上的平舱（原型 composer-flat）。
    // （带底色条件区分主按钮的 24 圆角 pressable 容器。）
    final tray = tester.widget<Container>(
      find.descendant(
        of: find.byType(AimiSurface),
        matching: find.byWidgetPredicate(
          (widget) =>
              widget is Container &&
              widget.decoration is BoxDecoration &&
              (widget.decoration! as BoxDecoration).borderRadius ==
                  const BorderRadius.all(AimiRadius.composer) &&
              (widget.decoration! as BoxDecoration).color != null,
        ),
      ),
    );
    final trayDeco = tray.decoration! as BoxDecoration;
    expect(trayDeco.color, ai.surface2);
    expect((trayDeco.border! as Border).top.color, Colors.transparent);
    expect(trayDeco.boxShadow, isNull);
    // 待发胶囊在灰舱内改白底浮起，不再描边（同色胶囊在灰舱里不可见）。
    final capsuleDeco =
        tester
            .widget<Container>(
              find.ancestor(
                of: find.text('待发内容'),
                matching: find.byWidgetPredicate(
                  (widget) =>
                      widget is Container &&
                      widget.decoration is BoxDecoration &&
                      (widget.decoration! as BoxDecoration).borderRadius ==
                          const BorderRadius.all(AimiRadius.pill),
                ),
              ),
            )
            .decoration!
        as BoxDecoration;
    expect(capsuleDeco.color, ai.surfaceSolid);
    expect(capsuleDeco.border, isNull);
    // 模型 chip 裸文字化：灰舱内不再垫同色 chip 底（参考图即裸文字）。
    final chipDeco =
        tester
            .widget<Container>(
              find.ancestor(
                of: find.text('默认模型'),
                matching: find.byWidgetPredicate(
                  (widget) =>
                      widget is Container &&
                      widget.decoration is BoxDecoration &&
                      (widget.decoration! as BoxDecoration).borderRadius ==
                          const BorderRadius.all(AimiRadius.pill),
                ),
              ),
            )
            .decoration!
        as BoxDecoration;
    expect(chipDeco.color, isNull);
  });

  testWidgets('多供应商模型清单按 provider 分组渲染：组头小字 + 行内不重复供应商名', (tester) async {
    // pumpComposer 不接收 modelOptions——直接改控制器文本无意义；这里手动泵一个
    // 带分组清单的 composer（模型 value 编码 providerId:modelId，group=provider 名）。
    const options = [
      AimiModelOption(name: 'deepseek-v4-flash', detail: '', value: 'p1:deepseek-v4-flash', group: 'deepseek'),
      AimiModelOption(name: 'gpt-5.5', detail: '', value: 'p2:gpt-5.5', group: 'cigar'),
      AimiModelOption(name: 'glm-5.3', detail: '', value: 'p3:glm-5.3', group: 'daapsaak'),
      AimiModelOption(name: 'glm-5.3-flash', detail: '', value: 'p3:glm-5.3-flash', group: 'daapsaak'),
    ];
    await tester.pumpWidget(
      MaterialApp(
        theme: AimiTheme.light(),
        home: Scaffold(
          body: Composer(
            controller: TextEditingController(),
            running: false,
            queued: null,
            model: 'p3:glm-5.3',
            modelOptions: options,
            permissionMode: 'default',
            onSend: (_) {},
            onQueue: (_) {},
            onInterrupt: () {},
            onSendQueued: () {},
            onCancelQueued: () {},
            onConfigure: ({String? model, String? permissionMode}) {},
          ),
        ),
      ),
    );

    // 点模型 chip → 分组 picker：组头按 provider 分段，模型行不重复供应商名。
    await tester.tap(find.text('glm-5.3'));
    await tester.pumpAndSettle();
    expect(find.text('deepseek'), findsOneWidget); // 组头
    expect(find.text('cigar'), findsOneWidget); // 组头
    expect(find.text('daapsaak'), findsOneWidget); // 组头
    expect(find.text('provider: daapsaak'), findsNothing); // 行内不再重复
    expect(find.text('glm-5.3-flash'), findsOneWidget);
    // 选中勾落在当前值（checked 语义由 _PickerRow 的 check 图标承载，此处验证行存在）。
    expect(find.text('gpt-5.5'), findsOneWidget);

    // 选中即关并回传编码值（configure 直达 session/setModel）。
    await tester.tap(find.text('deepseek-v4-flash'));
    await tester.pumpAndSettle();
    expect(find.text('deepseek-v4-flash'), findsNothing); // picker 已关
  });
}
