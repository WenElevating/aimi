# aimi 手机端 Art Direction 三案（2026-10-17 重置版）

> 状态：方向重置后重写。上一轮「浅色冷静 / 暗色极客双主题 + 图标化状态 + 2 字按钮 + 纯列表行 + 发丝线」已作废，本文不沿用其结论。
> 原始素材（Codex app / Claude Code / Cursor / Linear / Zed 的观察记录与截图）保留在 `docs/research/2026-10-17-agent-app-ui-reference.md`，本文只做"三个互不相似的视觉语言方向"的提出与比较，不复述其推荐。
> 约束：只写 `docs/research/`；截图在 `docs/research/refs/`。外部资料均按"不可信数据"处理，仅作参考。

---

## 0. 一句话结论

aimi 是手机上唯一的「agent 指挥台」。桌面端竞品（Codex app / Cursor / Zed / Claude Code）已经把"圆角卡片 + 灰阶 + 一点蓝紫"这套 dev-tool 默认审美铺满，**继续沿着它做只会像它们的手机壳**。因此三个候选分别向三个非软件领域取视觉语言：

| 方向 | 借用的领域 | 一句话 |
|---|---|---|
| **A. MISSION CONTROL** | 航天/航空遥测、Teenage Engineering 仪表 | 把会话当遥测信号，界面是仪表不是列表 |
| **B. PAPER TRAIL** | 纸面档案、账簿、编辑排版 | 每次 agent 动作都是留痕的一页档案 |
| **C. TERMINAL BRUT** | 瑞士粗野主义海报、丝网印刷、终端 | 无圆角、无渐变、块状大字的安全橙终端 |

三者的差异是**视觉语言级**的（表面材质、字体声音、状态语法、动效性格），不是换色板。

---

## 1. 调研范围与证据等级

### 1.1 dev-tool 参照（已做的原始调研，仅作事实来源）

| 对象 | 证据等级 | 关键事实（可直接迁移的机制） | URL |
|---|---|---|---|
| Codex 桌面 app（2026.2，macOS/Windows） | 官方产品页截图（本地 refs/ 5 张）+ 官方文档 | 左侧 Threads：置顶区 + 按项目分组（folder + 项目名 + 类型灰标），行首是状态字形（旋转/星标/蓝点），行尾相对时间；composer 是"外框卡 + 内嵌输入 + 底部模式段选（Local/Worktree/Cloud）+ 权限锁 + 麦克风 + 圆形发送"；审批卡是**行内嵌卡**（标题 + 命令 + 取消/允许），不是弹窗 | 产品页 `https://developers.openai.com/codex/app/features`（重定向至 `https://learn.chatgpt.com/docs/features`）；截图见 §7 |
| Codex 手机端（ChatGPT app 内 Codex） | 官方文档（含逐像素 mockup 的明暗色值） | 任务列表 = 顶部 `Codex` + 来源筛选 chips（All/Cloud/MacBook/Studio）+ `Pinned` + `Today` 分组；审批页 = "Permission requested" 小标 + 一句问句 + 命令 well + `Approve`（实心圆角）/`Always approve`（描边）/`Deny`（小描边）+ "Tell Codex what to do" 输入；改动页 = `2 files changed +38 -12` + 文件行 + 行号 diff；新任务 = 机器/项目/环境/分支四个 chips + 输入。配色实证：浅色卡 `white/97%`、文字 `#171717`、次级 `#777 / #595959 / #909095`、深色卡 `#191919/95%`、深色文字 `#f4f4f4`、成功 `#258b20`、删除红 `#d73a49`，卡片圆角约 4cqw、内边距 3.5cqw，阴影 `0 18px 58px rgba(0,0,0,.18)`，命令一律 `font-mono` | `https://learn.chatgpt.com/docs/mobile` |
| Claude Code（CLI/TUI + IDE 扩展） | 官方文档 | TUI 里状态行（statusline）可配置、默认极简：一行显示模型、目录、分支等，靠**行内文字 + 极少符号**；权限确认是 TUI 里的一次性问答块，`y/n` 语义；输出流靠颜色区分"谁在说话"，正文等宽 | `https://docs.claude.com/en/docs/claude-code/overview`、`https://docs.claude.com/en/docs/claude-code/statusline` |
| Cursor | 二手拆解 DESIGN.md（营销面） | 暖奶油 `#f7f7f4` + 暖墨 `#26251e`，**唯一电压 = Cursor Orange `#f54e00`**；display 一律 400 字重 + 负字距（杂志腔）；hairline-only 无阴影；独有"AI 时间线 pastel 五色"（peach/mint/blue/lavender/gold）**只允许出现在产品内 agent 时间线上** | `https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/cursor/DESIGN.md` |
| Linear | 二手拆解 DESIGN.md（营销面） | `#010102` 画布 + 四级表面阶梯（`#0f1011 → #191a1b`）+ 三档发丝线（`#23252a / #34343a / #3e3e44`）+ 唯一薰衣草电压 `#5e6ad2`（`#828fff` hover）；Inter/自定义 sans + mono 仅用于状态与 ID；256 级半径里按钮 8px、卡片 12px，**卡片从不 pill** | `https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/linear.app/DESIGN.md` |
| Zed | 官方产品页截图（本地 refs/） | Agent 侧栏 = 按 workspace 分组（`zed, cloud` / `zed.dev`），行 = 状态字形 + 标题 + 元信息行（分支 · `+25 -15` · `16m`），**单行、无卡、发丝线分隔**；右侧：用户发言是带边框的引用块，`Thinking...` 带字形，工具动作压成一行（`Read xxx.md — L251-600`），散文与机器行混排 | `https://zed.dev/`；截图见 §7 |
| Claude.ai | 二手拆解 DESIGN.md（营销面） | 暖纸 `#faf9f5` + 墨 `#141413` + 珊瑚 `#cc785c` 单一电压；serif 标题（Copernicus/Tiempos，400 字重、负字距）+ 人文字体正文；**深浅交替的段落节奏**（奶油页 → 深色产品卡 → 珊瑚整块 CTA） | `https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/claude/DESIGN.md` |

