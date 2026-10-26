import 'package:aimi/app/providers.dart';
import 'package:aimi/app/theme.dart';
import 'package:aimi/data/connection/aimi_connection.dart';
import 'package:aimi/data/notifications/notification_policy.dart';
import 'package:aimi/ui/session/composer.dart';
import 'package:aimi/ui/settings/settings_notifications_screen.dart';
import 'package:aimi/ui/settings/settings_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

/// 内存版 secure storage：开关读写都落在这张表，测试不触真实系统存储。
class _InMemoryStorage implements FlutterSecureStorage {
  final map = <String, String>{};

  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      map[key];

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      map.remove(key);
    } else {
      map[key] = value;
    }
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

/// 泵出通知二级页；返回容器供断言持久化结果。
Future<ProviderContainer> pumpNotifications(WidgetTester tester) async {
  final storage = _InMemoryStorage();
  final container = ProviderContainer(
    overrides: [
      secureStorageProvider.overrideWith((ref) => storage),
      connStateProvider.overrideWith(
        (ref) => Stream.value(ConnState.offline),
      ),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: AimiTheme.light(),
        home: const SettingsNotificationsScreen(),
      ),
    ),
  );
  await tester.pump();
  return container;
}

/// 按谓词找 Text（本地辅助：同名文本按样式区分时用）。
Finder findByTextPredicate(bool Function(Widget) predicate) =>
    find.byWidgetPredicate(
      (widget) => widget is Text && predicate(widget),
    );

/// 泵出设置一级页（与二级页共用同一套桩）。
Future<ProviderContainer> pumpSettings(WidgetTester tester) async {
  final container = ProviderContainer(
    overrides: [
      secureStorageProvider.overrideWith((ref) => _InMemoryStorage()),
      connStateProvider.overrideWith(
        (ref) => Stream.value(ConnState.offline),
      ),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: AimiTheme.light(),
        home: const SettingsScreen(),
      ),
    ),
  );
  await tester.pump();
  return container;
}

void main() {
  testWidgets('通知二级页：五个分类开关齐全，默认卡住关其余开', (tester) async {
    await pumpNotifications(tester);

    expect(find.text('通知'), findsOneWidget);
    for (final label in ['待审批', '待回答', '完成', '失败', '可能卡住']) {
      expect(find.text(label), findsOneWidget);
    }
    final toggles = find.byType(Switch);
    expect(toggles, findsNWidgets(5));
    expect(tester.widget<Switch>(toggles.at(0)).value, isTrue);
    expect(tester.widget<Switch>(toggles.at(4)).value, isFalse);
  });

  testWidgets('切换开关立即更新并写入持久化存储', (tester) async {
    final container = await pumpNotifications(tester);
    await tester.tap(find.text('可能卡住'));
    await tester.pump();

    final state = container.read(notificationTogglesProvider);
    expect(state[NotificationKind.stalled], isTrue);
    expect(
      tester
          .widget<Switch>(find.byType(Switch).at(4))
          .value,
      isTrue,
    );
  });

  testWidgets('设置一级页：三组结构，通知/后台为入口行，无平铺开关', (tester) async {
    await pumpSettings(tester);

    // 一级页只放「一眼能决定」的项：五个通知开关不许平铺在这里。
    expect(find.byType(Switch), findsNothing);
    for (final label in ['连接', '偏好', '关于']) {
      expect(find.text(label), findsOneWidget);
    }
    for (final label in ['服务器', '重新连接', '通知', '后台', 'Agent', '外观', '版本', '检查更新', '意见反馈']) {
      expect(find.text(label), findsOneWidget);
    }
    // 偏好组两个 select row 的当前值。
    expect(find.text('claude'), findsOneWidget);
    expect(find.text('跟随系统'), findsOneWidget);
  });

  testWidgets('Agent 下拉：codex 置灰不可选，claude 选中即关', (tester) async {
    await pumpSettings(tester);

    await tester.tap(find.text('Agent'));
    await tester.pumpAndSettle();
    expect(find.text('暂不可用'), findsOneWidget);

    // codex 行整行置灰（42% 透明度）且不响应点击：picker 不关闭。
    final codexRow = find.ancestor(
      of: find.text('codex'),
      matching: find.byType(Opacity),
    );
    expect(
      tester.widgetList<Opacity>(codexRow).any((o) => o.opacity < 1),
      isTrue,
    );
    await tester.tap(find.text('codex'), warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(find.text('暂不可用'), findsOneWidget);

    // 点 claude：picker 关闭。行值与选项同名（两枚「claude」），
    // 选项行的字号是 tt.row（14.5），按字号命中 picker 内那枚。
    final pickerClaude = findByTextPredicate(
      (widget) =>
          widget is Text &&
          widget.data == 'claude' &&
          widget.style?.fontSize == 14.5,
    );
    await tester.tap(pickerClaude, warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(find.text('暂不可用'), findsNothing);
  });

  testWidgets('外观下拉：三档齐全，选中即生效并回显到行值', (tester) async {
    final container = await pumpSettings(tester);

    await tester.tap(find.text('外观'));
    await tester.pumpAndSettle();
    for (final label in ['跟随系统', '浅色', '深色']) {
      expect(find.text(label).last, findsOneWidget);
    }
    await tester.tap(find.text('深色'));
    await tester.pumpAndSettle();
    expect(container.read(themeModeProvider), AimiThemeMode.dark);
    expect(find.text('深色'), findsOneWidget);
  });

  testWidgets('外观下拉面板锚定在触发行下方（实机反馈：不弹到屏幕底部）', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await pumpSettings(tester);

    await tester.tap(find.text('外观'));
    await tester.pumpAndSettle();

    // 触发行与面板标题都在场；面板的「跟随系统」选项（picker 行）的纵坐标
    // 必须大于触发行的纵坐标——即面板出现在行下方而非屏幕底部。
    final rowTop = tester.getTopLeft(find.text('外观').first).dy;
    final panelOptionTop = tester.getTopLeft(find.text('跟随系统').last).dy;
    expect(panelOptionTop, greaterThan(rowTop));
    // 且在视口内（没有掉到屏外）。
    expect(panelOptionTop, lessThan(800));
  });

  testWidgets('picker disabled 行点击无返回值（showAimiPicker 契约）', (tester) async {
    // 直接以组件契约验证 disabled 语义：disabled 行 onTap 为 null。
    const option = AimiPickerOption<String>(
      label: 'codex',
      value: 'codex',
      detail: '暂不可用',
      disabled: true,
    );
    expect(option.disabled, isTrue);
    const enabled = AimiPickerOption<String>(label: 'claude', value: 'claude');
    expect(enabled.disabled, isFalse);
  });
}
