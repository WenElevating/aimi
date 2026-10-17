# aimi 头脑风暴进度

- [x] 1. 探索项目上下文（空仓库）
- [x] 2. 逐个澄清问题（9 问已毕：连接场景/客户端形态/接入方式/协调语义/操作深度/机器范围/定位/中继/OS）
- [x] 3. 方案对比与推荐（A: Flutter + Node/TS daemon + 自建 WS 中继 —— 已选中）
- [ ] 4. 分节呈现架构设计并逐节确认（已完成 1~7 节；UI 决定单独立项：本 spec 仅含屏幕骨架级，视觉/交互细节留 UI 专项阶段；另 4.2 已按用户要求修订为 SQLite + ConversationRepository 抽象，server 不叫 daemon 叫 aimi-server）
- [ ] 5. 运行质量维度逐项落实（性能/可靠/安全/可观测/容量 + 不适用项说明）
- [ ] 6. 写设计文档（改为用户指定规范：docs/superpowers/specs/…-design.md，含 builder check 流程；26 节 spec 模板弃用）
- [ ] 7. builder check（派 subagent 按 builder-check-prompt.md 审查，问题分三堆）
- [ ] 8. 用户审阅批准 design.md
- [ ] 9. 转 superpowers:writing-plans 写实施计划

## 已定决策
- LAN + WAN（自有云服务器中继）；Flutter 双端；daemon 接管启动 agent；多会话并行监控；交互式控制；1 台 Windows PC；自用工具
- 适配对象：claude code / codex / opencode / zcode
