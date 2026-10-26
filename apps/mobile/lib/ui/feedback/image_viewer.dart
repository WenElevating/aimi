import 'dart:io';

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';

/// 全屏图片查看器（实机反馈 20261025-142036：反馈上传的图片希望能点开放大）。
///
/// 黑底 + InteractiveViewer（捏合缩放/平移）+ PageView 左右切换；顶部关闭钮
/// 与「n/N」计数，通过顶部关闭钮退出。
Future<void> showAimiImageViewer(
  BuildContext context, {
  required List<String> paths,
  int initialIndex = 0,
}) {
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: false,
    barrierLabel: '查看图片',
    barrierColor: Colors.black,
    transitionDuration: AimiMotion.fast,
    pageBuilder: (dialogContext, _, _) => _ImageViewerBody(
      paths: paths,
      initialIndex: initialIndex.clamp(0, paths.isEmpty ? 0 : paths.length - 1),
    ),
    transitionBuilder: (dialogContext, animation, _, child) =>
        FadeTransition(opacity: animation, child: child),
  );
}

/// 查看器内容：计数头 + 可滑动缩放的图片页。
class _ImageViewerBody extends StatefulWidget {
  /// 保留打开时的图片列表与起始页，翻页状态由内部维护。
  const _ImageViewerBody({required this.paths, required this.initialIndex});

  final List<String> paths;
  final int initialIndex;

  /// 每次打开查看器建立独立的页码和缩放状态。
  @override
  State<_ImageViewerBody> createState() => _ImageViewerBodyState();
}

class _ImageViewerBodyState extends State<_ImageViewerBody> {
  late final PageController _page = PageController(
    initialPage: widget.initialIndex,
  );

  /// 当前页（计数显示用）；PageView 翻页中途即更新，与原型口径一致。
  late int _current = widget.initialIndex;

  /// 退出查看器时释放翻页控制器。
  @override
  void dispose() {
    _page.dispose();
    super.dispose();
  }

  /// 黑色画布承载图片页，顶部保留退出入口与当前页码。
  @override
  Widget build(BuildContext context) {
    final tt = context.tt;
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 16, 4),
              child: Row(
                children: [
                  AimiIconButton(
                    icon: AimiIcons.close,
                    semanticLabel: '关闭',
                    onPressed: () => Navigator.of(context).pop(),
                    foreground: Colors.white,
                  ),
                  const Spacer(),
                  Text(
                    '${_current + 1}/${widget.paths.length}',
                    style: tt.mono.copyWith(color: Colors.white70),
                  ),
                ],
              ),
            ),
            Expanded(
              child: PageView.builder(
                controller: _page,
                itemCount: widget.paths.length,
                onPageChanged: (index) => setState(() => _current = index),
                itemBuilder: (pageContext, index) => _ViewerPage(
                  path: widget.paths[index],
                  // 反馈图最多 4 张，按列表顺序线性翻页，不循环。
                ),
              ),
            ),
            const SizedBox(height: AimiSpace.s2),
          ],
        ),
      ),
    );
  }
}

/// 单页图片：捏合缩放（maxScale 4）与拖动平移都由 InteractiveViewer 承担。
class _ViewerPage extends StatelessWidget {
  /// 原始文件路径用于读图，加载失败时在同一页显示占位。
  const _ViewerPage({required this.path});

  final String path;

  /// 允许缩放和平移，缺失或损坏的图片使用黑底可见的失败占位。
  @override
  Widget build(BuildContext context) {
    final tt = context.tt;
    // 查看器始终使用黑底，失败占位不能跟随外层浅色主题切成黑色。
    const dim = Colors.white70;
    return InteractiveViewer(
      maxScale: 4,
      child: Center(
        child: Image.file(
          File(path),
          fit: BoxFit.contain,
          errorBuilder: (context, error, stack) => Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              AimiIcon(data: AimiIcons.doc, size: 32, color: dim),
              const SizedBox(height: 8),
              Text('图片加载失败', style: tt.micro.copyWith(color: dim)),
            ],
          ),
        ),
      ),
    );
  }
}
