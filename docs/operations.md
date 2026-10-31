# 运维手册（部署 / 配对 / 发布 / 反馈 / 排障）

> 事实来源：CLI 帮助文本、CI 工作流与既有验证记录（2026-10-28 校对）。排障条目均来自真实发生过的案例。

## 1. 日常命令

```powershell
# 依赖（严格锁文件；移动端另需 PUB_HOSTED_URL，见 §5）
pnpm install --frozen-lockfile

# 服务（前台）
pnpm serve
# 生产常驻：Windows 计划任务自启（用户登录触发，仅 Windows）
pnpm --filter @aimi/server exec tsx src/bin/aimi-server.ts install
pnpm --filter @aimi/server exec tsx src/bin/aimi-server.ts uninstall

# 配对与设备
pnpm pair                                        # 扫码配对（根级快捷）
pnpm --filter @aimi/server exec tsx src/bin/aimi-server.ts devices
pnpm --filter @aimi/server exec tsx src/bin/aimi-server.ts revoke DEVICE_ID

# 状态与令牌
pnpm --filter @aimi/server exec tsx src/bin/aimi-server.ts status
pnpm --filter @aimi/server exec tsx src/bin/aimi-server.ts lan-token
```

## 2. 配置

- 位置：`--config <path>` 显式指定；否则自动发现 `~/.aimi-server/config.yaml`。键集与校验见 `apps/server/src/app/config.ts`（strict，未知键报错）。
- 非 loopback `host` 必须同时给 `tls.certFile` / `tls.keyFile`，否则启动失败（校验在 loadConfig 内）。
- relay：配置 `relay.url`（relay 的 server 拨入路由）+ `relay.serverToken` 后，服务端主动拨出；缺省纯 LAN。
- 备份：数据目录含 SQLite 库与令牌；结构迁移前先备份（历史做法：`data/backups/before-<change>-<date>.db` + 同名配置备份；配置含凭据不外传）。回滚须停服务并恢复匹配版本的库/配置与旧代码，不要让旧迁移逻辑写新结构库。

## 2.1 ZCode agent 接入（agents.zcode）

第二个 agent 适配器（claude 之外），以 zcode CLI 的**非交互模式**驱动（官方文档化契约：`--prompt/--cwd/--mode/--output-format stream-json/--resume`，每回合一个子进程）。

- **CLI 解析顺序**（首个命中即用）：`agents.zcode.executable` 配置 → 环境变量 `AIMI_ZCODE_CLI_PATH`（测试注入缝）→ PATH 上的 `zcode.exe`/`zcode.cjs` → 桌面版捆绑 `<安装根>\resources\glm\zcode.cjs`。`.cjs` 经服务端 Node 拉起——**Node ≥24**（zcode 要求；Node 22 下 `isInstalled` 恒 false）。
- **权限档位**：zcode 原生五档 `plan/build/edit/yolo/guarded`（不在 claude 旧上限阶梯命名空间内，未显式配置 `agents.allowedPermissionModes.zcode` 时按目录全量放行，显式配置则覆盖）。缺省档位 `edit`。headless 无审批客户端：需要 ask 的工具直接失败（`No permission client configured`），模型收到失败继续跑——`build`/`guarded` 的 ask 项在手机上表现为红色工具卡，会话不中断。
- **模型**：跟随 zcode 全局 provider 配置（`~/.zcode/v2/provider_config.json`），CLI 无 `--model`，会话级切换被拒（configure 报错）；welcome 投影只报当前活动模型单条。**该文件含 API key，服务端只提取模型 id，任何密钥内容不得进日志/事件**。
- **会话语义**：续接=新进程 `--resume <zcode sessionId>`（hint 自动回写）；中断=树杀当前回合进程（stopped）；分叉不支持（`forkCapable=false`，fork 帧回 `protocol.bad_frame`）；回合 30s 无事件 → 协议未确认 → 标灰（重启服务恢复）。
- **数据目录**：与 zcode 桌面端共用 `~/.zcode`（会话库 SQLite+WAL）——桌面端同时开着跑同一 provider 时注意并发写；隔离评测场景用 `ZCODE_DATA_BASE_DIR` 指独立目录（zcode 官方口径）。
- **线上验证**：`aimi-server status` 的 `agents` 数组应出现 `{id:"zcode", ok:true, version}`；未装时 `ok:false` 不影响 claude。