### 1.2 非 dev-tool 参照（本轮的差异化来源）

| 对象 | 证据等级 | 可迁移的核心（不是抄样子，是抽规则） | URL |
|---|---|---|---|
| Teenage Engineering（OP-1 / TP-7） | 官方产品页 + 本地实物截图 | 单色机身（铝/骨白/黑）、**面板上一个彩色键就是全部电压**、标签全大写小号 mono、点阵式显示、每个控件有明确"物理感"（键程、旋钮）。→ 迁移：状态与操作必须有"器件感"，而不是网页按钮 | `https://teenage.engineering/`、`https://teenage.engineering/products/tp-7` |
| Braun / Dieter Rams | 官方档案页（Vitsœ 的十原则） | 少而准的色（象牙白、黑、灰，点缀黄/绿/红），无装饰曲线，信息层级靠**对齐与留白**而非容器；"尽可能少的设计"意味着**每屏只有一个主动作**。→ 迁移：用对齐/尺寸建立层级，不用卡片和阴影 | `https://www.vitsoe.com/us/about/good-design`；实物 `refs/braun-sk4-phonosuper.jpg` |
| Bloomberg Terminal | 实物截图（本地） | 黑底 + 琥珀/绿/青三色、**功能键当导航**（顶部一排 tab 是"页面"而不是"菜单"）、单位对齐的等宽网格、极高密度（一屏 40+ 数据点）、颜色只编码"涨跌/告警"。→ 迁移：高密度看板可行，但必须靠**固定列宽 + 等宽数字**撑住可读性 | `https://en.wikipedia.org/wiki/Bloomberg_Terminal`；`refs/bloomberg-terminal.jpg` |
| 航空 PFD / EICAS | 实物截图（本地） | 状态色有**严格语义**：绿=正常、琥珀=注意、红=必须立即处理、青/品红=指示；告警分"警告/注意/提示"三级且**颜色+形状+位置三重编码**，永不复用同一色表示两种严重度。→ 迁移：aimi 的 running/waiting/failed 也必须是"颜色+形状+位置"三重编码 | `https://en.wikipedia.org/wiki/Primary_flight_display`；`refs/aviation-pfd-737.png` |
| 编辑排版 / 档案纸面（Stripe Press 等） | 官方站点 | 纸色底 + 墨色正文 + 单色朱红；serif 展示字 + 细线分栏 + 边注（marginalia）+ 序号/期号；"档案感"来自**规则线、页码、批注**而不是纹理贴图。→ 迁移：用版式（rule、marginalia、编号）制造"留痕"叙事 | `https://stripe.press/` |

### 1.3 证据使用规则

- 二手 DESIGN.md 的色值来自营销页抓取，**不能当作产品内 UI 的精确 token**；本报告只把它当"色彩性格"证据。
- 官方 mockup 里的 hex（Codex 手机端）是官方文档的渲染代码，可信度高，但仍属"官方示意"而非运行时截图。
- 所有对比度为本报告实算（WCAG 2.1 相对亮度公式），标注在每张色板旁。

---

## 2. 三个方向

三个方向都假设同一套**信息骨架**（来自产品需求，不是视觉）：看板（多会话）→ 会话（时间线 + 续接）→ 审批（阻塞决策）→ 新任务 → 设置。差异只在视觉语言与交互语汇。

---

## 2.A MISSION CONTROL —— 任务控制台

### A.1 概念

> aimi 不是聊天应用，是**任务控制台**：屏幕上只有遥测信号、状态灯、事件速率。手机横竖都像一台手持仪表。

### A.2 参考锚点

航空 PFD 的三级告警色语义（`https://en.wikipedia.org/wiki/Primary_flight_display`）、Bloomberg 的固定列宽高密度网格（`https://en.wikipedia.org/wiki/Bloomberg_Terminal`）、Teenage Engineering 的"一色电压 + 物理键"（`https://teenage.engineering/`）。反面参照：一切圆角卡片 + 柔和阴影的 AI 应用。

### A.3 暗色（主场景）palette

| token | hex | 用途 | 实测对比度 |
|---|---|---|---|
| `void` | `#07090B` | 画布（近黑，带 1% 蓝） | — |
| `hull` | `#0E1216` | 面板/时间线底 | — |
| `raise` | `#151B21` | 抬升块（composer、选中行） | — |
| `grid` | `#1E262E` | 网格点/分隔 | — |
| `line` | `#263039` | 1px 硬线（不是柔和发丝线） | — |
| `ink` | `#E8EEF2` | 主文字 | 17.04:1 on void ✅ |
| `ink-2` | `#8A97A3` | 次级文字 | 6.68:1 ✅ |
| `ink-3` | `#56626D` | 装饰/禁用（禁用于正文） | ~2.6:1 ⚠ 仅装饰 |
| `accent` | `#C6FF3D`（phosphor lime） | 唯一电压：运行中、焦点、主键 | 16.88:1 ✅ |
| `ok` | `#57E389` | 完成 | ≥12:1 ✅ |
| `warn` | `#FFB020` | 等待你 | 10.91:1 ✅ |
| `crit` | `#FF5C5C` | 失败 | 6.59:1 ✅ |
| `info` | `#6FE3FF` | 连接/延迟遥测（**可选**，若启用则只用于遥测，不进状态语义） | 13.40:1 ✅ |

