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
            if (index != blocks.length - 1) const SizedBox(height: 6),
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
        fontSize: block.level == 1 ? 18 : 16,
        fontWeight: FontWeight.w700,
        height: 1.35,
      ),
      MarkdownBlockKind.code => style.copyWith(
        fontFamily: 'JetBrainsMono',
        fontSize: 12,
        height: 1.45,
        color: ai.codeInk,
      ),
      _ => style,
    };
    final prefix = switch (block.kind) {
      MarkdownBlockKind.bullet => '•  ',
      MarkdownBlockKind.ordered => '${block.marker ?? '1'}.  ',
      _ => '',
    };
    final span = TextSpan(
      style: textStyle,
      children: [
        if (prefix.isNotEmpty) TextSpan(text: prefix),
        ..._inlineSpans(block.text, textStyle),
      ],
    );
    final child = SelectableText.rich(span, style: textStyle);
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
          style: base.copyWith(fontWeight: FontWeight.w700),
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
