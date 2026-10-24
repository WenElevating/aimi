# 主流 agent 应用 UI 原始调研记录（证据层，2026-10-17）

> 定位：**原始调查记录（raw reference）**，只记录"看到了什么"，不做 aimi 的设计推荐。
> 设计方向已重置，三案见同目录 `2026-10-17-agent-app-ui-directions.md`；本文件不与方向推荐混写。
> 证据规则：官方截图 > 官方文档原文 > 二手 DESIGN.md；二手色值仅代表营销页，不等于产品内 token。
> 截图全部在 `docs/research/refs/`。

---

## 1. 调研对象与证据等级

| # | 对象 | 证据等级 | 取到的材料 |
|---|---|---|---|
| 1 | OpenAI Codex 桌面 app（macOS/Windows，2026.2） | 官方产品页截图（5 张本地留存）+ 官方文档 | 任务列表（明/暗）、composer、环境模式、行内审批卡、内嵌终端 |
| 2 | Codex 手机端（ChatGPT app 内） | 官方文档 + 其 HTML mockup 的**逐像素色值/尺寸** | 任务列表、审批、改动 diff、新任务 |
| 3 | Claude Code（CLI/TUI、IDE 扩展） | 官方文档 | statusline、权限确认、输出着色 |
| 4 | Claude.ai | 二手 DESIGN.md（营销面） | 暖纸 + 珊瑚 + serif 的完整色板与字体层级 |
| 5 | Cursor | 二手 DESIGN.md（营销面） | 奶油 + 橙 + 杂志排印 + AI 时间线 pastel |
| 6 | Linear | 二手 DESIGN.md（营销面） | 四级表面阶梯 + 三档发丝线 + 薰衣草单电压 |
| 7 | Zed | 官方产品页截图（2 张本地） | 并行 agent 侧栏、agent 面板混排 |

补充（非 dev-tool，供方向阶段使用）：Bloomberg Terminal、航空 PFD、Braun SK4、Teenage Engineering OP-1、Stripe Press —— 截图与观察记录同样在 `refs/`，用于"拉开差距"的视觉语言参考。

---

## 2. 六家共同 DNA（只陈述观察事实）

1. **表面阶梯做纵深**：Linear 用 4 级（`#010102 → #0f1011 → #141516 → #18191a → #191a1b`）；Claude 用奶油 3 级（`#faf9f5 → #f5f0e8 → #efe9de`）；Codex 深色用 `#191919` 卡片浮在更深底上。**没有一家用投影做主要层级**。
2. **发丝线替代阴影**：Linear 三档 `#23252a / #34343a / #3e3e44`；Cursor `#e6e5e0 / #efeee8 / #cfcdc4`；Codex 手机 mockup 用 `border-black/[0.055]`（≈ 5.5% 黑）。
3. **单一色电压**：Cursor 只有 `#f54e00`；Linear 只有 `#5e6ad2`；Claude 只有 `#cc785c`。彩度高的色只出现在品牌/主 CTA/焦点。
4. **等宽字体 = 机器在说话**：Codex 手机 mockup 里命令/文件/diff 全部 `font-mono`；Linear 的 mono 仅给状态与 ID；Cursor 的 JetBrains Mono 覆盖所有代码面。
5. **状态用"色 + 形 + 位"三重编码**：Codex 列表行首是字形（旋转环/星标/蓝点）；Zed 行首是字形 + 元信息；Claude Code 靠颜色区分发言者。
6. **密度靠固定列宽与对齐**，不靠缩字号：Zed 行 = 标题 + `分支 · +25 -15 · 16m`；Codex 行尾固定相对时间列。

---

## 3. 逐家拆解

### 3.1 Codex 桌面 app（重点）

**信息架构（从截图可观察）**

- 左侧栏：会话/线程列表，**置顶区在最上**（带星标字形），下面是普通会话；分区标题 `Threads`，右侧两个图标（新建、筛选）。
- 项目区：`folder 图标 + 项目名 + 灰色类型标签`（如 `My Skills skills`、`Desktop`）。项目与会话在同一列表里，靠图标区分层级。
- 行内元素（左 → 右）：状态字形（旋转=运行中 / 星=置顶 / 蓝点=有新内容）→ 标题（单行截断）→ 分支图标（可选）→ 相对时间（`4d` / `1d`，右对齐）。
- 主区（多任务截图）：**不是聊天窗口，而是"任务画布"**：顶部一个胶囊标签 `Computer Use | Open calculator to add 2+2`（工具 + 任务名），下面 `Working for 21s` 小字作为进行时态，然后是 agent 的 reasoning 散文（正文 + 行内等宽的命令/文件名），再往下是内嵌卡片式审批。
- 审批卡（`codex-approval-dark.webp`）：卡片嵌在时间线里 —— 头像/图标 + 标题（`Computer Use`）+ 问句（`Allow Codex to use Calculator?`）+ 左侧勾选（`Always allow`）+ 右侧两个按钮（`Cancel Esc` 幽灵、`Allow ↵` 实心浅色）。**快捷键提示直接写在按钮里**（Esc / ↵）。
- Composer（底部常驻）：外层大圆角卡（约 20px）内嵌一个圆角输入区（约 16px，1px 边框）+ 占位符 `Ask for follow-up changes`；第二行是工具簇：`+`、环境/自定义（`Custom ⌄`）、模型（`GPT-5.4 ⌄`）、推理档（`Extra High ⌄`）、锁、麦克风、圆形发送键（亮色圆形 + 向上箭头）。composer 外面还有一行 `Work locally ⌄` 作为运行位置切换。
- 独立 composer 截图（`codex-terminal-dark.webp`）：输入区下方是 `Local / Worktree / Cloud` 三个文本 tab（选中项无底色，靠字重/亮度区分），右下角是 `⌘ main` 分支选择；再往下是同宽的终端面板（`Terminal /bin/zsh` 标题 + 关闭 ×，内容是彩色 prompt `photobooth git:(main) × npm run dev` + 绿色 `✓ Ready in 598ms`）。
- 模式截图（`codex-modes-dark.webp`）：`Local / Worktree / Cloud` 的选中态是一个**浅色胶囊底**（`#2f2f31` 左右），旁边有 tooltip 气泡 `Work in cloud environment`（深色圆角小卡）。

