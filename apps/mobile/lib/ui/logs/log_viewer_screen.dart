import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../data/logging/aimi_logger.dart';
import '../icons/aimi_icons.dart';
import '../../data/logging/log_export.dart';
import '../widgets/aimi_primitives.dart';

/// 运行日志页（设置页「关于」区入口）：实时展示内存环内容，支持级别过滤
/// 与 zip 导出（分享面板）。排查路径：打开本页看轨迹 → 导出 zip 传电脑。
class LogViewerScreen extends ConsumerStatefulWidget {
  /// 日志查看页（路由 `/logs`）；[logger] 测试注入用，缺省全局单例。
  const LogViewerScreen({super.key, this.logger});

  final AimiLogger? logger;

  @override
  ConsumerState<LogViewerScreen> createState() => _LogViewerScreenState();
}

class _LogViewerScreenState extends ConsumerState<LogViewerScreen> {
  /// 级别过滤：null = 全部。
  AimiLogLevel? _filter;

  /// 正在导出（禁按钮防重复）。
  bool _exporting = false;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    final logger = widget.logger ?? AimiLogger.instance;
    final entries = logger
        .snapshot()
        .where((e) => _filter == null || e.level == _filter)
        .toList(growable: false);
    final lastActive = entries.isEmpty ? null : entries.last.ts;

    return Scaffold(
      backgroundColor: ai.canvas,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 6, 16, 8),
              child: Row(
                children: [
                  AimiIconButton(
                    icon: AimiIcons.back,
                    semanticLabel: '返回',
                    onPressed: () => context.canPop() ? context.pop() : null,
                    foreground: ai.ink2,
                  ),
                  Expanded(child: Text('运行日志', style: tt.title)),
                  TextButton(
                    onPressed: _exporting ? null : () => _export(logger),
                    child: Text(_exporting ? '打包中…' : '导出 zip'),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
              child: Row(
                children: [
                  for (final level in AimiLogLevel.values) ...[
                    _levelChip(level),
                    const SizedBox(width: 6),
                  ],
                  const Spacer(),
                  if (lastActive != null)
                    Text(
                      '最近活动 ${_clock(lastActive)}',
                      style: tt.micro.copyWith(color: ai.ink3),
                    ),
                ],
              ),
            ),
            Expanded(
              child: AimiPageBackground(
                child: entries.isEmpty
                    ? Center(
                        child: Text('暂无日志', style: tt.meta.copyWith(color: ai.ink3)),
                      )
                    : ListView.builder(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                        itemCount: entries.length,
                        itemBuilder: (context, index) {
                          final entry = entries[index];
                          return Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: Text(
                              entry.formatLine(),
                              style: tt.mono.copyWith(
                                fontSize: 10.5,
                                color: switch (entry.level) {
                                  AimiLogLevel.error => ai.red,
                                  AimiLogLevel.warn => ai.amberStrong,
                                  AimiLogLevel.debug => ai.ink3,
                                  AimiLogLevel.info => ai.ink2,
                                },
                              ),
                            ),
                          );
                        },
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 级别过滤 chip；选中态反色。
  Widget _levelChip(AimiLogLevel level) {
    final ai = context.ai;
    final tt = context.tt;
    final selected = _filter == level;
    return AimiPressable(
      onTap: () => setState(() => _filter = selected ? null : level),
      borderRadius: const BorderRadius.all(AimiRadius.pill),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: selected ? ai.ink : ai.surface2,
          borderRadius: const BorderRadius.all(AimiRadius.pill),
        ),
        child: Text(
          level.name,
          style: tt.micro.copyWith(color: selected ? ai.canvas : ai.ink2),
        ),
      ),
    );
  }

  /// 导出：打包 zip → 系统分享面板；失败以 snackbar 呈现（用户主动动作要可见）。
  Future<void> _export(AimiLogger logger) async {
    setState(() => _exporting = true);
    try {
      final exporter = LogExporter(logger);
      final zip = await exporter.exportZip();
      await exporter.share(zip);
    } on Object catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text('导出失败：$error')));
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  /// 时钟文本（HH:mm:ss）。
  String _clock(int ts) {
    final t = DateTime.fromMillisecondsSinceEpoch(ts);
    String two(int v) => v.toString().padLeft(2, '0');
    return '${two(t.hour)}:${two(t.minute)}:${two(t.second)}';
  }
}