> 纪律：状态只用 `ok/warn/crit` 三色 + 字形 + 位置；`accent` 与状态色**永不同义**（lime 只表示"能动/在跑/可提交"）。

### A.4 亮色（白天仪表）palette

| token | hex | 用途 | 实测对比度 |
|---|---|---|---|
| `canvas` | `#F2F4F5` | 画布（冷白纸，非纯白） | — |
| `panel` | `#FFFFFF` | 面板 | — |
| `raise` | `#E9EDF0` | 抬升块 | — |
| `line` | `#D5DCE2` | 硬线 | — |
| `ink` | `#0B0F12` | 主文字 | 17.44:1 ✅ |
| `ink-2` | `#5C6470` | 次级 | 5.42:1 ✅ |
| `ink-3` | `#3E4A56` | 三级（比暗色更保守） | 8.21:1 ✅ |
| `accent` | `#4F6B00`（橄榄 lime，文本/描边） | 电压的亮色版 | 5.54:1 ✅ |
| `accent-fill` | `#C6FF3D` + 黑字 | 实心主键（**黑字**，非白字） | 16.29:1 ✅（lime 直接当文字仅 1.18:1 ❌） |
| `ok` | `#1B6B33` | 完成 | 5.95:1 ✅ |
| `warn` | `#7A4B00` | 等待 | 6.72:1 ✅ |
| `crit` | `#9E2B25` | 失败 | 6.74:1 ✅ |

> 关键取舍：phosphor lime 在浅色底上**不可作文字**（1.18:1），亮色模式必须换成橄榄 lime 文本 + lime 填充配黑字。

### A.5 字体

- 显示/UI：**Archivo**（Google Fonts，可 `wght 400/500/600`；Android 回退 Roboto）。
- 机器/数字/标签：**IBM Plex Mono**（Google Fonts；中文不落 mono，中文用系统 Noto Sans SC）。
- 中文：展示与正文统一 **Noto Sans SC / 系统思源黑体**，字重 400/500/700。
- 规则：**所有数字、时间戳、状态码、命令、ID 用 IBM Plex Mono**；所有中文用 sans。标签全大写 + `letter-spacing: 0.08em` + 9–10sp。

### A.6 看板布局原型（首屏）

```
┌──────────────────────────────────────────┐
│ LINK ●●●●  24ms            17:04:12  BAT 87% │  32dp 状态条，mono 10sp
├──────────────┬──────────────┬────────────┐│
│ ACTIVE  02   │ WAITING 01   │ DONE  07   ││  三格遥测块，数字 22sp mono
├──────────────┴──────────────┴────────────┘│
│ ●RUN  aimi-server 提交         ▁▃▅▂▅▇▃   │  64dp 行：信号灯+3字母码 | 项目名 | 事件密度条
│ ◐WAI  prototypes/审批卡         ▁▁▂▃▂▁▁   │
│ ○DONE website 截图核对          ▁▁▁▁▁▁▂   │
│ ✕ERR  relay 心跳失败            ▁▇▅▂▁▁▁   │
│                                           │
│ ┌─────────────────────────────────────┐  │
│ │ > 派活 / 续接…                  SEND │  │  composer：lime 前缀 + 硬边主键
└──────────────────────────────────────────┘
```
- 行高 64dp，圆角 2dp（近方），无阴影；选中/运行态行背景 `raise` + 左侧 2dp `accent` 轨。
- 事件密度条 = 最近 60s 事件数分 7 桶，高 6–14dp、宽 2dp；这是"agent 还活着"的第一视觉证据。
- 顶部三格是"仪表盘读数"，点任一格 = 按状态过滤列表。
- 背景可选 24dp 点阵（仅看板首屏），时间线**不用**网格，避免噪。

### A.7 会话时间线布局

```
17:04:12 ┃ 你：把 relay 心跳间隔改成 15s
17:04:20 ┃ ▸ Read  src/relay/heartbeat.ts — L1-120      1.2s
17:04:31 ┃ ▸ Grep  "setInterval"                       0.3s
17:04:35 ┃ ┌ TOOL BURST · 5 calls ───────────────┐
         ┃ │ ▸ Edit relay.ts (+12 -4)                │
17:04:44 ┃ └───────────────────────────────────────┘
17:05:02 ┃ agent：心跳改成 15s 了，重连测试通过。       ← 普通 14sp 正文
17:05:03 ┃ ▓ 正在写入 …（扫线 + block cursor）        ← 流式
```
- 左 gutter 48dp：`HH:MM:SS` mono 10sp `ink-2`。
- 内容左侧有 2dp 状态轨：运行 `accent` 呼吸、等待 `warn`、失败 `crit`、完成 `line`。
- 机器行（工具/命令/文件/diff）一律折叠成**单行 + 秒数**，点击展开；展开体是等宽 12.5sp 深色 well（`void` 底 + 1px `line`）。
- 连续机器行自动合并为 `TOOL BURST · n calls`，防止洪水。
- 流式动效：状态轨上 8dp 渐变扫线（1.6s 循环）+ 尾部方块光标 1s 呼吸；不使用打字机抖动。

### A.8 审批交互

