# 自动更新与 GitHub Actions 自动化

> 职责（唯一）：自动更新工作流的执行链路、触发与权限隔离、镜像版本选型、批次校验与 PR 合并门禁。
> 关键不变量同时由 [lib/workflow.test.mjs](../.github/lib/workflow.test.mjs) 与
> [lib/pr-flow.test.mjs](../.github/lib/pr-flow.test.mjs) 回归锁定（改错会在 `npm test` 失败）。

## 1. 事件与权限隔离（安全不变量）

[`.github/workflows/auto-update.yml`](../.github/workflows/auto-update.yml) 分成两个**权限与事件完全隔离**的 job：

| Job | 触发事件 | 权限 | 职责 |
|---|---|---|---|
| `validate` | 所有事件（含 `pull_request`） | `contents: read` | 只读：`npm test` + `npm run lint` + `npm run docs:check`。lint 分级拦截：error（P0/P1）阻塞合并，warning（P2）转 `::warning::` 标注仅提示。不碰 Token、不写仓库 |
| `auto-update` | 仅 `schedule` / `workflow_dispatch` / 受控 `push`（后两者限 `main`） | `contents: write` + `pull-requests: write` + `checks: read` + `statuses: read` | 检测 → 改 README → 校验 → 开 PR → 等检查 → 合并 |

> `checks: read` / `statuses: read` 是合并门禁的**必需项**：合并门禁要读目标 PR 的
> Check Runs（`/commits/{sha}/check-runs`）与合并状态（`/commits/{sha}/status`），
> 缺任一 scope 这两个接口直接 403 → 门禁恒为 `unknown` → 永不合并（2026-11 审计 P1-9）。