**可观察的真实值（近似，来自截图取样 / 官方 mockup 代码）**

| 维度 | 桌面 app 截图观察 | Codex 手机端官方 mockup（精确） |
|---|---|---|
| 画面底 | 近黑 `#0b0b0c` 级别的暖黑 | 浅色卡 `white/97%`、深色卡 `#191919/95%` |
| 主文字 | `#e8e8e8` 级 | `#171717` / 深色 `#f4f4f4` |
| 次级文字 | `#8a8a8a` | `#777`、`#595959`、`#8c8c8c`、`#909095` |
| 圆角 | composer 外框 ~20px、内框 ~16px、按钮全圆/胶囊 | 卡片 ≈ `4cqw`（相对宽度）、内嵌 well ≈ `1.5cqw`、按钮全圆 `rounded-full` |
| 边框 | 极低对比 1px | `border-black/[0.055]`，深色 `border-white/[0.09]` |
| 阴影 | 桌面很少 | `0 18px 58px rgba(0,0,0,.18)`（浮层用） |
| 内边距 | 约 16–20px | 卡内 `px-[3.55cqw] py-[2.75cqw]`，well 内 `px-[1.6cqw] py-[1.55cqw]` |
| 字号 | 正文 13–14px，标题 13–14px（都偏小） | 标题 `2.2cqw`、正文 `1.78–1.9cqw`、元信息 `1.6–1.85cqw`（按 390pt 宽折算约 11–14pt） |
| 字体 | 系统 sans + 等宽（命令/代码） | sans + `font-mono`（命令、文件路径、diff） |
| 语义色 | 终端里绿/蓝/黄 | 成功 `#258b20`、diff 删除 `#d73a49` |

**Codex 手机端的信息架构（官方文档 mockup，最接近 aimi）**

- 任务列表：标题 `Codex` + 来源筛选 chips（`All` / `Cloud` / `MacBook` / `Studio`）→ `Pinned` 分组 → `Today` 分组；行 = 标题（单行）。
- 审批：`Permission requested`（小字灰）→ 问句 → 命令 well（mono + 终端图标）→ 三键：`Approve`（实心黑/白胶囊）、`Always approve`（描边胶囊）、`Deny`（小描边，在底部输入行右侧）；底部 `Tell Codex what to do` 输入（可"带话说批准"）。
- 改动：`Changes / 2 files changed +38 -12` → 文件行 `…/components/StatusBadge.tsx +24 -8` → `Lines 18–23` 的 diff（`-`/`+` 前缀）。
- 新任务：`MacBook / developers-website / Work locally / main` 四枚面包屑 chips + `Ask Codex` 输入 + 模型 chip（`6 Astra`）。

**可迁移观察（仅事实）**：审批是上下文内的块；命令总在 well 里；按钮永远带"下一步会发生什么"的措辞；输入框是常驻的，不藏在 FAB 后面。

### 3.2 Claude Code（CLI/TUI + IDE 扩展）

- `statusline` 是可配置的一行状态栏（官方文档提供配置方式），默认形态是**行内文字 + 少量符号**，不依赖大色块。
- 权限确认是 TUI 里的一次性问答块（y/n 语义），出现位置就在输出流中断处 —— **与 Codex 的"行内审批"同构**。
- 输出着色区分"谁在说话"与工具类型，正文等宽。整体无卡片、无圆角、无阴影，层级完全靠缩进、空行、颜色。
- 官方文档：`https://docs.claude.com/en/docs/claude-code/overview`、`https://docs.claude.com/en/docs/claude-code/statusline`。

### 3.3 Claude.ai（营销面 DESIGN.md）

