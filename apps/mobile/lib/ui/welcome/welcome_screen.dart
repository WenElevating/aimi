import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../icons/aimi_icons.dart';
import '../widgets/aimi_primitives.dart';

/// 未连接入口（原型 welcome.html）：一句状态 + 一个主按钮 + 一个低调备用。
///
/// 不放会话列表、不写应用名、不做说明段落（design.md §2.1/§2.2）；
/// 扫码与手动配对各进各的页面，不在同一屏做分段切换。
class WelcomeScreen extends StatelessWidget {
  /// 未连接入口（路由 `/welcome`）。
  const WelcomeScreen({super.key});

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
              // 右上角设置（入口页唯一允许的次级动作）。
              Align(
                alignment: Alignment.centerRight,
                child: Padding(
                  padding: const EdgeInsets.only(top: 6, right: 8),
                  child: AimiIconButton(
                    icon: AimiIcons.gear,
                    semanticLabel: '设置',
                    onPressed: () => context.push('/settings'),
                    foreground: ai.ink2,
                  ),
                ),
              ),
              Expanded(
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 44,
                        height: 44,
                        decoration: BoxDecoration(shape: BoxShape.circle, color: ai.surface2),
                        alignment: Alignment.center,
                        child: AimiIcon(data: AimiIcons.linkOff, size: 20, color: ai.ink3),
                      ),
                      const SizedBox(height: 16),
                      Text('还没有连接电脑', style: tt.row),
                      const SizedBox(height: 20),
                      SizedBox(
                        width: 200,
                        height: 50,
                        child: FilledButton(
                          onPressed: () => context.push('/pairing/scan'),
                          child: const Text('扫码配对'),
                        ),
                      ),
                      const SizedBox(height: 10),
                      TextButton(
                        onPressed: () => context.push('/pairing/manual'),
                        child: Text('手动配对', style: tt.micro.copyWith(color: ai.ink2)),
                      ),
                    ],
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
