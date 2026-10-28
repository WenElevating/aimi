import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';
import 'composer.dart';

/// 回合动作行（原型 `.msg-actions`）：每轮回答末尾的低对比图标动作。
///
/// 四个动作：复制（带走这一轮的文字＋报错）/ 有帮助 / 没帮助（触发反馈弹层）/
/// 分叉（以本回合所在会话的续接线索新开会话；服务端未声明能力时置灰）。
///
/// 视觉与交互逐字对齐 prototypes/codex/assets/app.css 834-868：
/// 16px 图标、32px 圆形按钮、默认 ink-4 低对比；赞踩互斥，选中后
/// surface-2 底 + ink 色 + 描边加粗，且**留在原地**（不弹窗不消失）。
class TurnActionsRow extends StatefulWidget {
  /// 构建一排回合动作；[onFeedback] 在点「没帮助」时回调（打开反馈弹层）；
  /// [onFork] 在点「分叉」时回调——null 表示服务端未声明分叉能力，按钮置灰。
  const TurnActionsRow({
    super.key,
    required this.turnText,
    required this.onFeedback,
    this.onFork,
  });

  /// 复制动作写入剪贴板的完整文本（整轮文字＋报错）。
  final String turnText;

  /// 点「没帮助」时的回调；null 时踩按钮仅作选中态展示（不出反馈）。
  final VoidCallback? onFeedback;

  /// 点「分叉」时的回调；null = 能力未声明（旧服务端），按钮禁用不响应。
  final VoidCallback? onFork;

  @override
  State<TurnActionsRow> createState() => _TurnActionsRowState();
}

class _TurnActionsRowState extends State<TurnActionsRow> {
  /// 当前按下的评价：null=未评，true=有帮助，false=没帮助（赞踩互斥）。
  bool? _vote;

  /// 动作按钮（原型 `.msg-action`）：32px 圆形、无底色、低对比。
  Widget _action({
    required AimiIconData icon,
    required String label,
    required bool selected,
    required VoidCallback? onTap,
  }) {
    final ai = context.ai;
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      child: AimiPressable(
        onTap: onTap,
        borderRadius: const BorderRadius.all(Radius.circular(16)),
        child: Container(
          width: 32,
          height: 32,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            // 选中态底色 surface-2；未选中透明（原型 background:transparent）。
            color: selected ? ai.surface2 : Colors.transparent,
          ),
          alignment: Alignment.center,
          child: AimiIcon(
            data: icon,
            size: 16,
            // 默认 ink-4 低对比；选中升到 ink 并加粗描边（原型 stroke-width 2）。
            color: selected ? ai.ink : ai.ink4,
            strokeWidth: selected ? 2 : null,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // 原型 .msg-actions：margin -2px 0 0 -7px 向左做视觉补偿，让图标与正文左缘对齐。
    return Padding(
      padding: const EdgeInsets.only(top: 2, left: 7),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _action(
            icon: AimiIcons.copy,
            label: '复制这段回答',
            selected: false,
            // 提示按原型 toast 口径「已复制」，不用 command well 的「命令已复制」。
            onTap: () =>
                copyToClipboard(context, widget.turnText, message: '已复制'),
          ),
          const SizedBox(width: 2),
          _action(
            icon: AimiIcons.thumbUp,
            label: '有帮助',
            selected: _vote == true,
            onTap: () => setState(() => _vote = _vote == true ? null : true),
          ),
          const SizedBox(width: 2),
          _action(
            icon: AimiIcons.thumbDown,
            label: '没帮助，反馈问题',
            selected: _vote == false,
            // 赞踩互斥：踩下先落选中态，再触发反馈弹层（反馈不阻塞对话）。
            onTap: () {
              setState(() => _vote = _vote == false ? null : false);
              widget.onFeedback?.call();
            },
          ),
          const SizedBox(width: 2),
          _action(
            icon: AimiIcons.branch,
            // 能未声明时按钮置灰且不响应（无障碍名称仍保留动作语义）。
            label: widget.onFork == null ? '分叉（电脑端不支持）' : '从这段回答分叉',
            selected: false,
            onTap: widget.onFork,
          ),
        ],
      ),
    );
  }
}

/// 收集一个回合可复制的完整文本：所有 agent 文本项按顺序拼接（含报错文本）。
///
/// 工具卡/思考行不进剪贴板——用户要带走的是"这一轮说了什么"。
String turnCopyText(List<String> agentTexts) =>
    agentTexts.where((text) => text.isNotEmpty).join('\n\n');
