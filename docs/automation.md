# 自动更新与 GitHub Actions 自动化

> 职责（唯一）：自动更新工作流的执行链路、触发与权限隔离、镜像版本选型、批次校验与 PR 合并门禁。
> 关键不变量同时由 [lib/workflow.test.mjs](../.github/lib/workflow.test.mjs) 与
> [lib/pr-flow.test.mjs](../.github/lib/pr-flow.test.mjs) 回归锁定（改错会在 `npm test` 失败）。

## 1. 事件与权限隔离（安全不变量）

[`.github/workflows/auto-update.yml`](../.github/workflows/auto-update.yml) 分成两个**权限与事件完全隔离**的 job：

| Job | 触发事件 | 权限 | 职责 |
|---|---|---|---|
| `validate` | 所有事件（含 `pull_request`） | `contents: read` | 只读：`npm test` + `npm run lint` + `npm run docs:check`。不碰 Token、不写仓库 |
| `auto-update` | 仅 `schedule` / `workflow_dispatch` / 受控 `push`（后两者限 `main`） | `contents: write` + `pull-requests: write` | 检测 → 改 README → 校验 → 开 PR → 等检查 → 合并 |

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

## 2. 检测链路（detect）

入口：[`.github/scripts/detect-updates.mjs`](../.github/scripts/detect-updates.mjs)；
可在本地 dry-run：`npm run detect:dry-run`（不写盘）。旧壳 `scripts/check-updates.sh` 已废弃，
只是转发参数，勿再扩展。

三态结果：每个应用产出 `success` / `skipped` / `failed`（写入 `updates.json` 的 `results` + `summary`）。
**Registry 网络错误绝不算「无更新」**；存在 failed 时脚本退出码 2，workflow 末尾「检测失败门禁」
步骤显式 `exit 1` 让整个 workflow 变红。

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

- 防重：先按 PR title 前缀 `chore(deps): auto-update` 查 open PR，再用
  `GET /pulls?head=<owner>:<branch>` 二次确认；**查询失败 = 中止**（不做任何写操作，分支不创建），
  绝不在「无法确认是否重复」的情况下继续创建。
- 推送：分支名 `auto-update/<date>`（单 PR 合并本批次全部变更）；分支由 `checkout -B` 重建后
  以 `--force-with-lease` 推送（替代裸 `--force`）：远端有本地不知道的新提交时会拒绝覆盖，
  防止静默吞掉第三方批次提交（2026-11 audit P2-a）。
  进一步硬化点（未实现，如需再做）：先 `ls-remote` 取远端 SHA，改用
  `--force-with-lease=<branch>:<SHA>` 显式租约，拿不到就中止。
- 合并门禁：轮询 GitHub Checks + combined status，**键控到目标 PR 响应的 `head.sha`**
  （不是触发 workflow 自身的 SHA）；`waitForChecks` 只在各必要检查 success 后合并；
  failure / timeout / unknown 一律**保留 PR 与远程分支**、非零退出。
- **合并带 sha 护栏**：合并请求体带 `sha: <等待检查的 head SHA>`。若等待期间分支被再次推送，
  GitHub 返回 409（Head branch was modified）→ 不合并，避免把「未经验证的新提交」并入 main
  （回归见 lib/github.test.mjs「merge 带 expectedHeadSha …」与 pr-flow.test.mjs 同名断言）。
- GitHub 对 `pull_request` 事件按 **PR 的 HEAD commit message 与 PR title/body** 判定 skip 指令：
  自动更新的 commit message 与 PR title **不得含 `[skip ci]` 等 skip 指令**，否则 `pull_request`
  检查永远停留 Pending → 合并门禁必然超时（回归见 lib/github.test.mjs 的 `buildCommitMessage` /
  `buildPullRequestTitle`）。合并后的「push 递归触发」由工作流 `on.push.paths` 白名单防住
  （只匹配 `.github/**` 等自动更新链路自身文件）。
