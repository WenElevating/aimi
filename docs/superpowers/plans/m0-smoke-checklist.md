# M0 真机冒烟清单（对照计划 T16/设计 G1/G2）

> 执行方式：人肉勾选（M0 不做真机自动化，见 T16 边界）。外网/relay 口径属 M1，不在本清单。
> 自动化的本机预算断言（延迟 P95/洪水帧数/8KB 截断）在 `apps/server/__tests__/e2e_lan_stream.test.ts`
> 的 `M0 性能预算（§7）` 块，随 `pnpm --filter @aimi/server test` 一起跑。

前置：PC `pnpm dev`（或 `aimi-server start`）→ 记下 lanUrl；`aimi-server lan-token` → 复制 token；
手机安装 debug APK（`flutter build apk --debug`）或 `flutter run`。

- [x] 1 连接：Settings 填 host/port/token → 返回看板 → 徽标变绿"LAN"（AVD + MuMu 双端复验；MuMu 内 host 用 10.0.2.2 直连宿主）
- [x] 2 新建：FAB → claude + 真实项目目录 + 任务"写一个 hello world 脚本" → 创建（claude CLI 2.1.286 真实拉起；沙箱 D:/AiProject/aimi-smoke-sandbox 实写 hello.py 并运行）
- [x] 3 实时流：时间线出现流式文本与工具卡（折叠可展开；真实 Write/Bash 卡均"完成"）
- [x] 4 打断：任务运行中点打断 → 流停止；时间线无再新增 agent 事件（两轮实测：最后 text_delta 与 command.interrupt 审计时间差 100ms/97ms，此后零增量；见发现 #1/#2）
- [x] 5 计时（目测×3 取中位）：终端/时间线文字出现 → 手机渲染 ≤ 1 s（adb 驱动下改用三方口径：e2e P95 22~24ms（loopback 自动化）+ 打断命令端到端 <1.3s + delta 逐条 ~110ms 到达节奏；人眼目测项留待真机复查）
- [x] 6 断网恢复：手机开飞行模式 5s → 关闭 → 横幅"重连中"→ 徽标复绿 → 时间线继续（MuMu 真演练：飞行模式引发平台级 adb 断链，sh 通道关闭飞行模式后徽标复绿、4 会话镜像恢复；发现 #3/#4）
- [x] 7 杀进程恢复：手机杀掉 app → 重开 → 看板恢复（历史会话列表来自 welcome 全量；force-stop 后 LAN 绿标自愈 + 列表完整）
- [x] 8 PC 侧审计：`aimi-server status` 正常；audit 日志含 command.interrupt（12 条全量：session_create×3 / send×5 / interrupt×3）
- 实测记录：延迟中位（自动化代口径）**P95 22~24 ms**；打断命令端到端 <1.3 s；异常与截图见 `.superpowers/sdd/progress.md` 冒烟线（发现 #1~#6，截图 smoke-*.png / smoke-m*.png 未入库）

> 本次执行导演机：模拟器替换真机（用户指定 MuMu；AVD 用于首轮与断网项收尾替代）。服务端真实 claude、真实项目目录、真实审计全为原文口径。

## M0 验收对账（Task 18 AC 表，2026-10-18 收口）

| AC | 结果 | 实测证据 |
|---|---|---|
| 1 流式渲染 | ✅ | AVD+MuMu 双端：流式文本/工具卡渲染正常（smoke-m 系列截图） |
| 2 打断+审计 | ✅ | audit 12 条含 interrupt×3；最后 delta 与 interrupt 差 97/100ms 后零增量；clientId 幂等 e2e 用例覆盖 |
| 3 延迟 P95≤1000ms ≥20 样本 | ✅ | e2e 实测（2026-10-18）：`n=20 P95=33ms min=15ms max=33ms`（loopback；真机 LAN 口径留插机复查） |
| 4 seq 保序 | ✅ | e2e 用例 1 seq 严格递增断言通过；MuMu airplane 断连往返后时间线无乱序（缺口重放属 M1） |
| 5 全仓测试+吞吐 | ✅ | CI run 39087181320 全绿（server+mobile）；吞吐 T5 实测 4.9k~12.3k events/s（≥500 预算 10 倍富余） |
| 6 崩溃韧性 | ✅ | 实战：taskkill /T /F 硬杀 server 树 → 8787 失联 → status CLI 直读 DB 正常（sessions=4 devices=1）、-wal/-shm 自动合并自恢复 → 重启后手机 12s 内"重连中"→LAN 复绿（ac6-serverdead/revived-phone.png） |

崩溃韧性顺带验证了 M0 断线重连 UX 全程：server 死时徽标"● 重连中（橙）"+ 横幅"重连中，可能错过消息"，server 复活后自动复绿——与清单 6 的飞行模式场景互为印证。
