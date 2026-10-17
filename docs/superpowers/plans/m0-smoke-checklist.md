# M0 真机冒烟清单（对照计划 T16/设计 G1/G2）

> 执行方式：人肉勾选（M0 不做真机自动化，见 T16 边界）。外网/relay 口径属 M1，不在本清单。
> 自动化的本机预算断言（延迟 P95/洪水帧数/8KB 截断）在 `apps/server/__tests__/e2e_lan_stream.test.ts`
> 的 `M0 性能预算（§7）` 块，随 `pnpm --filter @aimi/server test` 一起跑。

前置：PC `pnpm dev`（或 `aimi-server start`）→ 记下 lanUrl；`aimi-server lan-token` → 复制 token；
手机安装 debug APK（`flutter build apk --debug`）或 `flutter run`。

- [ ] 1 连接：Settings 填 host/port/token → 返回看板 → 徽标变绿"LAN"
- [ ] 2 新建：FAB → claude + 真实项目目录 + 任务"写一个 hello world 脚本" → 创建
- [ ] 3 实时流：时间线出现流式文本与工具卡（折叠可展开）
- [ ] 4 打断：任务运行中点打断 → 流停止；时间线无再新增 agent 事件
- [ ] 5 计时（目测×3 取中位）：终端/时间线文字出现 → 手机渲染 ≤ 1 s
- [ ] 6 断网恢复：手机开飞行模式 5s → 关闭 → 横幅"重连中"→ 徽标复绿 → 时间线继续（允许缺口，M1 重放）
- [ ] 7 杀进程恢复：手机杀掉 app → 重开 → 看板恢复（历史会话列表来自 welcome 全量）
- [ ] 8 PC 侧审计：`aimi-server status` 正常；audit 日志含 command.interrupt
- 实测记录：延迟中位 ___ ms；异常与截图（如有）