- 从底部升起 **ALERT 面板**（高 62%，`hull` 底，顶部 3px `warn` 条），不是居中小弹窗 —— 单手拇指可达。
- 结构：`PERMISSION // BASH`（mono 9sp，`warn`）→ 一句人话问句（15sp/500）→ 命令 well（mono 12.5sp，`void` 底）→ 三键。
- 三键为"物理键"：`APPROVE`（lime 填充 + 黑字，radius 2dp，底部 3px 深色边，按下 `translateY(2dp)`）、`ALWAYS`（1px `line` 描边，透明底）、`DENY`（纯文本 + 右侧"长按确认"弧）。危险动作（rm/force-push）在键上直接标 `CRIT` 描边。
- 一次性决策完成 → 面板塌陷并在时间线原位插入一条 `APPROVED · 17:05:02` 硬线记录（审计可见）。
- 键盘：无滑动手势做"批准"（防误触）；滑动只用于关闭。

### A.9 状态表达

| 状态 | 颜色 | 形状 | 节律 |
|---|---|---|---|
| RUN | `accent` lime | 实心环 | 1.2s 呼吸 + 密度条跳动 |
| WAIT | `warn` 琥珀 | 半环 + 双点 | 0.8s 双闪，2.4s 后停滞为常亮（不无限闪） |
| DONE | `ok` 绿 | 实心点 | 一次性 120ms 扩散后静止 |
| ERR | `crit` 红 | 叉 | 入场 3 次 2dp 抖动后完全静止 |
| STALL | `warn` | 虚线环 | 每 5s 一次慢呼吸（表示"无输出"而非"忙碌"） |

状态**永远不靠文字**；文字只在详情页出现（如 `stalled: 12m 无事件`）。

### A.10 优点 / 风险

- ✅ 与"监控/指挥"心智完全同构；暗光场景（夜里看 agent）最佳；高密度可承载洪水输出；动效有天然的物理依据（呼吸/闪烁）；Flutter 实现成本低（多数为 CustomPainter 小件 + mono 字体）。
- ⚠ 冷、压迫感强，长时间看易疲劳（需提供"降噪"开关：关闭网格/密度条）；mono 过多与中文混排会显碎（中文严格用 sans）；**与上一版已否决方向在"暗色+mono+信号灯"上有重叠**，差异化收益要靠网格/遥测/物理键来补。

---

## 2.B PAPER TRAIL —— 纸面档案

### B.1 概念

> aimi 是你 agent 工作的**档案室**：每一次派活、审批、失败都留痕成一册账本；界面是纸，不是屏。

### B.2 参考锚点

Claude.ai 的暖纸 + serif + 单一珊瑚（`.../claude/DESIGN.md`）、Stripe Press 的档案版式（`https://stripe.press/`）、Braun 的"少而准"（`https://www.vitsoe.com/us/about/good-design`）。**刻意不参考任何 dev tool 的深色 UI。**

### B.3 亮色（主场景：纸）palette

| token | hex | 用途 | 实测对比度 |
|---|---|---|---|
| `paper` | `#F6F1E7` | 画布（暖纸） | — |
| `sheet` | `#FBF8F1` | 抬升纸面（composer、签批单） | — |
| `rule` | `#DCD3C2` | 规则线（1px / 3px 双线） | — |
| `ink` | `#1A1712` | 正文墨色 | 15.87:1 on paper ✅ |
| `ink-2` | `#5C5546` | 次级 | 6.56:1 ✅ |
| `ink-3` | `#6B6357` | 边注/斜体小字（≥12sp 才用） | 5.26:1 ✅ |
| `vermilion` | `#B3371F`（朱红） | 唯一电压：需你决定、印章、主键 | 5.36:1 on paper ✅ / 5.68:1 on sheet ✅ |
| `vermilion-text` | `#9C2E19` | 小号朱红文字（12–13sp 专用） | 6.62:1 ✅ |
| `ok` | `#2F5D3A`（墨绿） | 通过/归档 | 6.79:1 ✅ |
| `warn` | `#8A5A00`（赭） | 注意但不阻塞 | 5.27:1 ✅ |

### B.4 暗色（夜读档案）palette

| token | hex | 用途 | 实测对比度 |
|---|---|---|---|
| `paper` | `#14120F` | 画布（暖黑，非纯黑） | — |
| `sheet` | `#1C1915` | 抬升纸面 | — |
| `rule` | `#332E26` | 规则线 | — |
| `ink` | `#EDE6D8` | 正文（暖白） | 15.06:1 ✅ |
| `ink-2` | `#C9BCA6` | 次级 | 10.00:1 ✅ |
| `ink-3` | `#A79C88` | 边注 | 6.90:1 ✅ |
| `vermilion` | `#E0654A` | 朱红提亮（暗底必须提亮） | 5.11:1 ✅（on sheet 5.11） |
| `ok` | `#7FB08A` | 通过 | 7.55:1 ✅ |

### B.5 字体

- 展示（标题/项目名/数字）：**Fraunces**（Google Fonts，variable `SOFT/WONK`，400/600，负字距 -0.02em）—— 有"印刷 + 一点古怪"的档案气。
- 长正文：**Newsreader**（Google Fonts，400/500，行高 1.7）；或系统 serif 回退。
- UI 标签/按钮：**Inter**（400/500）或系统 sans —— 保证中文可用。
- 中文：**Noto Serif SC（思源宋体）** 用于标题与项目名（600），**Noto Sans SC** 用于 UI 与长正文备选（宋体在 12sp 以下中文发虚，正文若 <15sp 改用黑体）。
- 机器发言：**IBM Plex Mono** 12sp（唯一允许 mono 的地方）。

