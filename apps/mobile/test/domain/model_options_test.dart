import 'package:aimi/app/providers.dart';
import 'package:aimi/data/protocol/frame_dto.dart';
import 'package:aimi/domain/model_options.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// 服务端能力投影是清单唯一入口，兼容回退与原始标识显示使用相同规则。
void main() {
  test('旧服务端和空清单共用兼容项，未知供应商标识不裁剪', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    expect(container.read(modelOptionsProvider), aimiModelOptions);
    container
        .read(serverCapsProvider.notifier)
        .state = const AgentCapabilityDto(
      id: 'claude',
      label: 'Claude',
      permissionCeiling: 'default',
      models: [],
    );
    expect(container.read(modelOptionsProvider), aimiModelOptions);
    expect(modelDisplayName(null, aimiModelOptions), '默认模型');
    expect(
      modelDisplayName('provider/model[variant]', aimiModelOptions),
      'provider/model[variant]',
    );
  });

  test('能力清单刷新后同一标识使用新名称，标识内容保持不变', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    const value = 'vendor-x/custom-model[fast]';
    for (final name in ['自定义名称', '更新后的名称']) {
      container.read(serverCapsProvider.notifier).state = AgentCapabilityDto(
        id: 'claude',
        label: 'Claude',
        permissionCeiling: 'default',
        models: [AgentModelOptionDto(value: value, name: name)],
      );
      final options = container.read(modelOptionsProvider);
      expect(options.single.value, value);
      expect(modelDisplayName(value, options), name);
    }
  });

  test('会话元数据的 CLI 完整 ID 归一化回退到清单友好名', () {
    // 场景：welcome 元数据记的是 CLI 实测 ID（claude-opus-4-6），清单 value 是
    // 短名（opus）。精确匹配 miss 后按归一化包含关系回退，chip 不裸奔工程 ID。
    expect(modelDisplayName('claude-opus-4-6', aimiModelOptions), 'Opus 4.6');
    expect(modelDisplayName('Claude-Sonnet-4-6', aimiModelOptions), 'Sonnet 4.6');
    expect(modelDisplayName('claude-haiku-4-5[20260101]', aimiModelOptions), 'Haiku 4.5');
  });

  test('归一化不误伤：陌生 ID 与多候选时原样或最长匹配', () {
    // 陌生家族的完整 ID 必须原样回显，避免把自定义模型错报成内置名。
    expect(
      modelDisplayName('gemini-2.5-pro', aimiModelOptions),
      'gemini-2.5-pro',
    );
    // 前缀互为包含时取最长命中（如同时存在 opus / opusplan 清单项）。
    const options = <AimiModelOption>[
      AimiModelOption(name: 'Opus Plan', detail: '', value: 'opusplan'),
      AimiModelOption(name: 'Opus 4.6', detail: '', value: 'opus'),
    ];
    expect(modelDisplayName('claude-opusplan-4-6', options), 'Opus Plan');
  });

  test('清单 name 本身是裸 ID 时从 name 提取友好名', () {
    // 实机实测（2026-10-26 探针）：中转站把别名指向的目标 ID 放进 name，
    // value 是短别名（haiku ↔ claude-opus-4-6）。chip 忠实显示 name 就裸奔了。
    const proxy = <AimiModelOption>[
      AimiModelOption(name: 'claude-opus-4-6', detail: 'Custom Haiku model', value: 'haiku'),
      AimiModelOption(name: 'claude-opus-5-5', detail: 'Custom Opus model', value: 'opus'),
      AimiModelOption(name: 'claude-fable-5', detail: 'Custom Fable model', value: 'fable'),
    ];
    expect(modelDisplayName('haiku', proxy), 'Opus 4.6');
    expect(modelDisplayName('opus', proxy), 'Opus 5.5');
    expect(modelDisplayName('fable', proxy), 'Fable 5');
  });

  test('友好 name 不被转换，仅 ID 形 name 才提取', () {
    const friendly = <AimiModelOption>[
      AimiModelOption(name: '自定义名称', detail: '', value: 'vendor-x/custom'),
    ];
    expect(modelDisplayName('vendor-x/custom', friendly), '自定义名称');
    // name 与 value 同值的完整 ID 同样提取；无版本号只大写家族名。
    expect(
      modelDisplayLabel('claude-opus-4-6', 'claude-opus-4-6'),
      'Opus 4.6',
    );
    expect(modelDisplayLabel('opus', 'opus'), 'Opus');
  });
}
