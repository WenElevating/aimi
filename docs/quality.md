# aimi 质量保障体系

> 面向两类读者：**开发者**（怎么过门禁、失败了怎么排查）与 **agent**（AGENTS.md §8 约束的完整依据）。
> 体系建立于 2026-10，背景：大量代码由 AI 生成，门禁必须自动化、硬性、防绕过。

## 1. 体系全景图

```
提交（pre-commit, <15s）          推送（pre-push, ≤60s）           push CI（ci-fast）
  prettier --write ┐                typecheck ─┐                    check-deps
  eslint（暂存面）  ├ lint-staged    check-deps  ├ 60s 预算熔断        typecheck
  check-secrets    ┘                vitest related（推送范围）│       L1 单测 + tools 测试
                                                                  check-secrets 全仓快扫
PR CI（全量）                          夜间（nightly, 04:00）        ↓
  ci-server：全量测试+覆盖率           变异测试（Stryker, score≥70）  任何失败 =
    → 棘轮 + 增量覆盖率 → build        flaky 探测（全量×3）           ↓
    → audit → 洁净检查                audit 全量（含 dev）          阻断合并
  ci-mobile：analyze+test+棘轮        baseline 到期提醒
  audit：high/critical 阻塞
  hygiene：黑名单 + gitleaks
```

发布后：bump → `flutter build apk` → `pnpm publish-apk` → MuMu/真机验收清单（见 AGENTS.md §7）；
回滚 = `publish-apk` 重发旧版本 APK（manifest 版本号高者胜）。

## 2. 每道门禁的目的与本地运行方式

| 门禁 | 目的 | 本地运行 | 失败排查 |
|---|---|---|---|
| prettier | 格式一致（消灭无意义 diff 噪声） | 自动改写暂存文件，无需手动 | 极少失败；若冲突手动处理标记 |
| eslint | correctness + 安全底线（对象注入/子进程注入） | `pnpm exec eslint <files>` | 看 rule 名；只查暂存文件，存量代码不阻塞 |
| check-secrets | 密钥不进仓库（第一道；gitleaks 是第二道） | `pnpm secrets:check` | 命中且确为误报 → 行内加 `aimi-allow-secret`（CR 会查）；假密钥样本放 `__tests__/` 自动豁免 |
| pre-push gate | 推送前 typecheck + 依赖方向 + 受影响测试 | 自动（`node tools/pre-push-gate.mjs` 可手动跑） | 真失败 → 修代码；**超时** → 输出"检查未完成，降级为仅 CI 验证"，CI 兜底 |
| 覆盖率棘轮 | 全局覆盖率只升不降 | `pnpm coverage:check`（需先生成 lcov） | 全局降了 → 补测试；若 baseline 本身错误 → 单独 commit 上调（CR 审核） |
| 增量覆盖率 | 新增行必须有测试（server/protocol ≥80%，mobile ≥60% 季度 +5 爬升） | 同上（带 `--diff-base`） | 输出列出未覆盖样例行 → 补测试；测试文件不计分母 |
| check-audit | 依赖漏洞（仅 high/critical 阻塞） | `pnpm audit:check` | 升级依赖；确需豁免 → `tools/audit-exemptions.json` 登记 `{id,package,reason,expires}`（过期自动恢复阻塞） |
| check-hygiene | 仓库不留垃圾（截图/.env/会话产物/coverage） | `node tools/check-hygiene.mjs --skip-status` | 删除违规文件或移入白区（`resources/`、`docs/assets/`） |
| 变异测试 | 验证断言力度（防"有覆盖无断言"） | `pnpm --filter @aimi/server exec stryker run` | 存活变异清单 → 补断言；报告在 `apps/server/reports/mutation/` |

## 3. 测试分层

| 层 | 位置 | 运行 | 说明 |
|---|---|---|---|
| L1 单元 | `apps/server/src/**/*.test.ts`、protocol、mobile test/ | `pnpm --filter @aimi/server test:unit` 等 | 无真实子进程 |
| L2 e2e | `apps/server/__tests__/*.test.ts` | `pnpm --filter @aimi/server test:e2e` | 真实 ws + 假 CLI（`AIMI_FAKE_CLI_PATH`），必须串行 |
| L3 契约 | protocol schema ↔ mobile frame_dto 双侧镜像 | 随两侧 CI | 改协议必须同步两侧（AGENTS.md §7） |
| L4 真机 | MuMu/真机验收清单 | 发布前人工 | AGENTS.md §7 |

## 4. 风险分级与审核规则

- **高（双人，CODEOWNERS 强制审核）**：门禁文件自身（workflows/tools/钩子/baseline/lint 配置/锁文件）；业务高危（auth/session/migrate/protocol src/bin）
- **单人阶段附加规则**：高风险 PR 合并前需**独立 AI 会话审查**并在 PR 附结论
- **中**：agents/transport/ops/mobile data；**低**：ui/docs/配置
- baseline 只能单独 commit 上调；下调必须先开 issue 说明——否则视为绕过门禁

## 5. flaky 治理流程

1. nightly `flaky-probe` 全量 ×3，任何一轮失败即候选（job 红 + error 标注）
2. 维护者按输出开 issue：标题 `flaky: <用例名>`，**修复期限 14 天**
3. 超期未修 → 移入隔离清单（每条带 issue 链接），隔离文件属门禁文件需审核；修复 PR 必须同时移出
4. 隔离用例不进 PR CI，但夜间全量仍跑（防烂掉）

## 6. 门禁反向验证记录（2026-10-25，分支 quality/attack-test 已删）