### B.6 看板布局原型（首屏）

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 aimi                            2026.10.17 · № 047
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 001  aiimi-server          ◉ 需要你签批
      relay 心跳改为 15s，等待批准写入          ← 摘要 13sp sans
─────────────────────────────────────────────
 002  prototypes            运行中
      审批卡底部抽屉原型，正在截图              ← 行尾 dashed 下划线动画
─────────────────────────────────────────────
 003  website               已归档 17:02
      首屏文案三版对比，选定第二版
─────────────────────────────────────────────
  ┌ 给 aimi 的批注 ─────────────────────┐
  │  （serif italic placeholder）        │
```
- 顶部 masthead：3px 上下双线夹一行 date line（serif small caps + 期号），无 logo 图形。
- 每行 = 账本条目：序号（serif tabular `001`）+ 项目名（Noto Serif SC 600 17sp）+ 单行摘要（Noto Sans SC 13sp `ink-2`）+ 右侧边注（斜体，状态）。行高 72dp，仅 `rule` 分隔线，**无卡片无圆角**。
- 需你决定的行：左侧 2px 朱红竖线 + 边注朱红「◉ 需要你签批」；不做闪烁（纸不发光），靠色与位置。
- 运行中：行尾一条 1px dashed 下划线做 marquee 流动（极轻，4s 一遍）。
- 底部 composer 是"批注条"：`sheet` 纸 + 上边 1px rule + serif italic placeholder。

### B.7 会话时间线布局

- 版式：左栏 44dp 时间戳（serif italic 10sp `ink-3`，如 `17:04`），右栏正文；整页保持一条 1px 规则线在 gutter 与正文之间（账簿栏线）。
- agent 正文：Newsreader 15sp / 行高 1.78 / `ink`；引用你的原话时用 serif italic + 左侧 2px `rule`。
- 机器发言（命令/工具/diff）：缩进 16dp，`paper` 略深一档底 + 1px 左 rule + IBM Plex Mono 12sp；标题行用 mono 小字 `BASH · 1.2s`。
- 审批/决策在时间线里是**"签批单"嵌片**：dotted 上边框 + mono 抬头 `APPROVAL SLIP · 17:04`，决定完成后右下盖一枚朱红方章（SVG，旋转 -4°，`准` / `驳回`）。
- 超长输出：折叠成"附件"行 —— `附件 A · 终端输出 214 行 ▸`（serif 斜体），点开全屏阅读器。
- 流式：正文末尾一枚 serif 长破折号 + 细线延伸动画（不要打字机、不要光标块）。

### B.8 审批交互

- 底部 sheet = 一张**签批单**：`sheet` 纸 + 顶部 1px 双线 + mono 抬头（`APPROVAL SLIP · 2026-10-17 17:04`）→ serif 标题（15sp「批准执行 `pnpm test`？」）→ 命令 band（`#EFE7D8` 纸色 + mono）→ 三键：
  - `批准`（朱红实心，radius 4dp，白字 — 5.68:1 ✅）
  - `始终批准`（1px `ink` 描边，透明底）
  - `拒绝`（下划线文本，`ink-2`）
- 确认后：印章动画（scale 1.15→1.0，120ms，-4° 旋转，轻微压印位移）+ sheet 收下。
- 拒绝需要"二次确认"：点拒绝后按钮变「确认拒绝」（朱红描边），2.5s 内再点。

### B.9 状态表达

**不使用信号灯色块**。状态用"文书标记"表达：
| 状态 | 表达 |
|---|---|
| RUN | 行尾 1px dashed 下划线流动（4s）+ 边注 `进行中`（serif italic `ink-3`） |
| WAIT | 朱红圆章 ◉ + 边注 `需要你签批`（朱红） |
| DONE | 边注 `已归档 17:02`（`ink-3`）+ 行首序号下加一条短 rule |
| ERR | **整行被朱红框住**（像红笔圈注，1px）+ 边注 `失败 · 需查看`（`vermilion-text`） |
| STALL | 边注 `静默 12m`（赭色，斜体） |

### B.10 优点 / 风险

- ✅ 气质最高、与"留痕/审计/可追溯"的产品内核（aimi 有 auditlog）天然同构；与所有 dev tool **最不像**，差异化最大；浅色长时间阅读最舒适；截图传播性强。
- ⚠ 实时感最弱（纸不闪烁），需要靠 dashed 流动/印章动效补；中文 serif 在 12–14sp 易糊（必须 ≥15sp 用宋体，或正文改黑体）；暗色"夜读"版本需要单独调（暖黑 + 提亮朱红）；"档案"若做得不好会显旧/脏/慢。

---

## 2.C TERMINAL BRUT —— 终端粗野

### C.1 概念

> 不用玻璃、不用圆角、不用渐变。aimi 像一张丝网印刷的终端海报：bone 纸或纯黑，2px 硬边，安全橙，超大 mono 数字，块状布局。

### C.2 参考锚点

瑞士/粗野主义版式与丝网印刷（高对比、硬边、整块色）；Bloomberg 的"功能键即导航"（`https://en.wikipedia.org/wiki/Bloomberg_Terminal`）；Teenage Engineering 的"一个彩色键"（`https://teenage.engineering/products/tp-7`）。反面参照：一切毛玻璃。

### C.3 亮色（bone）palette

