import 'package:flutter/widgets.dart';
import 'package:path_drawing/path_drawing.dart';

/// aimi 图标集：路径数据逐字取自 `prototypes/codex/screens/*.html` 的 inline SVG sprite
/// （stroke 1.6、圆角端点、24×24 viewBox），保证手机端与原型字形一致。
///
/// 全部为单色线性图标；颜色继承 [color]（生产中来自语义 token），线宽恒 1.6。
/// 纯图标按钮必须再叠加 `Semantics`/`tooltip` 提供可访问名称（design.md §7）。
class AimiIcon extends StatelessWidget {
  /// 构建一枚 aimi 线性图标。
  ///
  /// [data] 取自 [AimiIcons]；[size] 用语义尺寸 13/15/17（design.md §4.4），
  /// 视觉小不限制，但外层按钮热区必须 ≥44。
  ///
  /// [strokeWidth] 覆盖默认线宽（1.6）；选中态（如赞踩按下）用 2.0 描边加粗，
  /// 与原型 `.msg-action[aria-pressed="true"] .i { stroke-width: 2 }` 对齐。
  const AimiIcon({
    super.key,
    required this.data,
    this.size = 17,
    this.color,
    this.strokeWidth,
  });

  /// 图标路径定义（viewBox 24×24 内的 stroke 路径）。
  final AimiIconData data;

  /// 逻辑边长；原型语义档位 13 / 15 / 17。
  final double size;

  /// 线条颜色；null 时继承 [IconTheme]。
  final Color? color;

  /// 线宽覆盖（逻辑坐标）；null 用默认 1.6。
  final double? strokeWidth;

  @override
  Widget build(BuildContext context) {
    final resolved = color ?? IconTheme.of(context).color;
    return CustomPaint(
      size: Size.square(size),
      painter: _IconPainter(
        data: data,
        color: resolved ?? const Color(0xFF000000),
        strokeWidth: strokeWidth,
      ),
    );
  }
}

/// 一枚图标的绘制定义：[paths] 是 stroke 路径、[fills] 是实心形状（原型中
/// `fill="currentColor"` 的圆点与 `<rect>` 转换而来的圆角矩形路径）。
class AimiIconData {
  const AimiIconData({this.paths = const [], this.fills = const []});

  /// stroke 路径的 SVG `d` 串（经 path_drawing 解析）。
  final List<String> paths;

  /// 实心形状的 SVG `d` 串（`<circle fill>`/`<rect>` 已预先转写为等价 path）。
  final List<String> fills;

  /// 相等性按内容（用于测试断言）。
  @override
  bool operator ==(Object other) =>
      other is AimiIconData && other.paths == paths && other.fills == fills;

  @override
  int get hashCode => Object.hash(Object.hashAll(paths), Object.hashAll(fills));
}

/// 图标库：来源与字形以 prototypes/codex 为唯一基准，禁止混入 Material 图标凑数。
abstract final class AimiIcons {
  /// ↑ 发送（composer 主按钮，空闲态）。
  static const arrowUp = AimiIconData(paths: ['M12 19V5', 'M5 12l7-7 7 7']);

  /// + 新建 / 附加。
  static const plus = AimiIconData(paths: ['M12 5v14', 'M5 12h14']);

  /// chevron 向下（模型 chip / 思考折叠）。
  static const chevronDown = AimiIconData(paths: ['M6 9l6 6 6-6']);

  /// chevron 向右（进入/前进）。
  static const chevron = AimiIconData(paths: ['M9 6l6 6-6 6']);

  /// 文档（Read 类工具卡）。
  static const doc = AimiIconData(paths: [
    'M6 3h8l4 4v14H6z',
    'M14 3v4h4',
    'M9 12h6',
    'M9 16h6',
  ]);

  /// 搜索（Grep 类工具卡）。
  static const search = AimiIconData(paths: ['M11 5a6 6 0 1 1 0 12 6 6 0 0 1 0-12z', 'M16 16l4 4']);

  /// 铅笔（Edit 类工具卡 / 自动编辑权限态）。
  static const pen = AimiIconData(paths: ['M4 20l4-1 11-11-3-3L5 16l-1 4z', 'M14 5l3 3']);

  /// 终端（Bash 类工具卡 / command well 头）。
  static const terminal = AimiIconData(paths: ['M4 7l5 5-5 5', 'M12 17h8']);

  /// ⋯ 更多（会话页 header 右侧；三个实心圆点）。
  static const more = AimiIconData(fills: [
    'M5 12a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 1 0 -2.8 0z',
    'M12 12a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 1 0 -2.8 0z',
    'M19 12a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 1 0 -2.8 0z',
  ]);

  /// 返回（左 chevron）。
  static const back = AimiIconData(paths: ['M15 18l-6-6 6-6']);

  /// 打断/停止（composer 主按钮，运行态）。
  static const pause = AimiIconData(paths: ['M9 5v14', 'M15 5v14']);

  /// 时钟（待发胶囊 / 停滞提示）。
  static const clock = AimiIconData(paths: ['M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16z', 'M12 8v4.5l3 1.8']);

  /// 垃圾桶（删除待发消息）。
  static const trash = AimiIconData(paths: [
    'M4 7h16',
    'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
    'M6 7l1 13h10l1-13',
    'M10 11v5',
    'M14 11v5',
  ]);

  /// 星形火花（品牌点缀）。
  static const spark = AimiIconData(paths: ['M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z']);

