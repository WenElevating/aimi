import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';

/// 设置页公共行/组组件（原型 `.set-group` / `.set-row`）。
///
/// 从 settings_screen 的私有方法提升而来：一级页与两个二级页共用同一套
/// 行形态，保证发丝线分组、行高（48）与字号在两级页面之间一致。
/// 形态清单（design.md §5「设置行」）：标签 + 值 / 开关 / 下拉 / chevron，
/// 禁止卡片套卡片与每行解释小字。

/// 发丝线分组卡：小标题 + 一张卡（行间 1px 发丝线分隔）。
class SettingsGroup extends StatelessWidget {
  /// 构建一个分组；[rows] 内非空白项按序渲染，行间自动插发丝线。
  const SettingsGroup({super.key, required this.title, required this.rows});

  /// 组标题（原型 h2：11.5px / ink-2）。
  final String title;

  /// 组内各行（[SettingsRow]/[SettingsSwitchRow] 等）。
  final List<Widget> rows;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final visible = rows.toList(growable: false);
    return Padding(
      padding: const EdgeInsets.only(bottom: AimiSpace.groupGap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 6),
            child: Text(title, style: context.tt.micro.copyWith(color: ai.ink3)),
          ),
          AimiSurface(
            padding: EdgeInsets.zero,
            // 裁圆角：行按压底是全宽矩形，不裁会顶出卡片 16 圆角。
            child: ClipRRect(
              borderRadius: const BorderRadius.all(AimiRadius.card),
              child: Column(
                children: [
                  for (var i = 0; i < visible.length; i++) ...[
                    if (i > 0) const Divider(height: 1),
                    visible[i],
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 普通行：标签 + 尾部内容；有 [onTap] 时整行可点（触控 ≥48）。
class SettingsRow extends StatelessWidget {
  /// 构建一行；[trailing] 通常为状态值、图标或开关。
  const SettingsRow({
    super.key,
    required this.label,
    required this.trailing,
    this.onTap,
  });

  /// 行标签（左侧主文案）。
  final String label;

  /// 行尾内容（值/图标/开关）。
  final Widget trailing;

  /// 整行点击回调；null 时行不可点（纯展示）。
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final content = Container(
      constraints: const BoxConstraints(minHeight: AimiSpace.setRowHeight),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      child: Row(
        children: [
          Text(label, style: tt.meta.copyWith(color: ai.ink)),
          const Spacer(),
          trailing,
        ],
      ),
    );
    if (onTap == null) return content;
    // surface3 按压底：此前只有 0.995 缩放，48px 行上几乎不可感知。
    return AimiPressable(onTap: onTap, pressedColor: ai.surface3, child: content);
  }
}

/// 开关行：整行是热区，开关本身 `role="switch"`（由 Switch 的 Semantics 提供）。
class SettingsSwitchRow extends StatelessWidget {
  /// 构建一行开关；[onChanged] 为空时开关禁用。
  const SettingsSwitchRow({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
  });

  /// 行标签。
  final String label;

  /// 开关当前值。
  final bool value;

  /// 开关变更回调。
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return AimiPressable(
      onTap: onChanged == null ? null : () => onChanged!(!value),
      pressedColor: ai.surface3,
      child: Container(
        constraints: const BoxConstraints(minHeight: AimiSpace.setRowHeight),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        child: Row(
          children: [
            Text(label, style: tt.meta.copyWith(color: ai.ink)),
            const Spacer(),
            Switch(value: value, onChanged: onChanged),
          ],
        ),
      ),
    );
  }
}

/// 前进 chevron（link row 尾部：进入二级页/动作）。
class SettingsChevron extends StatelessWidget {
  /// 构建一个 13px 右向 chevron（原型 `.set-row .chev`）。
  const SettingsChevron({super.key});

  @override
  Widget build(BuildContext context) =>
      AimiIcon(data: AimiIcons.chevron, size: 13, color: context.ai.ink3);
}

/// 下拉值行尾：当前值 + 旋转 90° 的 chevron（原型 `.chev-down`）。
class SettingsSelectValue extends StatelessWidget {
  /// 构建值文本 + 下 chevron；[value] 为当前选中项的展示文案。
  const SettingsSelectValue({super.key, required this.value});

  /// 当前值文案。
  final String value;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(value, style: tt.row.copyWith(fontSize: 13, color: ai.ink2)),
        const SizedBox(width: 6),
        // chevron 旋转 90° 朝下：选择型行的「展开」暗示（原型 .chev-down）。
        Transform.rotate(
          angle: 3.14159 / 2,
          child: AimiIcon(data: AimiIcons.chevron, size: 13, color: ai.ink3),
        ),
      ],
    );
  }
}
