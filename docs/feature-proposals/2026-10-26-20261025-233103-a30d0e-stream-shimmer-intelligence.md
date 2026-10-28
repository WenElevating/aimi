# 需求方案：流式输出指示的节奏感知显隐

- 来源反馈：feedback #20261025-233103-a30d0e（第 1 点）
- 用户原话：「这个过渡效果我希望更智能一点，就是在工具调用得时候保持底部，在输出文本的时候显示，如果下一段没马上来又出现」
- 方案日期：2026-10-26
- 状态：仅方案，未实现；存在与既有设计决策的冲突，需人工裁决后实施

## 1. 需求概述

用户希望生成中的视觉指示（底部 shimmer）按输出节奏智能显隐：

1. 工具调用执行期间：保持视图跟随底部（现状已满足）；
2. 文本正在输出时：隐藏 shimmer（内容本身就是反馈，不需要占位动画）；
3. 下一段输出迟迟未到时：shimmer 再次出现（表明仍在生成，未完成）。

理解：把「常驻 shimmer」改为「输出活跃时隐藏、静默时兜底显示」的节奏感知策略。

## 2. 价值与合理性

- 解决的问题：文本连续输出时 shimmer 与内容同屏，显得多余且呆板；长工具调用期间仅有跟随滚动、缺少「仍在工作」的信号。
- 目标用户：所有观察长回合输出的用户。
- 与产品定位一致性：观察远程 agent 干活是产品核心场景，反馈节奏直接影响「它还在干活吗」的判断；design.md 要求状态交给图标与动效，本需求是对该原则的精细化。
- 优先级建议：中。

## 3. 现状分析（含既有设计决策）

| 位置 | 现状 |
| --- | --- |
| `apps/mobile/lib/ui/session/session_screen.dart:234-237` | `showShimmer = !dead && !waiting && (running \|\| (online && trailing 非空))`——只要判定在生成就常驻，等待审批/输入时整体关闭 |
| `apps/mobile/lib/ui/widgets/timeline_view.dart:142-168,276-281` | shimmer 挂最后回合尾部；`ShimmerHandoff` 控制 180ms 淡出，终态或等待时才离场 |
| `apps/mobile/lib/ui/session/shimmer_line.dart` | 5 句进行时文案轮换 + 扫光；新回合复位重显 |
| commit 057dcf9（2026-10-25 23:11） | Directive 明文：「Keep the streaming placeholder attached to the active response until a terminal event; **do not infer completion from a quiet interval**.」即当前「常驻到终态、不按静默推断」是**刚做出且记录在案的设计决策**，同时该提交还做了 token 帧合并（16ms 窗口）解决稀疏输出卡顿 |
| `apps/mobile/lib/app/session_render_provider.dart:26-62` | text_delta/thinking 进帧窗口批量 flush；工具事件与终态立即 flush |

关键冲突：用户诉求（静默超过阈值 → shimmer 重现）恰恰要求「从静默间隔推断」；057dcf9 的 Directive 禁止这样做。两者不可同时成立，需要人工裁决。本方案按用户诉求设计，并给出缓解「误读为完成」的措施。

## 4. 方案设计

策略：**活跃即隐、静默兜底、终态离场**。

1. `session_render_provider.dart` 维护 `lastOutputAt`（最近一次 text_delta/thinking/工具事件的时间戳，随 flush 更新）。
2. `showShimmer` 判定改为：
   - 基础条件不变（`!dead && !waiting && running`）；
   - 增加节奏项：正在流式（距 `lastOutputAt` < `quietThreshold`，建议 1000ms）→ 隐藏；静默超过 `quietThreshold` 且仍 running → 显示；
   - 终态/等待审批/输入 → 隐藏离场（现有逻辑不变）。
3. 「不误读为完成」的缓解：重现的 shimmer 保留现有进行时文案（如「还在整理下一步」类措辞，从现有 5 句中选取），且淡入重显使用现有 `ShimmerHandoff` 反向行程，不做「完成」样式。
4. 工具调用期间：工具事件不推进 `lastOutputAt` 的「文本活跃」语义——工具执行天然静默，shimmer 兜底显示（符合「工具调用时保持底部 + 有工作信号」）。
5. reduce-motion 路径：`ShimmerHandoff` 已有 reduceMotion 直切分支，节奏显隐沿用，不做额外动画。

数据结构与接口变更：无协议/服务端变更；`session_render_provider` 内部新增时间戳字段（非公开 API）。

涉及文件：`session_render_provider.dart`、`session_screen.dart`（showShimmer 计算）、`timeline_view.dart`（无需改签名）、`shimmer_line.dart`（复用）。

测试要点：密集 delta 期间无 shimmer；模拟静默 > 阈值后 shimmer 重现；waiting/终态立即隐藏；reduce-motion 重现无动画。

## 5. 备选方案及取舍

**备选 A：维持现状（常驻到终态）**——完全遵守 057dcf9 Directive，实现零成本；缺点：与用户明确诉求相悖，文本连续输出时段体验未改善。

**备选 B：仅优化 shimmer 文案轮换与位置**（不动显隐逻辑）——改善观感但不解决「与内容同屏」的核心抱怨。

推荐按用户诉求实施（本方案），理由：用户是在实际使用 build 22（含 057dcf9）后提出的迭代要求，属于对该设计的真实反馈而非误解；且缓解措施（进行时文案 + 重显动画）可降低「误读为完成」的风险。若人工裁决认为 Directive 的理由（防虚假完成感）权重更高，则维持现状并在报告中答复用户。

## 6. 风险与影响

- 兼容性：纯客户端行为；无协议/持久化影响。
- 性能：每帧时间戳比较 O(1)；无定时器新增（沿用渲染帧驱动）。
- 主要风险：①与 057dcf9 决策冲突（见上，需人工裁决）；②阈值过小会在网络抖动时闪烁（建议 1000ms 起调）；③掉帧/低端机上时间驱动可能不准（用单调时钟，不用墙钟）。
- 回归风险：057dcf9 针对的「稀疏输出平滑」是 token 帧合并问题，与本方案的显隐策略正交，但实施后必须真机回归该场景（057dcf9 自述未做真机验收）。

## 7. 工作量估算与实施步骤

约 1 人日（含真机调参）：

1. `lastOutputAt` + showShimmer 节奏项 + 单元测试（0.5 天）
2. 真机调 `quietThreshold`（800/1000/1200ms 三档实测）（0.25 天）
3. 回归 057dcf9 场景（稀疏输出、工具调用、等待审批）（0.25 天）

## 8. 待确认的问题

1. **是否接受推翻 057dcf9 的 Directive？**（核心裁决点，未确认前不实施。）
2. `quietThreshold` 的取值偏好（建议 1000ms 起）。
3. 工具调用期间 shimmer 常显是否符合预期（用户只说了「保持底部」）。

## 关联反馈

- feedback #20261025-233103-a30d0e（第 1 点；第 2 点「顶部栏间距」已由修复分支 fix/feedback-20261025-192751-348465-topbar-visual 覆盖）
- 关联提交：057dcf9（被本方案迭代的设计决策）