- Token：`secrets.PAT_TOKEN`（缺失时 `|| github.token` 托底并打 `[WARN]` 日志提醒——
  `GITHUB_TOKEN` 创建的 PR 不会触发 `pull_request` 工作流 → 必需检查不出现 → 合并门禁超时，
  **本仓必须配置 `secrets.PAT_TOKEN`**）。Token 缺失时脚本直接非零退出，不静默降级。
- 失败处理铁律：API 响应必须做形状校验（"JSON 能 parse" ≠ "业务成功"）；失败时**绝不执行清理动作**
  （删分支 / 删文件）；remote 分支只在 PR 合并成功后删除。全部调用用 Node 内置 `fetch` /
  `execFileSync` 参数数组，**绝不把不可信内容（PR body / commit message）拼进 shell 命令字符串**
  （2026-10-20 事故复盘，见 postmortems.md）。

## 5. README 同步

自动更新命中后同步仓库根 `README.md` 应用列表表格（应用名/描述/版本）：

- 应用名映射与描述覆盖：[`.github/app-aliases.yml`](../.github/app-aliases.yml)
- 同步脚本：[`.github/scripts/sync-readme.mjs`](../.github/scripts/sync-readme.mjs)

## 6. lib/ 模块一览

仓库根 [`.github/lib/`](../.github/lib/) 八个 ESM 模块为脚本层共享能力（层规约见
[CONTRIBUTING.md](../CONTRIBUTING.md)）：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| [`lib/semver.mjs`](../.github/lib/semver.mjs) | 严格 SemVer 2.0.0 解析/比较 + 宽松数字段比较（两套语义禁止混用） | `parse` / `compare` / `compareVersionsLoose` / `isStable` / `pickLatest` / `parseSemver` / `isValidSemver` / `compareSemver` / `pickNewestVersionDir` |
| [`lib/registry.mjs`](../.github/lib/registry.mjs) | DockerHub / GHCR 适配器、唯一镜像字符串解析入口 | `parseImage` / `DockerHubAdapter` / `GhcrAdapter` / `createAdapter` / `RegistryRequestError` |
| [`lib/apps.mjs`](../.github/lib/apps.mjs) | 应用目录扫描、版本目录解析、嵌套应用补全 | `SKIP_DIRS` / `listApps` / `getAppMeta` / `getCurrentVersion` |
| [`lib/schema.mjs`](../.github/lib/schema.mjs) | data.yml 结构定义与校验规则（纯 JS） | `validateFormField` / `validateKeyMatch` / `validateUrlField` / `normalizeFormField` / `FORMFIELD_TYPE_WHITELIST` |
| [`lib/compose.mjs`](../.github/lib/compose.mjs) | compose image 模板解析（单/双 envKey 形态）与 formField 重组 | `resolveImageTemplate` / `rebuildImageDefault` |
| [`lib/github.mjs`](../.github/lib/github.mjs) | GitHub REST 客户端（内置 fetch 不经 shell）+ PR body / commit message 构造 + 检查状态门禁 | `createGitHubClient` / `buildPullRequestBody` / `buildCommitMessage` / `GitHubApiError` |
| [`lib/report.mjs`](../.github/lib/report.mjs) | 检测结果聚合与渲染（stdout / Step Summary）唯一实现 | `aggregateResults` / `exitCodeForResults` / `renderSummary` / `renderMarkdown` / `escapeCell` |
| [`lib/validate-batch.mjs`](../.github/lib/validate-batch.mjs) | 自动更新批次的全量配置校验（纯函数） | `validateUpdateBatch` / `loadAliasByDir` / `validateDataYamlDocument` / `validateComposeDocument` / `validateImageTags` / `isRecognisableVersionTag` / `readReadmeVersionTable` / `validateReadmeVersion` |

## 相关文档

- [postmortems.md](postmortems.md) — 自动化事故完整复盘（明细与回归测试）
- [git-workflow.md](git-workflow.md) — 与自动更新分支/人工 PR 不互相覆盖的约束
- [troubleshooting.md](troubleshooting.md) — GitHub API / 环境故障
