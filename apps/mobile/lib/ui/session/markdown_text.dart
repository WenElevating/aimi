import 'package:flutter/material.dart';

import '../../app/theme.dart';

/// 当前会话页支持的有限 Markdown 块类型。
enum MarkdownBlockKind { paragraph, heading, bullet, ordered, code }

/// 一段已经完成块级识别的文本，不负责解析行内样式。
class MarkdownBlock {
  /// 创建块；[level] 仅对标题有效，列表层级暂按零处理。
  const MarkdownBlock({
    required this.kind,
    required this.text,
    this.level = 0,
    this.marker,
  });

  final MarkdownBlockKind kind;
  final String text;
  final int level;
  final String? marker;
}

/// 解析会话页需要的 Markdown 子集，未知语法按普通文本保留。
List<MarkdownBlock> parseMarkdownBlocks(String source) {
  final lines = source.replaceAll('\r\n', '\n').split('\n');
  final blocks = <MarkdownBlock>[];
  final codeLines = <String>[];
  var inCode = false;

  void flushCode() {
    if (codeLines.isEmpty) return;
    blocks.add(
      MarkdownBlock(kind: MarkdownBlockKind.code, text: codeLines.join('\n')),
    );
    codeLines.clear();
  }

  for (final line in lines) {
    if (line.trimLeft().startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.add(line);
      continue;
    }
    if (line.trim().isEmpty) continue;

    final heading = RegExp(r'^(#{1,3})\s+(.+)$').firstMatch(line);
    if (heading != null) {
      blocks.add(
        MarkdownBlock(
          kind: MarkdownBlockKind.heading,
          text: heading.group(2)!,
          level: heading.group(1)!.length,
        ),
      );
      continue;
    }
    final bullet = RegExp(r'^\s*[-*+]\s+(.+)$').firstMatch(line);
    if (bullet != null) {
      blocks.add(
        MarkdownBlock(kind: MarkdownBlockKind.bullet, text: bullet.group(1)!),
      );
      continue;
    }
    final ordered = RegExp(r'^\s*(\d+)[.)]\s+(.+)$').firstMatch(line);
    if (ordered != null) {
      blocks.add(
        MarkdownBlock(
          kind: MarkdownBlockKind.ordered,
          text: ordered.group(2)!,
          marker: ordered.group(1),
        ),
      );
      continue;
    }
    blocks.add(MarkdownBlock(kind: MarkdownBlockKind.paragraph, text: line));
  }
  if (inCode) flushCode();
  return blocks;
}

/// 只有检测到块级或行内标记时才切换到富文本树，普通增量保持原 widget 身份。
bool containsMarkdownSyntax(String text) => RegExp(
  r'(^|\n)\s*(#{1,3}\s|[-*+]\s+|\d+[.)]\s+|```)|\*\*|__|`[^`]+`|(?<!\*)\*[^*]+\*(?!\*)',
  multiLine: true,
).hasMatch(text);

/// 列表悬挂缩进列宽：bullet/序号挂在这 22px 前缀列里，正文从同一 x 起排。
const double _listIndentWidth = 22;

/// 相邻块之间的间距（原型右屏节奏）：打破等距墙，让标题承担分节。
///
/// - 下一块是标题：18（标题上方多给一倍空，分节感的主要来源）
/// - 当前块是标题：8（标题下方回归常规）
/// - 相邻两块都是列表项：5（列表内部最紧）
/// - 其余：8（段落 / 列表 / 代码之间）
double markdownBlockGap(MarkdownBlock prev, MarkdownBlock next) {
  if (next.kind == MarkdownBlockKind.heading) return 18;
  if (prev.kind == MarkdownBlockKind.heading) return 8;
  final bothListItems =
      prev.kind != MarkdownBlockKind.code &&
      next.kind != MarkdownBlockKind.code &&
      _isListItem(prev) &&
      _isListItem(next);
  if (bothListItems) return 5;
  return 8;
}

bool _isListItem(MarkdownBlock block) =>
    block.kind == MarkdownBlockKind.bullet ||
    block.kind == MarkdownBlockKind.ordered;

/// 会话正文的轻量 Markdown 渲染器；仅重建当前增量对应的文本块。
class MarkdownText extends StatelessWidget {
  /// 渲染正文，错误文本使用统一错误色但仍保留 Markdown 结构。
  const MarkdownText({super.key, required this.text, this.error = false});

