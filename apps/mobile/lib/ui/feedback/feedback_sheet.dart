import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../data/connection/aimi_connection.dart';
import '../../data/feedback/feedback_uploader.dart';

/// 意见反馈弹层（设置页「关于」区入口）：描述 + 截图（≤4 张，Photo Picker 免权限）
/// + 自动附带运行日志 zip（不可关闭，随提交上传）。离线时发送禁用。
///
/// 成功清表单关弹层 + snackbar；失败页内红色文案可重试。表单为本地态
/// （无跨页状态），上传器每次提交从 providers 现取（endpoints/app 信息取读时刻值）。
Future<void> showAimiFeedbackSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: context.ai.surfaceSolid,
    barrierColor: context.ai.scrim,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: AimiRadius.sheet),
    ),
    isScrollControlled: true,
    builder: (sheetContext) => const _FeedbackSheetBody(),
  );
}

class _FeedbackSheetBody extends ConsumerStatefulWidget {
  const _FeedbackSheetBody();

  @override
  ConsumerState<_FeedbackSheetBody> createState() => _FeedbackSheetBodyState();
}

class _FeedbackSheetBodyState extends ConsumerState<_FeedbackSheetBody> {
  final TextEditingController _desc = TextEditingController();
  final List<FeedbackImage> _images = <FeedbackImage>[];

  /// 提交中（禁按钮与选图）。
  bool _submitting = false;

  /// 页内错误文案（不用一次性提示，重试可见）。
  String? _error;

  @override
  void dispose() {
    _desc.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final conn = ref.watch(connStateProvider).value ?? ConnState.offline;
    final online = conn == ConnState.onlineLan || conn == ConnState.onlineRelay;
    final canSend = online && !_submitting && _desc.text.trim().isNotEmpty;

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
            Text('意见反馈', style: tt.sheetTitle.copyWith(color: ai.ink)),
            const SizedBox(height: AimiSpace.s4),
            TextField(
              controller: _desc,
              enabled: !_submitting,
              maxLines: 4,
              minLines: 3,
              maxLength: 4000,
              onChanged: (_) => setState(() {}),
              style: tt.body.copyWith(color: ai.ink),
              decoration: InputDecoration(
                hintText: '描述遇到的问题（做了什么、预期是什么）',
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
            const SizedBox(height: 10),
            Row(
              children: [
                for (final image in _images) _thumb(ai, image),
                if (_images.length < 4 && !_submitting) _addTile(ai),
                const Spacer(),
                Text(
                  '运行日志将自动附带',
                  style: tt.micro.copyWith(color: ai.ink3),
                ),
              ],
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: tt.micro.copyWith(color: ai.red)),
            ],
            const SizedBox(height: AimiSpace.s4),
            SizedBox(
              height: 48,
              child: FilledButton(
                onPressed: canSend ? () => unawaitedSubmit() : null,
                child: Text(
                  _submitting ? '正在提交…' : online ? '提交' : '未连接服务器，连接后可提交',
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 图片缩略图（56 方 + 删除角标）。
  Widget _thumb(AimiColors ai, FeedbackImage image) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Stack(
        children: [
          Container(
            width: 56,
            height: 56,
            clipBehavior: Clip.antiAlias,
            decoration: const BoxDecoration(
              borderRadius: BorderRadius.all(AimiRadius.well),
            ),
            child: Image.file(File(image.path), fit: BoxFit.cover),
          ),
          Positioned(
            top: 0,
            right: 0,
            child: GestureDetector(
              onTap: () => setState(() => _images.remove(image)),
              child: Container(
                width: 18,
                height: 18,
                decoration: BoxDecoration(shape: BoxShape.circle, color: ai.ink),
                child: Icon(Icons.close, size: 12, color: ai.canvas),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 添加图片瓦片：走系统 Photo Picker（Android 13+ 免媒体权限），可多选。
  Widget _addTile(AimiColors ai) {
    return GestureDetector(
      onTap: _pickImages,
      child: Container(
        width: 56,
        height: 56,
        decoration: BoxDecoration(
          color: ai.surface2,
          borderRadius: const BorderRadius.all(AimiRadius.well),
          border: Border.all(color: ai.inputLine),
        ),
        child: Icon(Icons.add, size: 20, color: ai.ink3),
      ),
    );
  }

  /// 选图：一次多选，超出 4 张的部分截断；取消静默返回。
  Future<void> _pickImages() async {
    try {
      final picked = await ImagePicker().pickMultiImage(imageQuality: 80);
      if (picked.isEmpty) return;
      setState(() {
        for (final xfile in picked) {
          if (_images.length >= 4) break;
          _images.add(FeedbackImage(path: xfile.path, name: xfile.name));
        }
      });
    } on Object catch (error) {
      setState(() => _error = '选图失败：$error');
    }
  }

  /// 提交：上传器从 providers 现取（endpoints 变化/未配对为 null）；成功清态关层。
  Future<void> unawaitedSubmit() async {
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
      await uploader.submit(desc: _desc.text.trim(), images: List.of(_images));
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('反馈已提交，谢谢')));
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