| 攻击 | 预期 | 实际 |
|---|---|---|
| 暂存假密钥（sk-…） | check-secrets 退出 1 | ✅ 拦截 |
| git add -f 根目录截图 + .env | hygiene 退出 1 | ✅ 拦截（`git add -f` 绕 ignore 也被黑名单拦） |
| 故意失败的测试 | 测试红、test:tools 退出 1 | ✅ 拦截 |
| 无断言测试（有执行无 expect） | — | ⚠️ vitest 放行（已知缺口）——由变异测试兜底 + PR 模板断言点声明 |
| 伪造低覆盖 lcov | 棘轮退出 1 | ✅ 拦截（0% < 85.8%） |
| PR 内篡改 baseline 为 0 | `--base-origin` 读 main 版本，仍拦 | ✅ 拦截（0% < 85.8%） |
| pre-push 熔断路径 | 超时输出"检查未完成，降级为仅 CI 验证"并放行 | ✅ 触发（SIGTERM → 降级文案） |
| pre-push 无 upstream | — | ❌ **当时崩溃阻断推送（bug）** → 已修复（退化 HEAD~1 并收敛异常） |
| 篡改 CI 删检查步骤 | 必需检查缺失/失败即 BLOCKED | ✅ 拦截（真实 PR 实测：删覆盖率步骤后 ci-server+audit FAILURE、`mergeStateStatus=BLOCKED`）；⚠️ 教训：`enforce_admins=false` 时管理员可绕过——已改 `true` |

## 7. 已知缺口与路线图

1. **无断言测试不被 vitest 拦**（上表）——兜底：Stryker 试点（当前 score 75.81）+ PR 模板声明；路线图：eslint-plugin-vitest 的 `expect-expect` 规则进暂存面 lint
2. **变异覆盖薄弱点**：sessionMachine 37.5%（15 存活）、claudeProtocol 77.85%（49 存活）——补断言前先开 issue 锁定；score 阈值 70 起步后续上调
3. **Stryker 不可用时的降级**：一次性人工变异验收（脚本注入变异 → 人工逐类跑测试确认被杀 → 清单记入本文档并注日期）；当前 Stryker 可用，未触发降级
4. **check-deps.mjs 存量 2 处 security lint 命中**——lint 只查暂存面故不阻塞；计划单独清理
5. **篡改 CI 攻击待补验**（等你配置分支保护）
6. **mobile 增量阈值爬升**：60 → 每季度 +5 → 80 封顶；到期由 nightly baseline-expiry 提醒，上调须单独 commit

## 8. 平台配置（已全部生效，2026-10-25）

- 仓库已转**公开**（个人账号私有仓库的分支保护是 Pro 付费功能；公开后免费）——经 `gh api` 配置
- 分支保护 main：必需检查 = `ci-fast` / `ci-server` / `ci-mobile` / `audit` / `hygiene`；Code Owners 强审；**enforce_admins=true**（管理员同样受限——首战教训：false 时带 FAILURE 的 PR 照样可合）
- 禁 force push、禁删 main
- 本机：`pnpm install` 后 husky 自动生效（`git config core.hooksPath` = `.husky/_`）

**首战 CI 实战记录（2026-10-25）**——门禁第一次真跑就抓到 4 个本地从未复现的 bug：
1. tools 两个测试用 `../` 引用同目录脚本，CI checkout 下解析失败 → 修正为 `./`
2. `core.autocrlf=true` 干净 clone 出 CRLF，Vite transform CRLF+中文文件抛 Invalid token → `.gitattributes` 强制 LF（干净 clone 实验复现：CRLF 必红、LF 全绿）
3. npmmirror 镜像无 audit 端点，check-audit 把错误 JSON 误判为"无漏洞"（本地假绿）→ 显式指官方 registry
4. pnpm audit JSON 字段是 `module_name` 而非 `moduleName`，豁免永远匹配不上 → 修正并兜底

**实测耗时**：ci-fast 1.4 分钟（push）；PR 全量：ci-mobile 2.1 分钟、ci-server 约 2 分钟（fail-fast，全绿预计 4-6 分钟）、hygiene 0.3 分钟、audit 0.2 分钟——远低于预估的 8-12 分钟，暂无优化必要。

## 9. 新套件/新脚本接入清单

- 新测试套件 → `tools/coverage-baseline.json` 登记基线（WARN 放行一次，尽快登记）
- 新门禁脚本 → 必须带固定样本单测（`tools/*.test.ts`，`pnpm test:tools`），并加入 CODEOWNERS 高风险段
- 新增禁止入库的产物类型 → `tools/check-hygiene.mjs` FORBIDDEN 表 + 单测样本同步

### 10.1 AI review 实测结论（2026-10-25）

- **Copilot Free 层**：可在网页手动触发，但**不自动审查新 PR**（自动审查是付费 Copilot Code Review 功能）；`@copilot` 评论指令在免费层也不响应 PR 审查。升级付费后每个新 PR 自动审查。
- **CodeRabbit**（第三方 App，已在本仓库自动运行）：公开仓库免费自动总结每个 PR，不足 10 star 的仓库需在 PR 评论里点 "Trigger review" 手动触发一次审查——实测可用，AI 行内意见可用。
- **审批边界不变**：AI（Copilot/CodeRabbit/独立会话）只能 COMMENT；Approve 与 Merge 永远是人。
- **单人仓库审批规则教训**：「至少 1 人批准」对单人仓库结构性不可满足（GitHub 禁自批）——已从分支保护移除该条，保留必需检查/禁 force/管理员受限。审批职责由 PR 模板自查清单 + AI review + 人工网页查看承接。

### 10.2 平台安全功能（公开仓库免费，2026-10-25 开启）

- secret scanning（全仓历史密钥扫描）+ secret scanning push protection（含密钥推送直接被 GitHub 拒）+ dependabot alerts——与 check-secrets（pre-commit 第一道）、gitleaks（hygiene job 第二道）构成三层密钥防线。
