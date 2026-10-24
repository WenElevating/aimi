import 'package:aimi/app/theme.dart';
import 'package:aimi/data/logging/aimi_logger.dart';
import 'package:aimi/ui/logs/log_viewer_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('日志页：渲染内存环内容、级别过滤、最近活动时间', (tester) async {
    final logger = AimiLogger();
    logger.log(AimiLogLevel.info, 'conn', '已连接（3 个会话, server 0.1.0）');
    logger.log(AimiLogLevel.warn, 'conn', '连接中断（socket closed）');
    logger.log(AimiLogLevel.error, 'turn', 'session=s1 错误文本: 403 无权访问');
    logger.log(AimiLogLevel.debug, 'conn', '忽略非契约帧');

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: ProviderContainer(),
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: LogViewerScreen(logger: logger),
        ),
      ),
    );
    await tester.pump();

    // 四条都在（默认全量）。
    expect(find.textContaining('已连接（3 个会话'), findsOneWidget);
    expect(find.textContaining('连接中断'), findsOneWidget);
    expect(find.textContaining('403 无权访问'), findsOneWidget);
    expect(find.textContaining('忽略非契约帧'), findsOneWidget);
    expect(find.textContaining('最近活动'), findsOneWidget);

    // 点 warn 过滤：只剩 warn 一条。
    await tester.tap(find.text('warn'));
    await tester.pump();
    expect(find.textContaining('连接中断'), findsOneWidget);
    expect(find.textContaining('403 无权访问'), findsNothing);
    expect(find.textContaining('忽略非契约帧'), findsNothing);

    // 再点取消过滤：全部恢复。
    await tester.tap(find.text('warn'));
    await tester.pump();
    expect(find.textContaining('403 无权访问'), findsOneWidget);
  });

  testWidgets('日志页：空环显示暂无日志', (tester) async {
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: ProviderContainer(),
        child: MaterialApp(
          theme: AimiTheme.light(),
          home: const LogViewerScreen(logger: null),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('暂无日志'), findsOneWidget);
  });
}
