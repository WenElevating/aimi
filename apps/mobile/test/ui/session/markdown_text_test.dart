import 'package:aimi/ui/session/markdown_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parses headings, lists, emphasis, inline code and fenced code', () {
    final blocks = parseMarkdownBlocks('''## 技术选型

- **Flutter** + `Riverpod`
1. 首步
2. 第二步

```ts
const answer = true;
```
''');

    expect(blocks.map((block) => block.kind), [
      MarkdownBlockKind.heading,
      MarkdownBlockKind.bullet,
      MarkdownBlockKind.ordered,
      MarkdownBlockKind.ordered,
      MarkdownBlockKind.code,
    ]);
    expect(blocks[0].text, '技术选型');
    expect(blocks[1].text, '**Flutter** + `Riverpod`');
    expect(blocks[2].text, '首步');
    expect(blocks[2].marker, '1');
    expect(blocks[3].marker, '2');
    expect(blocks[4].text, 'const answer = true;');
  });

  test('keeps unsupported or incomplete markers as visible text', () {
    final blocks = parseMarkdownBlocks('等待 **下一段');

    expect(blocks.single.text, '等待 **下一段');
  });

  test('块级节奏：标题前 18、标题后 8、列表项间 5、其余 8', () {
    final blocks = parseMarkdownBlocks('''第一段

## 小标题

- 项目一
- 项目二

结尾段''');

    expect(
      markdownBlockGap(blocks[0], blocks[1]),
      18,
      reason: '段落 → 标题：标题上方多给一倍空',
    );
    expect(
      markdownBlockGap(blocks[1], blocks[2]),
      8,
      reason: '标题 → 列表：标题下方回归常规',
    );
    expect(
      markdownBlockGap(blocks[2], blocks[3]),
      5,
      reason: '列表项之间最紧',
    );
    expect(
      markdownBlockGap(blocks[3], blocks[4]),
      8,
      reason: '列表 → 段落：常规',
    );
  });

  testWidgets('列表悬挂缩进：换行对齐文字起点而非 bullet', (tester) async {
    const text = '- 通过 WebSocket 实时查看 agent 会话时间线并发送命令创建会话发消息中断等操作';
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MarkdownText(text: text),
        ),
      ),
    );

    // bullet 与正文分列：22px 缩进列挂 marker，正文列从同一 x 起排——
    // 换行后的第二行落在正文列左缘（悬挂缩进），不再顶到 bullet 下方。
    final bulletCenter = tester.getCenter(find.text('•'));
    final bodyLeft = tester.getTopLeft(find.textContaining('通过 WebSocket')).dx;
    expect(bulletCenter.dx, lessThan(bodyLeft));
    expect(bodyLeft, 22.0);
  });

  testWidgets('标题与行内加粗收敛到 w600', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MarkdownText(text: '## 核心组成\n\n**Flutter** 移动端'),
        ),
      ),
    );

    // SelectableText 的富文本树最终挂在 RenderEditable.text 上：
    // 标题块是单样式，加粗块是「加粗 span + 普通 span」的组合。
    RenderEditable renderEditableOf(TextEditingController c) {
      final editable = tester.widgetList<EditableText>(
        find.byType(EditableText),
      ).firstWhere((e) => e.controller == c);
      final state = tester.state<EditableTextState>(
        find.byWidget(editable),
      );
      return state.renderEditable;
    }

    final renders = tester.widgetList<EditableText>(
      find.byType(EditableText),
    ).map((e) => e.controller).map(renderEditableOf).toList();
    expect(renders.length, 2);

    TextSpan spanOf(RenderEditable render) => render.text! as TextSpan;
    final heading = spanOf(renders[0]);
    expect(heading.toPlainText(), '核心组成');
    expect(heading.style?.fontWeight, FontWeight.w600);

    final boldBlock = spanOf(renders[1]);
    expect(boldBlock.toPlainText(), 'Flutter 移动端');
    // _inlineSpans 的树：根(无样式) → 块 span → 加粗/普通叶子；取含 Flutter 的叶子。
    final leaves = <TextSpan>[];
    void walk(InlineSpan span) {
      if (span is TextSpan) {
        if (span.text != null) leaves.add(span);
        span.children?.forEach(walk);
      }
    }

    boldBlock.children?.forEach(walk);
    final boldSpan = leaves.firstWhere((s) => s.text == 'Flutter');
    // 标题与加粗同一字重灰度；加粗 700 在 CJK 小字号下发黑发闷。
    expect(boldSpan.style?.fontWeight, FontWeight.w600);
  });
}
