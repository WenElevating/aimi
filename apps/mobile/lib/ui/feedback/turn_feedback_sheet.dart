import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../data/connection/aimi_connection.dart';
import '../../data/feedback/feedback_uploader.dart';
import '../widgets/aimi_primitives.dart';

/// 回合反馈弹层（原型 `#fb-sheet`）：点回合动作行「没帮助」后打开。
///
/// 与设置页「意见反馈」共用 POST /feedback 通道，但表单是回答质量口径：
/// 原因多选（可多勾）+ 可选补充 + 单个提交按钮；运行日志自动附带，
/// 便于还原这一轮回答的现场。反馈不阻塞对话：composer 仍在，可继续发送。
///
/// 提交文案组装为 `[回合反馈] 原因：…；补充：…`，落进服务端反馈目录的
/// desc 字段；离线禁用提交，失败页内红字可重试——与意见反馈同一交互语言。
Future<void> showAimiTurnFeedbackSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: context.ai.surfaceSolid,
    barrierColor: context.ai.scrim,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: AimiRadius.sheet),
    ),
    isScrollControlled: true,
    builder: (sheetContext) => const _TurnFeedbackSheetBody(),
  );
}

/// 回答质量问题的可选原因（原型 2×2 网格的五个勾选项）。
const _turnFeedbackReasons = <String>[
  '答错了',
  '没按要求',
  '代码有问题',
  '卡住',
  '没跑完',
];

/// 组装回合反馈的提交文案（纯函数，UI 与测试共用同一口径）。
///
/// 原因按 [_turnFeedbackReasons] 固定顺序排列（便于服务端检索）；补充可选。
String turnFeedbackDesc(Set<String> reasons, String extra) {
  final ordered =
      _turnFeedbackReasons.where(reasons.contains).toList(growable: false);
  final buffer = StringBuffer('[回合反馈] 原因：${ordered.join('、')}');
  final trimmed = extra.trim();
  if (trimmed.isNotEmpty) buffer.write('；补充：$trimmed');
  return buffer.toString();
}

class _TurnFeedbackSheetBody extends ConsumerStatefulWidget {
  const _TurnFeedbackSheetBody();

  @override
  ConsumerState<_TurnFeedbackSheetBody> createState() =>
      _TurnFeedbackSheetBodyState();
}

class _TurnFeedbackSheetBodyState
    extends ConsumerState<_TurnFeedbackSheetBody> {
  /// 已勾选的原因（多选，无顺序约束；desc 按固定顺序组装便于服务端检索）。
  final Set<String> _reasons = <String>{};

  final TextEditingController _extra = TextEditingController();

  /// 提交中（禁按钮与输入）。
  bool _submitting = false;

  /// 页内错误文案（不用一次性提示，重试可见）。
  String? _error;

  @override
  void dispose() {
    _extra.dispose();
    super.dispose();
  }

  /// 提交按钮可用性：至少勾一个原因，且在线、非提交中。
  bool _canSend(bool online) =>
      online && !_submitting && _reasons.isNotEmpty;

  /// 组装提交文案：委托给顶层纯函数（与测试共用同一口径）。
  String _composeDesc() => turnFeedbackDesc(_reasons, _extra.text);

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final conn = ref.watch(connStateProvider).value ?? ConnState.offline;
    final online = conn == ConnState.onlineLan || conn == ConnState.onlineRelay;

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          20,
          4,
          20,
          20 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('反馈问题', style: tt.sheetTitle.copyWith(color: ai.ink)),
            const SizedBox(height: 2),
            Text('这条回答哪里不对？', style: tt.body.copyWith(color: ai.ink2)),
            const SizedBox(height: AimiSpace.s3),
            // 原因多选：可同时勾多项；选中 ink 底反白（复用外观分段的选中语言）。
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final reason in _turnFeedbackReasons)
                  _reasonChip(ai, tt, reason),
              ],
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _extra,
              enabled: !_submitting,
              maxLines: 3,
              minLines: 2,
              maxLength: 1000,
              style: tt.body.copyWith(color: ai.ink),
              decoration: InputDecoration(
                hintText: '补充说明（可选）',
                hintStyle: tt.body.copyWith(color: ai.ink3),
                filled: true,
                fillColor: ai.inputBg,
                border: OutlineInputBorder(
                  borderRadius: const BorderRadius.all(AimiRadius.well),
                  borderSide: BorderSide(color: ai.inputLine),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: const BorderRadius.all(AimiRadius.well),
                  borderSide: BorderSide(color: ai.inputLine),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: const BorderRadius.all(AimiRadius.well),
                  borderSide: BorderSide(color: ai.lineStrong),
                ),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              '运行日志将自动附带',
              style: tt.micro.copyWith(color: ai.ink3),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: tt.micro.copyWith(color: ai.red)),
            ],
            const SizedBox(height: AimiSpace.s4),
            SizedBox(
              height: 48,
              child: FilledButton(
                onPressed: _canSend(online) ? () => unawaited(_submit()) : null,
                child: Text(
                  _submitting
                      ? '正在提交…'
                      : online
                          ? '提交反馈'
                          : '未连接服务器，连接后可提交',
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 原因 chip：多选 toggle，选中 ink 底 + 画布色文字。
  Widget _reasonChip(AimiColors ai, AimiText tt, String reason) {
    final selected = _reasons.contains(reason);
    return Semantics(
      button: true,
      selected: selected,
      child: AimiPressable(
        onTap: _submitting
            ? null
            : () => setState(() {
                  if (selected) {
                    _reasons.remove(reason);
                  } else {
                    _reasons.add(reason);
                  }
                }),
        borderRadius: const BorderRadius.all(AimiRadius.pill),
        child: Container(
          height: 34,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: selected ? ai.ink : ai.surface2,
            borderRadius: const BorderRadius.all(AimiRadius.pill),
          ),
          child: Text(
            reason,
            style: tt.micro.copyWith(
              color: selected ? ai.canvas : ai.ink2,
            ),
          ),
        ),
      ),
    );
  }

  /// 提交：复用意见反馈的上传器（desc 组装为回合反馈口径，日志自动附带）。
  /// 成功关层 + snackbar；失败页内红字可改后重试。
  Future<void> _submit() async {
    final uploader = ref.read(feedbackUploaderProvider);
    if (uploader == null) {
      setState(() => _error = '尚未配对：请先连接电脑');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await uploader.submit(desc: _composeDesc(), images: const []);
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('已收到反馈，谢谢')));
    } on FeedbackException catch (error) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = error.message;
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = '提交失败（网络或服务端不可达）：$error';
      });
    }
  }
}
