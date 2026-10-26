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
}
