# Git 工作流（人工与自动统一流程）

> 职责（唯一）：提交、分支、push、PR、合并、回滚的统一顺序与红线；本地开发环境安全配置。
> 自动更新链路的行为细节见 [automation.md](automation.md)；沙箱/环境故障见 [troubleshooting.md](troubleshooting.md)。

## 1. 标准变更流程（自动更新与人工共用）

```text
1. git status --short --branch        # 状态检查（前置命令齐套见 §5）
2. 工作区不干净 → 停止询问（用户未提交改动严禁 stash/checkout/reset 处理）
3. git switch -c <prefix>/<topic>      # 从最新 main 切分支
4. 修改 → 测试（npm test / npm run lint / 相关 dry-run）
5. git diff --check && git diff        # 自检空白错误后再逐行过 diff
6. git add（精确路径）→ git commit
7. 等人工授权 → git push origin <branch>
8. 等 CI（validate + 必需检查）绿 → 人工合并（或经授权的自动合并，见 automation.md §4）
9. 合并后 git switch main && git pull && git branch -d <branch>
```

铁律：

- **未经用户明确授权，不 push、不开 PR、不动 main**（本地验证闭环即可交付）。
- **只在授权范围内 commit**；用户未提交的工作区改动一律不碰（不 stash / checkout / reset）。
- 分支命名前缀：`feat/` `fix/` `docs/` `refactor/` `chore/` `auto-update/`。
- Commit message 用 Conventional Commits（`type(scope): subject`；行为不兼容用 `!` 与 `BREAKING CHANGE`）。
- **回滚只用 revert**：`git revert`，不用 `reset --hard` / force-push 覆盖公共分支历史。
- **任何分支、任何情形禁止 force-push**（含 `--force` / `--force-with-lease` 覆盖人工分支；
  自动更新分支的强制覆盖由 [open-update-pr.mjs](../.github/bin/open-update-pr.mjs) 按远端 SHA 校验后执行）。
- 仓库与 git 配置不得出现 secrets；不要把凭据写进 remote URL / config。

## 2. 前置命令齐套（any git operation 之前）

```bash
git status --short --branch
git branch --show-current
git remote -v
git log -5 --oneline
```

先确认自己在哪、没在别人的分支上、远端是预期的 remote，再动手。

## 3. 自动更新 PR 与人工工作的隔离

- 自动更新只写 `auto-update/<date>` 分支；人工分支永远不与该前缀冲突。
- 自动更新合并前轮询目标 PR 自身的 `head.sha` 必需检查（见 automation.md §4），
  **不会**因其它并行 CI 噪音而提前合并。
- 人工在 `auto-update/*` 分支上的手工 commit 会被下一次同日期批次 force-with-lease 校验拦下
  （远端 SHA 不匹配即中止）——不要在有未处理人工改动的同一个 `auto-update/<date>` 分支上并行工作。

## 4. 回滚

- 已合并进 main：`git revert -m 1 <merge-sha>`（merge commit）或 `git revert <sha>`；再走 §1 流程。
- 需要整批撤回时优先 revert 批次 merge commit，**不要** `reset --hard` + force-push main。

## 5. CI 与必需检查

- `validate` job（只读）在所有事件上运行：`npm test` + `npm run lint`（+ 文档检查 `npm run docs:check`）。
- 合并门禁：必需检查全 success 才可合并；PR 事件只跑只读 job（automation.md §1）。
- `on.push.paths` 白名单防自动更新合并后的 push 递归；**不要**给 commit message /
  PR title 加 `[skip ci]`（会锁死合并门禁，见 automation.md §4）。

## 6. 关联文档

- [CONTRIBUTING.md](../CONTRIBUTING.md) — 本地环境与脚本命令
- [automation.md](automation.md) — 自动更新分支 / 合并门禁细节
- [troubleshooting.md](troubleshooting.md) — SSH / 网络环境问题
