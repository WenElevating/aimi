import '../data/protocol/frame_dto.dart';

/// 服务端模型清单的展示项；标识和名称保持供应商原值，不推断模型家族。
class AimiModelOption {
  /// [value] 原样传入创建和配置命令；null 表示未指定模型。
  const AimiModelOption({required this.name, required this.detail, this.value});

  final String name;
  final String detail;
  final String? value;
}

/// 旧服务端缺少模型清单时使用的兼容项，由共享 provider 统一选用。
const List<AimiModelOption> aimiModelOptions = <AimiModelOption>[
  AimiModelOption(name: 'Opus 4.6', detail: '最强推理，适合复杂重构', value: 'opus'),
  AimiModelOption(name: 'Sonnet 4.6', detail: '均衡，适合多数任务', value: 'sonnet'),
  AimiModelOption(name: 'Haiku 4.5', detail: '最快，适合小改动', value: 'haiku'),
];

/// 将服务端清单投影为控件选项；缺失或空清单统一回退兼容项。
List<AimiModelOption> modelOptionsFromCaps(List<AgentModelOptionDto>? models) {
  if (models == null || models.isEmpty) return aimiModelOptions;
  return <AimiModelOption>[
    for (final model in models)
      AimiModelOption(
        name: model.name,
        detail: model.detail ?? '',
        value: model.value,
      ),
  ];
}

/// 使用服务端名称；未知标识完整展示，避免将自定义值误报为默认模型。
String modelDisplayName(String? value, List<AimiModelOption> options) {
  if (value == null || value.isEmpty) return '默认模型';
  for (final option in options) {
    if (option.value == value) return option.name;
  }
  return value;
}