- 画布 `#faf9f5`（暖奶油）、墨 `#141413`、唯一电压珊瑚 `#cc785c`（active `#a9583e`）。
- 展示字：Copernicus/Tiempos 类 slab-serif，**400 字重 + 负字距**（64px / -1.5px）；正文 StyreneB/Inter；代码 JetBrains Mono。
- 深色产品面 `#181715`、抬升 `#252320` —— 用来放代码/终端 mockup，形成"奶油 → 深色 → 珊瑚"的段落节奏。
- 圆角：按钮/输入 8px、卡片 12px、容器 16px、徽章 pill。
- 语义色 `#5db872` / `#d4a017` / `#c64545`。
- 来源：`https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/claude/DESIGN.md`

### 3.4 Cursor（营销面 DESIGN.md）

- 画布 `#f7f7f4`（暖奶油）、墨 `#26251e`、hairline `#e6e5e0`、白卡 `#ffffff`；唯一电压 `#f54e00`（active `#d04200`）。
- display 全 400 字重 + 负字距（72px / -2.16px）；JetBrains Mono 覆盖代码面。
- 独有 **AI 时间线 pastel**：thinking `#dfa88f`、grep `#9fc9a2`、read `#9fbbe0`、edit `#c0a8dd`、done `#c08532` —— 文档明确写"只用于产品内 agent 时间线，不当系统状态色"。
- 深度只用 hairline（无阴影）；按钮 8px、卡片 12px。
- 来源：`https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/cursor/DESIGN.md`

### 3.5 Linear（营销面 DESIGN.md）

- 画布 `#010102`（本合集最深的暗色）、四级表面 `#0f1011 / #141516 / #18191a / #191a1b`、三档线 `#23252a / #34343a / #3e3e44`。
- 文字 `#f7f8f8 / #d0d6e0 / #8a8f98 / #62666d`；唯一电压 `#5e6ad2`（hover `#828fff`、focus `#5e69d1`）。
- 字体：自定义 display/text，回退 SF Pro Display；mono 只用于代码与状态/ID。
- 圆角：按钮 8px、卡片 12px、截图容器 16px；**卡片不用 pill**；焦点环 2px 50% 电压色。
- 来源：`https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/linear.app/DESIGN.md`

### 3.6 Zed（官方截图）

- 近黑偏灰绿的面板（约 `#1c211e` 级）+ 更深的画布；文字暖白。
- Agent 侧栏：分组标题（`zed, cloud` / `zed.dev`）→ 行 = 状态字形（旋转环/星芒/勾）+ 标题（单行截断）+ 第二行元信息（`subagents... / first-pass · +25 -15 · 16m`）。**行高约两行、无卡片、仅 1px 分隔**。
- 主区：你的发言是带 1px 边框的圆角块（约 12px）；`Thinking...` 用小号灰字 + 星芒字形；工具动作压成单行（`Read xxx.md docs/ — L251-600`）并与散文混排；正文 sans、文件/代码 mono。
- 来源：`https://zed.dev/`（页面截图 `refs/zed-parallel-agents-sidebar.jpg`、`refs/zed-agent-panel.jpg`）。

---

## 4. 参考截图索引

| 文件 | 看点 | 来源 URL |
|---|---|---|
| `refs/codex-multitask-dark.webp` | Codex 深色任务列表 + 项目分区 | `https://developers.openai.com/codex/app/features` |
| `refs/codex-multitask-light.webp` | 同上的浅色版（淡蓝紫面板） | 同上 |
| `refs/codex-terminal-dark.webp` | composer + 内嵌终端 | 同上 |
| `refs/codex-modes-dark.webp` | 环境模式段选 + tooltip | 同上 |
| `refs/codex-approval-dark.webp` | 行内审批卡 + reasoning 混排 | 同上 |
| `refs/zed-parallel-agents-sidebar.jpg` | 并行 agent 列表与元信息行 | `https://zed.dev/` |
| `refs/zed-agent-panel.jpg` | agent 面板：散文与机器行混排 | `https://zed.dev/` |
| `refs/bloomberg-terminal.jpg` | 高密度等宽网格 + 功能键 tab | `https://en.wikipedia.org/wiki/Bloomberg_Terminal` |
| `refs/aviation-pfd-737.png` | 状态色三级语义 + 三重编码 | `https://en.wikipedia.org/wiki/Primary_flight_display` |
| `refs/braun-sk4-phonosuper.jpg` | 极简工业表面 | Wikimedia Commons `File:1956 Braun Phonosuper SK4 Schneewittchensarg.JPG` |
| `refs/teenage-engineering-op1.jpg` | 单色机身 + 单点彩键 + 点阵显示 | Wikimedia Commons `File:The OP-1 by Teenage Engineering.jpg` |

---

## 5. 未取得 / 未验证

- Codex app 官方页面原始 URL 会 302 到 `learn.chatgpt.com`，本文引用的正文来自 `https://learn.chatgpt.com/docs/mobile` 与 `https://learn.chatgpt.com/docs/features`；5 张产品截图由任务方预下载，未能独立核验其对应页面位置。
- Cursor / Linear / Claude 的产品内 UI（非营销页）未取得官方截图，相关描述仅来自营销页 DESIGN.md。
- Claude Code 的 IDE 扩展视觉未取得截图，只有 CLI 文档。
- 未登录任何产品，未采集运行时真实 token。