  /// 锁（每次询问权限态）。
  static const lock = AimiIconData(paths: [
    'M5.5 11h13v10h-13z', // <rect x=3.5 y=11 w=17 h=10 rx=2.2> 的等价闭合路径（圆角由 strokeJoin 呈现近似）
    'M7.5 11V7.2a4.8 4.8 0 0 1 9.5 0V11',
  ], fills: ['M12 14.8a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0 -2.4 0z']);

  /// 钥匙（完全放行权限态）。
  static const key = AimiIconData(paths: [
    'M6.5 8.6a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8z', // <circle r=3.4> 的双 A 段整圆
    'M9.9 12H20',
    'M15.6 12v3.4',
    'M18.6 12v2.2',
  ]);

  /// 勾（完成 / picker 选中）。
  static const check = AimiIconData(paths: ['M5 12.5l4.2 4.2L19 7']);

  /// 关闭 X（sheet 右上角）。
  static const close = AimiIconData(paths: ['M6 6l12 12', 'M18 6L6 18']);

  /// 复制（command well）。
  static const copy = AimiIconData(paths: [
    'M9 11h9a2 2 0 0 1 2 2v7H9a2 2 0 0 1-2-2z', // <rect x=9 y=9 w=11 h=11 rx=2> 等价
    'M5 15V5a2 2 0 0 1 2-2h10',
  ]);

  /// 扫码取景框。
  static const scan = AimiIconData(paths: [
    'M4 9V6a2 2 0 0 1 2-2h3',
    'M15 4h3a2 2 0 0 1 2 2v3',
    'M20 15v3a2 2 0 0 1-2 2h-3',
    'M9 20H6a2 2 0 0 1-2-2v-3',
    'M9 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  ]);

  /// 斜杠（不可用置灰标记，叠在 codex agent chip 上）。
  static const slash = AimiIconData(paths: ['M5.5 18.5l13-13']);

  /// 齿轮（设置入口）。
  static const gear = AimiIconData(paths: [
    'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z', // <circle r=3> 等价整圆
    'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ]);

  /// 文件夹（项目分组头 / 目录行）。
  static const folder = AimiIconData(paths: [
    'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z',
  ]);

  /// 链路断开（未连接入口 badge）。
  static const linkOff = AimiIconData(paths: [
    'M9.9 5.2A4.2 4.2 0 0 1 16 8.3v.7',
    'M14.1 18.8A4.2 4.2 0 0 1 8 15.7V15',
    'M4 4l16 16',
  ]);

  /// 赞（回合动作行「有帮助」）。
  static const thumbUp = AimiIconData(paths: [
    'M7 10.5v9.5',
    'M15 5.9 14 10h5.6a2 2 0 0 1 1.9 2.5l-2.2 7.6A2 2 0 0 1 17.4 21.5H7a2 2 0 0 1-2-2V12.5a2 2 0 0 1 2-2h1.9a2 2 0 0 0 1.7-1L13.8 3a3 3 0 0 1 1.2 2.9Z',
  ]);

  /// 踩（回合动作行「没帮助」，反馈触发入口）。
  static const thumbDown = AimiIconData(paths: [
    'M17 13.5V4',
    'M9 18.1 10 14H4.4a2 2 0 0 1-1.9-2.5l2.2-7.6A2 2 0 0 1 6.6 2.5H17a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-1.9a2 2 0 0 0-1.7 1L10.2 21a3 3 0 0 1-1.2-2.9Z',
  ]);

  /// 更新下载（看板 header 更新入口）。
  static const download = AimiIconData(paths: [
    'M12 3v10',
    'M8 9l4 4 4-4',
    'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  ]);

  /// 分叉（回合动作行第 4 个动作，逐字取自原型 sprite `#i-branch`）；
  /// 圆点以等价 arc path 表达（stroke 口径与其它图标一致）。
  static const branch = AimiIconData(paths: [
    'M3 12h6.4',
    'M9.4 12 16.6 6.6',
    'M9.4 12l7.2 5.4',
    'M21.5 6a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 1 1 4.6 0Z',
    'M21.5 18a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 1 1 4.6 0Z',
  ]);
}

/// 单图标画笔：paths 按 stroke 1.6（逻辑坐标）绘制（[strokeWidth] 可覆盖），
/// fills 按实心绘制，整体从 24×24 viewBox 缩放到目标 [Size]。
class _IconPainter extends CustomPainter {
  _IconPainter({required this.data, required this.color, this.strokeWidth});

  final AimiIconData data;
  final Color color;

  /// 线宽覆盖；null 用默认 1.6。
  final double? strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final scale = size.width / 24;
    canvas.save();
    canvas.scale(scale, scale);

    if (data.fills.isNotEmpty) {
      final fill = Path();
      for (final d in data.fills) {
        fill.addPath(parseSvgPathData(d), Offset.zero);
      }
      canvas.drawPath(
        fill,
        Paint()
          ..style = PaintingStyle.fill
          ..color = color
          ..isAntiAlias = true,
      );
    }
    if (data.paths.isNotEmpty) {
      final stroke = Path();
      for (final d in data.paths) {
        stroke.addPath(parseSvgPathData(d), Offset.zero);
      }
      canvas.drawPath(
        stroke,
        Paint()
          ..style = PaintingStyle.stroke
          ..color = color
          ..strokeWidth = strokeWidth ?? 1.6 // 逻辑坐标线宽：经画布 scale 后即为 size/24 × 1.6
          ..strokeCap = StrokeCap.round
          ..strokeJoin = StrokeJoin.round
          ..isAntiAlias = true,
      );
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_IconPainter old) =>
      old.data != data || old.color != color || old.strokeWidth != strokeWidth;
}