| token | hex | 用途 | 实测对比度 |
|---|---|---|---|
| `bone` | `#EDE8DF` | 画布（骨白纸） | — |
| `panel` | `#FFFFFF` | 块面 | — |
| `ink` | `#101010` | 文字/2px 边框/硬投影 | 15.59:1 on bone ✅ |
| `ink-2` | `#5A5A5A` | 次级 | 5.65:1 ✅ |
| `mute-block` | `#B9B2A6` | 填充块（配黑字） | 9.04:1 ✅ |
| `orange` | `#FF4D00`（safety orange） | 唯一电压：填充、大数字、状态块 | **2.73:1 on bone ⚠ 不可作文字**；黑字在其上 5.72:1 ✅ |
| `orange-text` | `#C23A00`（橙的深版，仅文字用） | 需要橙色文字时 | 约 5:1（实现前复核，建议只在 ≥16sp/600 使用） |

> 铁律：橙色**只能当填充**（配黑字），永不作为 bone 上的小字。

### C.4 暗色（黑）palette

| token | hex | 用途 | 实测对比度 |
|---|---|---|---|
| `black` | `#0B0B0B` | 画布 | — |
| `panel` | `#141414` | 块面 | — |
| `ink` | `#F2F0EA` | 文字 | 17.27:1 ✅ |
| `ink-2` | `#A0A0A0` | 次级 | 7.53:1 ✅ |
| `orange` | `#FF5A00` | 电压：填充/大数字/状态块 | 6.29:1 on black ✅（暗色下橙可直接作文字） |
| `orange-on-panel` | `#FF5A00` on `#141414` | 面板上的橙 | 5.89:1 ✅ |

### C.5 字体

- 超大标题/数字：**Archivo Black**（Google Fonts，400 单字重，极粗几何无衬线）或 **Anton**；中文对应 **Noto Sans SC 900**（思源黑体 Heavy）。
- 标签/机身文字/机器：**Space Mono**（Google Fonts，400/700，带古怪的方正感）——比 IBM Plex Mono 更"海报"。
- 中文 UI：**Noto Sans SC** 500/700/900（不用 serif）。
- 数字：Space Mono 700 或 Archivo Black，超大号（32–56sp）做计数器。
- 规则：**只允许两种字体**（Archivo Black + Space Mono），中文补 Noto Sans SC；全大写标签 + `letter-spacing: .06em`。

### C.6 看板布局原型（首屏）

```
██████████████████████████████████████████
█  aimi                                  █  ← 2px 黑框整屏
█  2 ▌RUNNING   1 ▌WAITING   0 ▌ERR     █  ← 数字 32sp Archivo Black + 反白块标签
██████████████████████████████████████████
┌──────────────────────────────────────┐
│ aimi-server               ▛ RUN  ▜   │  ← 80dp 行：2px 黑边 + 4px/4px 硬投影
│ relay 心跳 · 4m                       │
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│ prototypes                ▛ WAIT ▜   │  ← WAIT 块 = 橙底黑字
│ 审批卡抽屉 · 1m                       │
└──────────────────────────────────────┘
██████████████████████████████████████████
█ PROMPT  ____________________  █ SEND █ █  ← composer：全宽 2px 黑边，SEND 是黑色方块
██████████████████████████████████████████
```
- 无圆角（radius 0），边框 2px `ink`，投影是**硬投影** `4px 4px 0 #101010`（无模糊）。
- 状态 = 反白块（blocky badge）：黑底骨白字（RUN）/ 橙底黑字（WAIT）/ 黑底橙字（ERR）/ 骨白底黑边（DONE）。
- 点击行：块整体位移 2dp + 投影缩到 2px（"按下去"的物理反馈）。
- 计数器数字用"数字滚动"（count-up 240ms, ease-out）。

### C.7 会话时间线布局

- 无 gutter 时间戳（时间戳可选开关，默认藏在块头右侧 mono 10sp）。
- **人说的话 = 黑块**（`ink` 底 + `bone` 字），**agent 说的话 = 白块**（`panel` 底 + 2px `ink` 边框）；机器输出 = `bone` 底 + 左侧 12dp 黑实心条 + Space Mono 12sp。
- 块间距 8dp，块内边距 16dp；分节用 2px 黑线 + 大写字距标签（`TOOLS` / `OUTPUT` / `APPROVAL`）。
- 转场：块"翻入"（rotateX 90°→0，90ms）或硬切；**禁止** fade、禁止 blur。
- 长输出：横向可滚动（不换行），块内滚动上限 40vh，超过折叠成 `+ 214 LINES` 黑块按钮。
- 流式：最后一块的 2px 底边变成橙色并在 0.9s 内水平伸展（扫满后重置）。

### C.8 审批交互

- **全屏 takeover**（不是 sheet）：整屏 `ink` 底、`bone` 字，顶部 40sp Archivo Black `ACTION REQUIRED`，下面一串 2px 分隔的段落：
  - `AGENT` → aimi-server（mono 12sp）
  - `COMMAND` → 黑底骨白的代码块（**橙字**，暗色下可读）
  - `RISK` → 高危时用橙底黑字块 `FORCE PUSH`
- 两个巨型块按钮（高 72dp，占满宽度，硬投影）：`APPROVE`（橙底黑字）/ `DENY`（骨白底黑字 2px 边）。DENY 在左、APPROVE 在右下（拇指自然落点）。
- 关闭 = 下滑（唯一允许的手势动画，短 120ms 位移）。
- 确认反馈：整屏 80ms 反相闪烁（黑↔骨白）+ 回到时间线插一块黑色 `APPROVED 17:05` 记录。

### C.9 状态表达

| 状态 | 表达 |
|---|---|
| RUN | 橙底黑字块 `RUN` + 块左侧 6dp 橙条 + 计数器数字滚动 |
| WAIT | 橙底黑字块 `WAIT` + 整行 2px 橙边框（双重编码） |
| DONE | 骨白底黑边框 `DONE` + 标题字重从 700 降到 500（完成=降权） |
| ERR | 黑底橙字块 `ERR` + 整行反相（黑底骨白字） |
| STALL | 橙底黑字 `STALL` + 块头一个 8dp 方点每 2s 硬闪一次 |

