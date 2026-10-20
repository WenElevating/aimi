import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../data/connection/aimi_connection.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';

/// 扫码配对页（原型 pairing-scan.html）：只有取景框 + 一句提示。
///
/// 当前为视觉外壳：静态四角括号、无扫描线动画、无完成按钮；
/// 真实相机扫码需要额外依赖与权限，按计划留到后续。
class PairingScanScreen extends StatelessWidget {
  /// 扫码页（路由 `/pairing/scan`）。
  const PairingScanScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Scaffold(
      backgroundColor: ai.canvas,
      body: AimiPageBackground(
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 6, 16, 8),
                child: Row(
                  children: [
                    AimiIconButton(
                      icon: AimiIcons.back,
                      semanticLabel: '返回',
                      onPressed: () => context.pop(),
                      foreground: ai.ink2,
                    ),
                    Text('扫码配对', style: tt.title),
                  ],
                ),
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                  child: Container(
                    decoration: BoxDecoration(
                      color: ai.surface2,
                      borderRadius: const BorderRadius.all(AimiRadius.picker),
                    ),
                    child: Column(
                      children: [
                        Expanded(
                          child: Center(
                            child: SizedBox(
                              width: 240,
                              height: 240,
                              child: CustomPaint(
                                painter: _ScanFramePainter(color: ai.ink4),
                                child: Center(
                                  child: AimiIcon(
                                    data: AimiIcons.scan,
                                    size: 28,
                                    color: ai.ink3,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.only(bottom: 24),
                          child: Text(
                            '对准电脑上的二维码',
                            style: tt.meta.copyWith(color: ai.ink3),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 取景框四角括号（静态，无扫描线；1.6px 圆角端点，与图标同一线性语言）。
class _ScanFramePainter extends CustomPainter {
  _ScanFramePainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6
      ..strokeCap = StrokeCap.round
      ..color = color;
    const arm = 24.0;
    const inset = 0.8;
    final w = size.width;
    final h = size.height;
    // 左上
    canvas.drawPath(
      Path()
        ..moveTo(inset, arm)
        ..lineTo(inset, inset)
        ..lineTo(arm, inset),
      paint,
    );
    // 右上
    canvas.drawPath(
      Path()
        ..moveTo(w - arm, inset)
        ..lineTo(w - inset, inset)
        ..lineTo(w - inset, arm),
      paint,
    );
    // 右下
    canvas.drawPath(
      Path()
        ..moveTo(w - inset, h - arm)
        ..lineTo(w - inset, h - inset)
        ..lineTo(w - arm, h - inset),
      paint,
    );
    // 左下
    canvas.drawPath(
      Path()
        ..moveTo(arm, h - inset)
        ..lineTo(inset, h - inset)
        ..lineTo(inset, h - arm),
      paint,
    );
  }

  @override
  bool shouldRepaint(_ScanFramePainter old) => old.color != color;
}

/// 手动配对页（原型 pairing-manual.html）：电脑地址 + 8 位配对码 + 一个「连接」。
///
/// 走真实握手：`pairWithCode` → `hello{pairingCode}` → `paired{token}` →
/// 写入 secure_storage → 回到看板。成功后只显示「已连接 + 主机」，不回显 token。
class PairingManualScreen extends ConsumerStatefulWidget {
  /// 手动配对页（路由 `/pairing/manual`）。
  const PairingManualScreen({super.key});

  @override
  ConsumerState<PairingManualScreen> createState() => _PairingManualScreenState();
}

class _PairingManualScreenState extends ConsumerState<PairingManualScreen> {
  final TextEditingController _address = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final FocusNode _codeFocus = FocusNode();

  /// 校验/握手错误文案（页内呈现，不用一次性提示）。
  String? _error;

  /// 正在配对（禁用按钮，防重复核销配对码）。
  bool _pairing = false;

  /// 配对成功的服务器名（成功后整页切到「已连接」）。
  String? _pairedHost;

  @override
  void initState() {
    super.initState();
    // 已配过对时回填地址，便于重连同一台电脑。
    final endpoints = ref.read(endpointsProvider).value;
    if (endpoints != null) {
      _address.text = '${endpoints.scheme}://${endpoints.host}:${endpoints.port}';
    }
    _code.addListener(_onCodeChanged);
  }

  @override
  void dispose() {
    _code.removeListener(_onCodeChanged);
    _address.dispose();
    _code.dispose();
    _codeFocus.dispose();
    super.dispose();
  }

  /// 配对码只接受数字并截断到 8 位（与原型输入净化一致）。
  void _onCodeChanged() {
    final digits = _code.text.replaceAll(RegExp(r'\D'), '');
    final capped = digits.length > 8 ? digits.substring(0, 8) : digits;
    if (capped != _code.text) {
      _code.value = TextEditingValue(
        text: capped,
        selection: TextSelection.collapsed(offset: capped.length),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final ai = context.ai;
    final tt = context.tt;
    return Scaffold(
      backgroundColor: ai.canvas,
      body: AimiPageBackground(
        child: SafeArea(
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
                      onPressed: _pairing ? null : () => context.pop(),
                      foreground: ai.ink2,
                    ),
                    Text('手动配对', style: tt.title),
                  ],
                ),
              ),
              Expanded(
                child: _pairedHost != null
                    ? _connectedView(ai, tt)
                    : ListView(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                        children: [
                          Text('电脑地址', style: tt.micro.copyWith(color: ai.ink3)),
                          const SizedBox(height: 6),
                          _field(
                            controller: _address,
                            hint: '192.168.1.10:8787',
                            mono: true,
                            enabled: !_pairing,
                          ),
                          const SizedBox(height: AimiSpace.s4),
                          Text('配对码', style: tt.micro.copyWith(color: ai.ink3)),
                          const SizedBox(height: 6),
                          _field(
                            controller: _code,
                            focusNode: _codeFocus,
                            hint: '8 位配对码',
                            mono: true,
                            enabled: !_pairing,
                            centered: true,
                          ),
                          if (_error != null) ...[
                            const SizedBox(height: 10),
                            Text(_error!, style: tt.micro.copyWith(color: ai.red)),
                          ],
                          const SizedBox(height: AimiSpace.s5),
                          SizedBox(
                            height: 50,
                            child: FilledButton(
                              onPressed: _pairing ? null : _connect,
                              child: Text(_pairing ? '正在连接…' : '连接'),
                            ),
                          ),
                        ],
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 成功态：一个勾 + 「已连接」+ 主机名（不显示 token）。
  Widget _connectedView(AimiColors ai, AimiText tt) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 54,
              height: 54,
              decoration: BoxDecoration(shape: BoxShape.circle, color: ai.greenSoft),
              alignment: Alignment.center,
              child: AimiIcon(data: AimiIcons.check, size: 26, color: ai.green),
            ),
            const SizedBox(height: 14),
            Text('已连接', style: tt.row),
            const SizedBox(height: 4),
            AimiMono(_pairedHost ?? '', color: ai.ink3),
          ],
        ),
      );

  /// 输入井：mono、inset、focus 不变填充（配对码居中并拉开字距）。
  Widget _field({
    required TextEditingController controller,
    required String hint,
    required bool mono,
    required bool enabled,
    FocusNode? focusNode,
    bool centered = false,
  }) {
    final ai = context.ai;
    final tt = context.tt;
    final style = mono ? tt.mono.copyWith(color: ai.ink, letterSpacing: centered ? 4 : null) : tt.body;
    return TextField(
      controller: controller,
      focusNode: focusNode,
      enabled: enabled,
      textAlign: centered ? TextAlign.center : TextAlign.start,
      keyboardType: centered ? TextInputType.number : TextInputType.url,
      autocorrect: false,
      enableSuggestions: false,
      style: style,
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: style.copyWith(color: ai.ink3),
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
    );
  }

  /// 执行真实配对：校验 → 握手 → 落库 → 进看板。
  Future<void> _connect() async {
    final address = _address.text.trim();
    final code = _code.text.trim();
    if (address.isEmpty) {
      setState(() => _error = '先填电脑地址');
      return;
    }
    if (code.length != 8) {
      setState(() => _error = '配对码是 8 位');
      _codeFocus.requestFocus();
      return;
    }
    setState(() {
      _pairing = true;
      _error = null;
    });
    try {
      final result = await pairWithCode(
        lanUrl: address,
        pairingCode: code,
        deviceName: _deviceName(),
        channelFactory: ref.read(channelFactoryProvider),
      );
      // 落库：host/port/scheme/token（+ serverId 空位由地址推断，relay 由后续 QR 提供）。
      final storage = ref.read(secureStorageProvider);
      final uri = Uri.parse(address.contains('://') ? address : 'ws://$address');
      await storage.write(key: hostStorageKey, value: uri.host);
      await storage.write(key: portStorageKey, value: '${uri.hasPort ? uri.port : 8787}');
      await storage.write(key: schemeStorageKey, value: uri.scheme == 'wss' ? 'wss' : 'ws');
      await storage.write(key: tokenStorageKey, value: result.token);
      if (!mounted) return;
      setState(() {
        _pairing = false;
        _pairedHost = uri.host;
      });
      // endpoints 变更 → 连接层重建并自动连接；稍候回看板。
      ref.invalidate(endpointsProvider);
      await Future<void>.delayed(const Duration(milliseconds: 900));
      if (!mounted) return;
      context.go('/');
    } on PairingException catch (error) {
      if (!mounted) return;
      setState(() {
        _pairing = false;
        _error = error.message;
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _pairing = false;
        _error = '配对失败：$error';
      });
    }
  }

  /// 设备显示名（服务端设备列表可见；固定为本机型语义即可）。
  String _deviceName() => 'aimi-android';
}