  final String text;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final base = context.tt.agent.copyWith(color: error ? ai.redDeep : ai.ink);
    final blocks = parseMarkdownBlocks(text);
    return SelectionArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var index = 0; index < blocks.length; index++) ...[
            _MarkdownBlockView(block: blocks[index], style: base),
            if (index != blocks.length - 1)
              SizedBox(
                height: markdownBlockGap(blocks[index], blocks[index + 1]),
              ),
          ],
        ],
      ),
    );
  }
}

class _MarkdownBlockView extends StatelessWidget {
  const _MarkdownBlockView({required this.block, required this.style});

  final MarkdownBlock block;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final textStyle = switch (block.kind) {
      MarkdownBlockKind.heading => style.copyWith(
        fontSize: block.level == 1 ? 16.5 : 15.5,
        fontWeight: FontWeight.w600,
        height: 22 / 15.5,
        letterSpacing: -0.012 * 15.5,
      ),
      MarkdownBlockKind.code => style.copyWith(
        fontFamily: 'JetBrainsMono',
        fontSize: 12,
        height: 1.45,
        color: ai.codeInk,
      ),
      _ => style,
    };
    final child = switch (block.kind) {
      // 列表走悬挂缩进：marker 挂在 22px 前缀列，换行对齐文字起点而非符号。
      MarkdownBlockKind.bullet ||
      MarkdownBlockKind.ordered => _ListBlock(
        block: block,
        style: textStyle,
        markerColor: ai.ink2,
      ),
      _ => _RichBlock(text: block.text, style: textStyle),
    };
    if (block.kind != MarkdownBlockKind.code) return child;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: ai.codeBg,
        borderRadius: const BorderRadius.all(Radius.circular(6)),
      ),
      child: child,
    );
  }
}

/// 段落/标题块：单一富文本。
class _RichBlock extends StatelessWidget {
  const _RichBlock({required this.text, required this.style});

  final String text;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    return SelectableText.rich(
      TextSpan(children: _inlineSpans(text, style)),
      style: style,
    );
  }
}

/// 列表块：Row[22px marker 列, Expanded(正文)]——悬挂缩进的几何本体。
class _ListBlock extends StatelessWidget {
  const _ListBlock({
    required this.block,
    required this.style,
    required this.markerColor,
  });

  final MarkdownBlock block;
  final TextStyle style;

  /// marker 弱化成一档灰：符号退后，文字才是内容。
  final Color markerColor;

  @override
  Widget build(BuildContext context) {
    final marker = switch (block.kind) {
      MarkdownBlockKind.ordered => '${block.marker ?? '1'}.',
      _ => '•',
    };
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: _listIndentWidth,
          child: Text(marker, style: style.copyWith(color: markerColor)),
        ),
        Expanded(
          child: SelectableText.rich(
            TextSpan(children: _inlineSpans(block.text, style)),
            style: style,
          ),
        ),
      ],
    );
  }
}

List<InlineSpan> _inlineSpans(String text, TextStyle base) {
  final spans = <InlineSpan>[];
  final pattern = RegExp(
    r'(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_)',
  );
  var cursor = 0;
  for (final match in pattern.allMatches(text)) {
    if (match.start > cursor) {
      spans.add(TextSpan(text: text.substring(cursor, match.start)));
    }
    final token = match.group(0)!;
    if (token.startsWith('**') || token.startsWith('__')) {
      spans.add(
        TextSpan(
          text: token.substring(2, token.length - 2),
          // 加粗一律 600：700 在 CJK 小字号下发黑发闷，600 与标题同灰度。
          style: base.copyWith(fontWeight: FontWeight.w600),
        ),
      );
    } else if (token.startsWith('`')) {
      spans.add(
        TextSpan(
          text: token.substring(1, token.length - 1),
          style: base.copyWith(
            fontFamily: 'JetBrainsMono',
            backgroundColor: base.color?.withValues(alpha: 0.08),
          ),
        ),
      );
    } else {
      spans.add(
        TextSpan(
          text: token.substring(1, token.length - 1),
          style: base.copyWith(fontStyle: FontStyle.italic),
        ),
      );
    }
    cursor = match.end;
  }
  if (cursor < text.length) spans.add(TextSpan(text: text.substring(cursor)));
  if (spans.isEmpty) spans.add(TextSpan(text: text));
  return spans;
}