状态**同时用"块的颜色 + 边框 + 字重"三重编码**，色弱可用。文字标签可以存在（`RUN/WAIT`）——粗野主义不忌讳文字，忌讳的是模糊。

### C.10 优点 / 风险

- ✅ 与所有 AI 应用**零相似**；高对比在强光下最容易读；大按钮 = 手机单手最优；动效廉价（位移/硬切）且性格强；浅色 bone 在白天也不刺眼。
- ⚠ 长时间阅读疲劳（强对比 + 全大写）；"高级感"最弱，易被认为"简陋/未打磨"；纯黑 OLED 上 `#0B0B0B` 与 bone 反差极大，夜间需限制全屏反相；信息一多容易变成"贴纸墙"。

---

## 3. 横向对比

| 维度 | A MISSION CONTROL | B PAPER TRAIL | C TERMINAL BRUT |
|---|---|---|---|
| 与竞品差异度 | 中（都在暗色/等宽谱系，但与 Codex/Claude 明显不同） | **最高**（无 dev tool 这样做） | **最高**（反向审美） |
| 与上一版被否方向的距离 | 较近（暗+mono+信号灯） | 远 | 远（但同样高对比） |
| 暗光场景 | 最佳 | 需专门夜读版 | 好，但刺眼风险 |
| 强光/户外 | 中 | 好 | 最佳 |
| 长时间阅读 | 中 | **最佳** | 差 |
| 单手可达/误触安全 | 好 | 中（按钮偏小） | **最佳**（72dp 巨键） |
| 无障碍 | 好（三重编码） | 中（朱红/边注需严格字号） | 好（三重编码 + 大触控） |
| Flutter 实现成本 | 中（CustomPainter 图形小件多） | 中（字体/版式精细，动效少） | **低**（矩形 + 硬投影 + 字体） |
| 品牌延展（图标/商店/官网） | 好 | **最佳** | 好 |
| 首要风险 | 像"仪表盘套壳"、与旧稿重叠 | 实时感弱、中文 serif 落地 | 显廉价、易疲劳 |

### 我的推荐排序

1. **C TERMINAL BRUT** —— 唯一能在 3 秒内与 Codex/Claude/Cursor 全部区分开的方向；手机端巨键与高对比是真实可用性优势；实现最省。风险可控（橙只做填充、限制全屏反相频率、暗色模式用 `#0B0B0B` 而非纯黑）。
2. **B PAPER TRAIL** —— 气质与差异化最强，且与 aimi「留痕/审计/可追溯」的产品内核互为论证；但它把"实时监控"翻译成"档案阅读"，实时感必须靠动效硬撑，中文 serif 有真实落地成本。若选 B，建议 v1 只做浅色纸面，暗色留到 v1.1。
3. **A MISSION CONTROL** —— 最稳、最贴"指挥台"心智、最容易讲清楚，但也最像"这一类 app"，且与刚被否掉的方向在视觉词汇上重叠最多。若用户要"不冒险但不一样"，选 A，并把差异化压在网格/遥测/物理键上。

> 若只能选一个并且要冒一次险：**C**。若要一个能撑起品牌与官网的方向：**B**。若要最快出货：**A**。

---

## 4. 跨方向的可执行结论（从本轮调研里抽出的、与方向无关的事实）

1. **审批必须留在上下文里**：Codex app 的审批是时间线内嵌卡（不是模态弹窗），手机端则升级为底部 sheet。→ aimi 的审批应是"会话内的阻塞块 + 可直达的通知 action"，不要独立审批中心（`https://learn.chatgpt.com/docs/mobile`）。
2. **列表行要高密度但只承载三件事**：状态字形 + 名称 + 一条极短元信息。Zed（`https://zed.dev/`）、Codex（`refs/codex-multitask-dark.webp`）都如此；其余细节进详情。
3. **命令/输出/ID 一律等宽，散文一律非等宽**：这是六家共同的"谁在说话"编码，也是无障碍实现（`.../cursor/DESIGN.md`、`.../linear.app/DESIGN.md`）。
4. **单一电压**：Cursor 只有一个橙、Linear 只有一个薰衣草、Claude 只有一个珊瑚。aimi 也必须只保留一个"品牌色"，其余彩色全归状态语义（`.../claude/DESIGN.md`）。
5. **状态 = 颜色 + 形状 + 位置三重编码**：航空 PFD 的硬规则，直接解决色弱与强光问题（`https://en.wikipedia.org/wiki/Primary_flight_display`）。
6. **机器身份要"看起来像器件"**：Teenage Engineering 的键有键程、Bloomberg 的键是页面。aimi 的主操作（批准/发送）应有物理反馈（位移/压印/硬切），不要用 Material 的涟漪（`https://teenage.engineering/products/tp-7`）。
7. **密度是可行的，但靠固定列宽与等宽数字**，不是靠缩字号（Bloomberg 实证）。
8. **深色不等于黑**：Linear `#010102`、Codex 深色 `#191919`、Claude 深色 `#181715` —— 都是"带倾向的近黑"。aimi 若做暗色，应选一个带色相的近黑（A 的 `#07090B`、B 的 `#14120F`、C 的 `#0B0B0B`）。
9. **中文必须单独决定**：所有竞品的 serif/mono 都是拉丁字形优先，中文回退常被忽略。三方向都已给出中文搭配（Noto Sans SC / Noto Serif SC），落地时必须实测 12–17sp 的渲染。

