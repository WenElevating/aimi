import 'package:aimi/ui/session/markdown_text.dart';
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
}