铁律（改动本工作流时必须保持；源自 2026-11-01 CI 提权漏洞复盘，见 [postmortems.md](postmortems.md#auto-update-工作流曾是-ci-提权面2026-11-01)）：

1. **PR 事件只能跑只读 job**：`validate` 用 `contents: read`、`persist-credentials: false`、不接触任何 secret。
2. **写操作 job 必须事件白名单 + 限 `main`**（`if: schedule || ((workflow_dispatch || push) && github.ref == 'refs/heads/main')`），
   PR 事件永远进不了持有 `PAT_TOKEN` 的 job。
3. **工作流顶层 `permissions: {}`**，各 job 按需申请最小 scope。
4. **PAT 只出现在写操作 job**；只读 job 连 `GITHUB_TOKEN` 都不落盘。
5. **脚本层再加一道护栏**：[detect-updates.mjs](../.github/scripts/detect-updates.mjs) 与
   [open-update-pr.mjs](../.github/bin/open-update-pr.mjs) 开头都校验 `GITHUB_EVENT_NAME`，
   在 `pull_request` / `pull_request_target` 下直接退出（后者走
   [lib/github.mjs](../.github/lib/github.mjs) 的 `isAuthorizedWriteEvent` 白名单）。工作流配错也不会写仓库。
6. `concurrency` 区分 PR 校验与批次更新（`group` 含 `github.event_name`），避免互相阻塞或并行写分支。
7. **`pull_request` 触发器不得加 `paths` 过滤**：路径过滤会让 `validate` 在「只改 README /
   非白名单文件」的 PR 上根本不跑 → 必需检查从未出现 → GitHub 视为未通过 → PR 永久卡死
   （2026-11 审计 P0-1 触发路径 + required check 死锁）。
8. **必需检查名必须双写一致**：工作流的 `REQUIRED_CHECKS` 环境变量与 `validate` job 的 `name:`
   必须完全相同（由 [lib/workflow.test.mjs](../.github/lib/workflow.test.mjs) 锁定），
   否则合并门禁永远匹配不上目标 PR 的检查。


## 2. 检测链路（detect）

入口：[`.github/scripts/detect-updates.mjs`](../.github/scripts/detect-updates.mjs)；
可在本地 dry-run：`npm run detect:dry-run`（不写盘）。旧壳 `scripts/check-updates.sh` 已废弃，
只是转发参数，勿再扩展。

三态结果：每个应用产出 `success` / `skipped` / `failed`（写入 `updates.json` 的 `results` + `summary`）。
**Registry 网络错误绝不算「无更新」**；存在 failed 时脚本退出码 2，workflow 末尾「检测失败门禁」
步骤显式 `exit 1` 让整个 workflow 变红。

此外每条结果还带两个**显式字段**（目标 §三.1 / §七.1）：

| 字段 | 取值 | 含义 |
|---|---|---|
| `detectStatus` | `HAS_UPDATE` / `NO_UPDATE` / `SKIPPED` / `FAILED` | 检测阶段的**四态结论**（由 [lib/execution-result.mjs](../.github/lib/execution-result.mjs) 的 `detectStatusFromResult` 统一推导，各分支不手写，避免口径漂移） |
| `currentVersion` | 版本目录名 | 应用当前本地版本（跨版本保护选中的 `maxKnown`） |
| `latestVersion` | 上游 tag | 本次检测到的上游版本（无更新时为 `null`） |

`detectStatus` 与 `status/code` 的对应：`success`+`update-found` → `HAS_UPDATE`；
`success`+`no-update` → `NO_UPDATE`；`skipped` → `SKIPPED`；`failed` → `FAILED`。
**网络异常 / 限流 / 解析失败永远落在 `FAILED`**，绝不落到 `NO_UPDATE`。

2026-11 可靠性治理补充的不变量：

- **上游响应形状异常 = 失败**：HTTP 200 但缺少 `results` / `tags` 字段（或类型不对）时
  [lib/registry.mjs](../.github/lib/registry.mjs) 的 `assertTagArray` **抛错**，
  不得静默归一成「空 tag 列表」→ 旧实现会把上游异常误判成「已是最新」。
- **空 tag 列表 ≠ 无更新**：查询成功但没有可用稳定 tag 时应用结论是 `skipped` +
  `no-stable-tag`（**不是** `success`/`no-update`）。
- **过滤名打错 = 失败**：`APPS_FILTER` 过滤后命中 0 个应用 → 直接非零退出，
  不允许「扫描 0 个应用」伪装成功。
- **429 / 5xx / 网络抖动自动重试**（指数退避，`sleep` 可注入便于单测）；404 不重试。
- **翻页达上限 = 失败**：tag 列表不完整时抛错，不许沿用半截数据算「最新版本」。

### 2.1 新版本目录的原子生成（Staging → Validation → Commit）

新版本目录**不直接写进仓库正式树**，而是走
[lib/version-writer.mjs](../.github/lib/version-writer.mjs) 的三段式流程：

1. **Staging**：在 `<repoRoot>/.staging/<app>/<toDir>/` 里复制来源版本目录并写入受管文件
   （`docker-compose.yml` / `data.yml`）。正式目录此时**零改动**。
2. **Validation**：对 staging 目录直接复用已交付的 SSOT 校验能力 ——
   `node .github/bin/lint-apps.mjs --root <stagingRoot> --json`（局部扫描模式：
   豁免表仍从真实仓库读、跳过死亡豁免判定、跳过全仓镜像策略不变式）
   + [lib/validate-batch.mjs](../.github/lib/validate-batch.mjs) 的批次一致性校验。
3. **Commit**：校验通过才 `renameSync` 进正式目录（同文件系统 → 原子）。

目标版本目录已存在时**永不删除、永不覆盖**：

| 情形 | 处置 |
|---|---|
| 目标不存在 | `CREATE` —— rename 进正式目录 |
| 目标存在且**同名**（就地更新当前版本目录的受管文件） | `UPDATE` —— 只替换受管文件，其余文件（`data/` / `scripts/`）不动 |
| 目标存在且与产物**完全一致** | `IDEMPOTENT` —— 幂等跳过（`SKIPPED / ALREADY_EXISTS`） |
| 目标存在且内容不同 | `CONFLICT` —— **报错拦截**，禁止覆盖（历史版本不可变） |

任一步失败只清理**本次** staging 目录（路径必须落在 `.staging` 之内），
正式目录与用户已有文件零污染；下次运行会自愈残留 staging。

跳过条件（与实现一致）：

- `SKIP_AUTO_UPDATE_APPS = ['anythingllm', 'jellyfin']`（手维护；混排日期型目录，防跨目录覆盖，
  见 [postmortems.md](postmortems.md#jellyfin-日期型目录被跨目录覆盖2026-09-25)）。
- 变量型应用（compose 用 `${IMAGE}` / `${APP_VERSION}`）不入自动范围，存量例外见
  [compose-conventions.md §1](compose-conventions.md#1-compose-硬规则红线)（silo / infinity/cu124 / xunlei）。
- `latest` 作镜像 tag 的应用跳过（版本漂移语义，见 [app-structure.md §2](app-structure.md#2-版本目录规则)）。

## 3. 镜像版本选型口径

- **DockerHub**：`page_size=100&ordering=last_updated` 翻页（上限 5 页 = 500 tag），
  过滤不稳定关键字（`latest|nightly|dev|edge`）后取末位。page_size 曾因多架构镜像（anirss 30+ tag）
  单页截断漏检 arm32v7（PR #19 复盘）；翻页兜底防 5+ tag/版本被切。
- **GHCR**：OCI Registry API + 匿名 pull token（`https://ghcr.io/token?scope=repository:<repo>:pull`）,
  `tags/list?n=1000` 且**必须跟随 `Link: rel="next"` 翻页（MAX_PAGES=10）**。GitHub Packages API
  对匿名返回 401，勿用。GHCR tag 是**字典序**返回（最旧在前），不翻页会误选远古版本
  （traefik `3.0.3` 事故）；分页中途失败**必须抛错**，不许沿用半截数据。
  黑名单额外包含 `alpha|beta|rc|main|master`。
- **变体识别（4 种形态）**：裸变体（`pg`）、变体+版本（`pg-1.16.0`）、semver+后缀架构
  （`v3.2.18-arm32v7` 同 suffix 末位，anirss 场景）、4 段以上纯数字 tag 同段数选取
  （collabora `26.04.5.1.1`，防 2017 年 `2.1.5` 老镜像抢占）。同形候选不存在时 fallback，
  **宁可不报也不误报**。
- **SemVer 两套语义，禁止混用**：
  - `parseSemver` / `isValidSemver` / `compareSemver` = **严格 SemVer 2.0.0**
    （`latest` / `2024.08` / `26.04.5.1.1` 一律非法）；`parse('latest')` 返回 `null`。
  - `parse` / `compare` / `compareVersionsLoose` = **宽松数字段比较**，只用于「已知形态 tag」
    的排序与版本目录归档选择。

## 4. 批次校验与 PR 门禁

开 PR 前 [lib/validate-batch.mjs](../.github/lib/validate-batch.mjs) 做全量配置校验
（data.yml YAML+schema / 目录结构 / compose 语法 / 更新后的镜像 tag / README 版本一致性），
有 error 就不开 PR。

PR 创建后 [open-update-pr.mjs](../.github/bin/open-update-pr.mjs) 的合并流程
（细节全部走 [lib/github.mjs](../.github/lib/github.mjs)）：

- 防重：**按分支前缀 `auto-update/` 识别**自动更新 PR（`findAutoUpdatePullRequests`），
  人工 PR（`feat/` / `fix/` / `docs/` …）永远不会被认领、覆盖或关闭。
  查询失败 = 中止（不做任何写操作，分支不创建），绝不在「无法确认是否重复」的情况下继续创建。
- 复用：已有未合并的自动更新 PR 时**复用其分支并更新该 PR**（幂等），
  **不再像旧实现那样 `return 0` 静默跳过**（那会让 workflow 全绿却丢掉整批更新）；
  同时存在多个未合并的自动更新 PR 时**显式失败**，交人工裁决。
- 推送：分支名 `auto-update/<date>`（单 PR 合并本批次全部变更）。**全程不使用任何 force**：
  远端已有同名分支时先 `fetch` + `rebase --onto FETCH_HEAD`，再普通快进 `push`；
  rebase 冲突则中止并保留本地提交（不覆盖任何人的提交）。
- 暂存：`git add -- <本次改动的应用目录白名单>`（**不是** `git add -A`），
  工作区残留文件不会被卷进批次 PR；无改动时不产生空提交。
- 批次校验**前移到 `git add` / `commit` / `push` 之前**：坏内容不再先进远端分支才被拦。
- 合并门禁：轮询 GitHub Checks + combined status，**键控到目标 PR 的最新 head SHA**
  （不是触发 workflow 自身的 SHA）；**必须逐个确认 `REQUIRED_CHECKS` 里的必需检查
  已出现且 `completed + success`**，缺任一 → 继续等待直至超时 → **绝不合并**
  （旧实现只要求「该 SHA 上至少有一个 check run 且全绿」，一个**无关的**第三方
  check 成功就会被判为通过 → 提前合并，属 P0 漏洞）。
  failure / timeout / unknown / 缺检查 一律**保留 PR 与远程分支**、非零退出。
- **head SHA 变化 → 作废旧结论**：等待期间重新读 PR 的 head SHA，变化则换新 SHA 重新验证。
- **合并带 sha 护栏**：合并请求体带 `sha: <等待检查的 head SHA>`。若等待期间分支被再次推送，
  GitHub 返回 409（Head branch was modified）→ 不合并，避免把「未经验证的新提交」并入 main
  （回归见 lib/github.test.mjs「merge 带 expectedHeadSha …」与 pr-flow.test.mjs 同名断言）。
- GitHub 对 `pull_request` 事件按 **PR 的 HEAD commit message 与 PR title/body** 判定 skip 指令：
  自动更新的 commit message 与 PR title **不得含 `[skip ci]` 等 skip 指令**，否则 `pull_request`
  检查永远停留 Pending → 合并门禁必然超时（回归见 lib/github.test.mjs 的 `buildCommitMessage` /
  `buildPullRequestTitle`）。合并后的「push 递归触发」由工作流 `on.push.paths` 白名单防住
  （只匹配 `.github/**` 等自动更新链路自身文件）。
- Token：`secrets.PAT_TOKEN`（**缺失时直接中止**——`GITHUB_TOKEN` 创建的 PR 不会触发
  `pull_request` 工作流 → 必需检查不出现 → 合并门禁必然超时，
  **本仓必须配置 `secrets.PAT_TOKEN`**）。Token 缺失时脚本直接非零退出，不静默降级。
- 失败处理铁律：API 响应必须做形状校验（"JSON 能 parse" ≠ "业务成功"）；
  API 错误日志**必须含 HTTP 状态码 + 响应摘要**；失败时**绝不执行清理动作**
  （删分支 / 删文件）；remote 分支只在 PR 合并成功后删除。全部调用用 Node 内置 `fetch` /
  `execFileSync` 参数数组，**绝不把不可信内容（PR body / commit message）拼进 shell 命令字符串**
  （2026-10-20 事故复盘，见 postmortems.md）。

### 4.1 回归测试分层（PR 编排链路）

PR 门禁的三层回归，各管一段，互不重叠：

| 层 | 文件 | 验证对象 |
|---|---|---|
| 源码不变量 | [lib/pr-flow.test.mjs](../.github/lib/pr-flow.test.mjs) | 脚本**结构**不变量：零 force、批次校验前移、git add 白名单、禁止静默跳过、requiredChecks 绑定 |
| 函数级 mock | [lib/github.test.mjs](../.github/lib/github.test.mjs) | 单个 API 行为：必需检查门禁、sha-changed、错误状态码、分支前缀识别 |
| **进程级隔离 E2E** | [lib/pr-flow-e2e.test.mjs](../.github/lib/pr-flow-e2e.test.mjs) | **整条编排链路**：git 分支 → 提交 → 推送 → 开/复用 PR → 等检查 → 合并 → 删分支 |

E2E 层的隔离方式（满足「测试隔离铁律」）：git 远端是**本地裸仓库**（`git init --bare`），
GitHub API 是**本地 mock HTTP 服务**（`GITHUB_API_BASE` 指向 `127.0.0.1` 临时端口），
检查状态由 mock 返回 —— **绝不触达 GitHub、绝不产生真实 push / PR / 合并**。
覆盖场景：完整链路、幂等重跑、复用既有自动更新 PR、**detect → PR 交接**（updates.json
里的应用目录确实被提交进批次）、多个未合并 PR 显式失败、必需检查失败不合并、
**必需检查缺失（0 Checks）不提前合并**。

### 4.2 执行结果与 Summary（可观测性）

端到端执行轨迹写在仓库根 `execution.json`（已 gitignore），字段与 schema 定义在
[lib/execution-result.mjs](../.github/lib/execution-result.mjs)：
应用名、当前本地版本、检测到的上游版本、最终状态
（`UPDATED` / `NO_UPDATE` / `SKIPPED` / `WARNING` / `FAILED`）、
六个阶段结果（检测 → 目录生成 → SSOT 校验 → PR → CI → 合并，含 PR 编号/链接）、
失败或跳过原因与出错阶段。

渲染由 [lib/report.mjs](../.github/lib/report.mjs) 统一实现（唯一渲染入口）：
`renderExecutionMarkdown` 写 `$GITHUB_STEP_SUMMARY`（GitHub Actions），
`renderExecutionSummary` 在本地/非 Actions 环境降级为控制台结构化输出。
Summary 必须给出**成功更新 / 无更新 / 幂等跳过 / 警告 / 失败**五类清单，
禁止只输出一条笼统的成功或失败日志。

Summary 的「每应用执行轨迹」表逐项展示目标 §七.1 要求的字段：
应用名、检测状态（`detectStatus`）、当前本地版本、上游版本、最终状态、原因；
失败应用另有「失败明细」表（stage / reason / error）。


## 5. README 同步

自动更新命中后同步仓库根 `README.md` 应用列表表格（应用名/描述/版本）：

- 应用名映射与描述覆盖：[`.github/app-aliases.yml`](../.github/app-aliases.yml)
- 同步脚本：[`.github/scripts/sync-readme.mjs`](../.github/scripts/sync-readme.mjs)

## 6. lib/ 模块一览

仓库根 [`.github/lib/`](../.github/lib/) 十二个 ESM 模块为脚本层共享能力（层规约见
[CONTRIBUTING.md](../CONTRIBUTING.md)）：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| [`lib/semver.mjs`](../.github/lib/semver.mjs) | 严格 SemVer 2.0.0 解析/比较 + 宽松数字段比较（两套语义禁止混用） | `parse` / `compare` / `compareVersionsLoose` / `isStable` / `pickLatest` / `parseSemver` / `isValidSemver` / `compareSemver` / `pickNewestVersionDir` |
| [`lib/registry.mjs`](../.github/lib/registry.mjs) | DockerHub / GHCR 适配器、唯一镜像字符串解析入口、响应形状校验与重试退避 | `parseImage` / `DockerHubAdapter` / `GhcrAdapter` / `createAdapter` / `RegistryRequestError` / `assertTagArray` / `fetchWithRetry` / `computeRetryDelay` / `isRetryableStatus` |
| [`lib/apps.mjs`](../.github/lib/apps.mjs) | 应用目录扫描、版本目录解析、嵌套应用补全 | `SKIP_DIRS` / `listApps` / `getAppMeta` / `getCurrentVersion` / `loadAliases` / `buildShortToDir` |
| [`lib/schema.mjs`](../.github/lib/schema.mjs) | data.yml 结构定义与校验规则（纯 JS） | `validateFormField` / `validateKeyMatch` / `validateUrlField` / `normalizeFormField` / `FORMFIELD_TYPE_WHITELIST` |
| [`lib/consistency.mjs`](../.github/lib/consistency.mjs) | 跨文件一致性规则集（compose ↔ data.yml ↔ README ↔ 目录名），ruleId 单一事实来源 | `RULES` / `RULE_IDS` / `BUILTIN_VARS` / `checkVarDeclarations` / `checkFormOrphans` / `checkHighPrivilege` 等 check* |
| [`lib/lint-exemptions.mjs`](../.github/lib/lint-exemptions.mjs) | lint 豁免清单加载/匹配/死条目检测（数据在 `.github/lint-exemptions.yml`） | `loadExemptions` / `exemptionMatches` / `applyWaivers` / `findDeadExemptions` |
| [`lib/compose.mjs`](../.github/lib/compose.mjs) | compose image 模板解析（单/双 envKey 形态）与 formField 重组 | `resolveImageTemplate` / `rebuildImageDefault` |
| [`lib/github.mjs`](../.github/lib/github.mjs) | GitHub REST 客户端（内置 fetch 不经 shell）+ PR body / commit message 构造 + 必需检查门禁 | `createGitHubClient` / `buildPullRequestBody` / `buildCommitMessage` / `GitHubApiError` / `DEFAULT_REQUIRED_CHECKS` / `AUTO_UPDATE_BRANCH_PREFIX` |
| [`lib/report.mjs`](../.github/lib/report.mjs) | 检测结果聚合与渲染（stdout / Step Summary）唯一实现 | `aggregateResults` / `exitCodeForResults` / `renderSummary` / `renderMarkdown` / `renderExecutionMarkdown` / `renderExecutionSummary` / `escapeCell` |
| [`lib/validate-batch.mjs`](../.github/lib/validate-batch.mjs) | 自动更新批次的全量配置校验（纯函数） | `validateUpdateBatch` / `loadAliasByDir` / `validateDataYamlDocument` / `validateComposeDocument` / `validateImageTags` / `isRecognisableVersionTag` / `readReadmeVersionTable` / `validateReadmeVersion` |
| [`lib/version-writer.mjs`](../.github/lib/version-writer.mjs) | 新版本目录的原子生成（staging → 校验 → 提交）与历史版本不可变保护 | `stageVersionDir` / `commitStagingDir` / `resolveVersionTarget` / `cleanupStagingDir` / `cleanupStaleStaging` / `isIdenticalDir` |
| [`lib/execution-result.mjs`](../.github/lib/execution-result.mjs) | 端到端执行结果 schema（应用 → 阶段 → 状态）与五类聚合 | `EXEC_STATUS` / `EXEC_STAGE` / `createExecutionResult` / `withStage` / `toExecutionResults` / `aggregateExecutionResults` / `exitCodeForExecutionResults` |


## 相关文档

- [postmortems.md](postmortems.md) — 自动化事故完整复盘（明细与回归测试）
- [git-workflow.md](git-workflow.md) — 与自动更新分支/人工 PR 不互相覆盖的约束
- [troubleshooting.md](troubleshooting.md) — GitHub API / 环境故障