## 3. APK 发布（移动端发版）

```powershell
# 1) bump pubspec.yaml 版本（x.y.z+N）
# 2) 构建签名 APK（apps/mobile 下）
flutter build apk --release
# 3) 发布（版本号自动读 APK manifest；低版本号拒绝，--force 覆盖）
pnpm publish-apk <apk 绝对路径> --notes '变更摘要'
```

运行中的服务收到发布后经 update.info 推给在线手机；手机侧走自更新（下载 → sha256 校验 → 系统安装器）。发布命令用 APK **绝对路径**，避免 workspace 子命令工作目录差异。

## 4. 反馈处理

```powershell
pnpm --filter @aimi/server exec tsx src/bin/aimi-server.ts feedback list
pnpm --filter @aimi/server exec tsx src/bin/aimi-server.ts feedback show FEEDBACK_ID
pnpm --filter @aimi/server exec tsx src/bin/aimi-server.ts feedback set-status FEEDBACK_ID done
```

- 数据面：`{dataDir}/feedback/{id}/`（`meta.json` + `images/` + `log.zip`）。`status`（new/acked/done）为处理台账字段，旧文件缺省按 new。
- 处理记录沉淀到仓库 `.feedback/`（gitignore），台账与代码分支交叉核对。

## 5. 已知问题与排障

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| agent 子进程拉不起，报 `os error 1455 页面文件太小` | 宿主机页面文件/内存耗尽（并发进程过多） | 加大页面文件或减少并发会话；非应用缺陷 |
| 新建会话"打开目录加载不出来" | 目录列举 5s 超时（大目录/慢盘）；未知 io 错误不再误报为断线 | 重试或手动填路径；持续复现请附反馈日志 |
| `flutter pub get` 改写 pubspec.lock 的托管 URL | shell 缺 `PUB_HOSTED_URL` 镜像变量 | 跑 pub 前设置 `PUB_HOSTED_URL=https://pub.flutter-io.cn`（CI 用 pub.dev 口径，勿把改写提交） |
| 手机侧同账号被踢 | 单设备锁：同 token 新连接接管（BYE `taken_over`，后登者生效） | 预期行为；吊销走 `revoke`（BYE `revoked`） |
| wss 连不上（自签证书） | 证书未入信任链 | 配对 QR 携带证书指纹做 pinning（`data/connection/tls_pinning.dart`）；换证书需重新配对 |
| Flutter dart-sdk 缓存损坏（升级被打断） | 升级中断残局 | 用 `dart-sdk.old1` 等备份还原；升级前确认磁盘/页面文件充足 |
| 测试/联调临时资源滞留仓库根目录 | 违反仓库 hygiene | 临时产物进系统临时目录，验收证据固化进 `docs/` 或测试断言后即删 |

## 6. CI 与提交门禁

- CI（`.github/workflows/ci.yml`）：push 走 ci-fast 精简，PR 全量 + 覆盖率 + 审计。server 作业（windows-latest）：check-deps + typecheck + `pnpm -r test`（子进程用例依赖 Windows 行为）；mobile 作业（ubuntu-latest，Flutter 3.41.2）：pub get / analyze / test。
- husky：pre-commit 格式化/lint/密钥扫描（lint-staged，仅改动文件）；pre-push typecheck/依赖方向/受影响测试。勿 `--no-verify`。
- 提交历史：带 scope 的 Conventional Commits（`feat(server): …`、`fix(mobile): …`、`chore(mobile): bump version …`）。

## 7. 分支与发布流程（现行惯例）

- 分支命名沿用观察到的惯例：`feat/<topic>`、`fix/<topic>`、`docs/<topic>`（fix 分支曾带反馈 ID 后缀）；PR 合入 main，合并方式以 squash/merge 为主。

  > TODO: 待确认：是否强制 squash、是否启用分支保护与 PR 模板门禁（CODEOWNERS 已配置）——需仓库设置页核实。
- 发版口径：`pubspec.yaml` bump → 签名 APK → `pnpm publish-apk`（§3）。生产部署 = 本机服务（install 计划任务自启）；无独立生产环境。

  > TODO: 待确认：生产服务升级的停机窗口与数据迁移确认流程目前无成文规范。