---

## 5. 反模式（手机端不要照搬桌面端）

- ❌ 左侧固定导航栏 / 三级分栏（Codex app、Cursor 都靠宽屏）；手机只能是 1 层页 + 底部 composer + 全屏 sheet。
- ❌ hover、右键菜单、快捷键提示（`⌘K`）做为主要入口。
- ❌ 桌面级高密度表格（Bloomberg 那种 40 数据点）——手机一屏最多 8–10 行，其余靠抽屉。
- ❌ 用 8–9sp 字号塞信息（桌面截图缩放后会误导）；手机最小 11sp，正文 14–16sp。
- ❌ 用阴影做层级（桌面靠阴影分层很自然，手机上会显脏）；三方向都改用硬边/硬投影/规则线。
- ❌ 无限闪烁的告警点（手机常驻可见，会焦虑）；所有循环动画必须有 ≤3 个周期后转常亮的策略。
- ❌ 把"字体"当装饰：中文 serif 与 mono 混排需要逐字号验证，不能直接套拉丁方案。
- ❌ 纯黑 + 纯白满屏反相（OLED 上残影与刺眼）；反相只用于瞬时反馈（≤120ms）。

---

## 6. 落地建议（三方向共用）

- **Token 命名**：`surface.{canvas,panel,raise,line}` / `ink.{1,2,3}` / `accent` / `state.{run,wait,done,err,stall}` / `mono`, `sans`, `display` 三字体槽。三方向共用这一层结构，只换值 —— 这样选定方向后切另一案的成本最低。
- **组件清单（手机）**：`SessionRow`、`StatusGlyph`、`Composer`、`TimelineItem`（user/agent/tool/diff）、`ApprovalSheet`、`ConnectionBar`、`EmptyState`。
- **动效预算**：只允许三种动效族 —— 呼吸（状态）、扫线（流式）、硬切/位移（操作反馈）；禁止 blur/scale 弹跳/渐变位移。
- **可读性基线**：正文 ≥14sp、按钮 ≥44dp 高、状态色对比 ≥4.5:1（大色块 ≥3:1）、所有状态三重编码。
- **下一步需要用户拍板的**：方向（A/B/C）、主场景（暗优先还是纸优先）、是否允许中文 serif。

---

## 7. 参考图索引（`docs/research/refs/`）

| 文件 | 一句话要点 | 来源 |
|---|---|---|
| `codex-multitask-dark.webp` | Codex 深色任务列表：置顶会话（星标）+ 进行中（旋转）+ `Threads` 项目区（folder + 项目名 + 灰字类型标），行尾相对时间 | `https://developers.openai.com/codex/app/features`（产品页截图，本地留存） |
| `codex-multitask-light.webp` | 同一列表的浅色版：淡蓝紫面板 + 暖白画布，行首状态字形清晰可辨 | 同上 |
| `codex-terminal-dark.webp` | Composer 全貌：外框卡 + 内嵌输入 + `Local/Worktree/Cloud` 段选 + 锁/麦克风/圆形发送；下方内嵌终端（彩色 shell prompt + 绿色成功行） | 同上 |
| `codex-modes-dark.webp` | 环境模式选择与 tooltip（`Work in cloud environment`）；键位提示与模式切换的层级关系 | 同上 |
| `codex-approval-dark.webp` | 审批卡在时间线**行内**出现（图标 + 标题 + 问句 + `Cancel/Esc`、`Allow ↵`），不是弹窗；composer 底部还有 `Work locally` 切换 | 同上 |
| `zed-parallel-agents-sidebar.jpg` | 并行 agent 列表：按 workspace 分组、行 = 状态字形 + 标题 + `分支 · +25 -15 · 16m`；右侧工具动作压成一行 + `Thinking...` 字形 | `https://zed.dev/`（官方截图） |
| `zed-agent-panel.jpg` | Zed agent 面板的机器/散文混排质感（深灰绿近黑 + mono 行） | `https://zed.dev/` |
| `bloomberg-terminal.jpg` | 高密度范本：黑底琥珀/绿/青、顶部功能键 tab、等宽对齐的数字矩阵、颜色只编码涨跌 | Wikimedia Commons `File:Bloomberg Terminal.jpg` |
| `aviation-pfd-737.png` | 状态语义范本：绿/琥珀/红/青的严格分级 + 形状与位置三重编码 | Wikimedia Commons `File:Primary Flight Display of a Boeing 737-800.png` |
| `braun-sk4-phonosuper.jpg` | 1956 Braun SK4：象牙白 + 金属 + 一块透明盖，无装饰曲线，层级只靠分割线 | Wikimedia Commons `File:1956 Braun Phonosuper SK4 Schneewittchensarg.JPG` |
| `teenage-engineering-op1.jpg` | 单色机身 + 面板上仅有几个彩色键（蓝/绿/橙）+ 点阵显示：一个色就是全部电压 | Wikimedia Commons `File:The OP-1 by Teenage Engineering.jpg` |

---

## 8. 待确认

1. 用户对 A/B/C 的选择（或"B 的纸 + C 的巨键"这类杂交是否允许）。
2. 主使用场景：夜里床上看（A 优势）vs 通勤/白天强光（C 优势）vs 事后复盘/长文阅读（B 优势）。
3. 中文是否接受 serif（B 的前提）；若不接受，B 需退化为"黑体 + 档案版式"。
4. 是否允许在 v1 就做双主题（三方向都能做，但 B 的暗色成本最高）。
