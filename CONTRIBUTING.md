# CONTRIBUTING — 贡献指南

> 职责（唯一）：贡献流程、本地开发环境、真实可用的测试命令、`lib/` 与 `bin/` 分层与依赖规约。
> 写代码红线见仓库根 [AGENTS.md](AGENTS.md)；Git 流程见 [docs/git-workflow.md](docs/git-workflow.md)；
> 应用手册见 [docs/app-structure.md](docs/app-structure.md)。

## 1. 快速开始

```bash
git clone git@github.com:arbaleast/1panel-local-apps.git
cd 1panel-local-apps
npm install          # devDependencies 仅 js-yaml + zod
npm test             # 全部单元/回归测试（见 §3）
npm run lint         # 全仓 data.yml 静态校验
```

本地需 `node >= 24`（`package.json` `engines` 已声明；仓库根 `.nvmrc` 与 CI 同版本，`fnm use` /
`nvm use` 对齐）。沙箱环境 `node` 不可见时的应对见 [docs/troubleshooting.md §1](docs/troubleshooting.md#1-沙箱中-node-不可见的应对)。

## 2. 贡献流程

1. 读 [AGENTS.md](AGENTS.md) 的硬规则与任务路由索引，按要改的内容进对应手册：
   [新增/更新应用](docs/app-structure.md)、[data.yml](docs/data-yml-schema.md)、
   [compose](docs/compose-conventions.md)、[自动化](docs/automation.md)。
2. 从最新 `main` 切前缀分支（`feat/ fix/ docs/ refactor/ chore/ auto-update/`），
   按统一 Git 流程走（[docs/git-workflow.md §1](docs/git-workflow.md#1-标准变更流程自动更新与人工共用)）。
3. Commit message 用 Conventional Commits；一个阶段一个 commit。
4. PR 描述里说明：改了什么、为什么、跑了哪些验证（如实，只列真正执行过的命令）。
5. 端口变更会影响 1Panel 反向代理配置，须在 PR 说明；做完自查
   `git diff --check` 与 `git status --short`，确认没有意外改到别处。

## 3. 测试与校验命令（与 package.json scripts 一一对应，勿杜撰其它命令）

| 命令 | 等价物 | 用途 |
|---|---|---|
| `npm test` | `node --test ".github/lib/*.test.mjs"` | 全部 `.github/lib/*.test.mjs` 回归（schema / registry / semver / compose / github / report / validate-batch / workflow / pr-flow / docs / image-policy） |
| `npm run lint` | `node .github/bin/lint-apps.mjs` | 扫描全仓 data.yml + compose 静态校验 + 镜像 hardcode 策略（变量型镜像只允许在 AGENTS.md §6 的例外清单内）；有 error 退出 1；只有 warning 显示 `PASSED (with warnings)` 且退出 0 |
| `npm run validate:batch` | `node .github/bin/validate-update-batch.mjs` | 全仓批次校验模式 |
| `npm run docs:check` | `node .github/bin/check-docs.mjs` | 全仓文档校验：根 README/AGENTS/CONTRIBUTING + `docs/*.md` + **各应用根 README** 的交叉引用 / 锚点 / 代码栅栏；文档里 `data.yml` 示例的真实 schema 一致性；仓库级文档里的 `npm run` 幽灵脚本；AGENTS 路由有效性 |

注意：

- **不要运行不存在的命令**（历史上 `scripts/check-updates.sh` 是已过时的薄包装，勿再扩展）。
- 自动更新检测的本地执行方式以 [docs/automation.md §2](docs/automation.md#2-检测链路detect)（dry-run）为准；
  不要在 CI 外跑会写仓库的检测/变体。
- 有 warning 不是失败；但新警告要么修掉要么在 PR 里说明原因。

## 4. `lib/` 与 `bin/` 分层与依赖规约

- [`lib/`](.github/lib/)：纯函数与纯逻辑，**只允许 `js-yaml` 一个第三方依赖**（zod 禁止）；
  绝不做进程 / 网络 / 写盘副作用（网络封装只在 registry / github 适配对象内）。
- [`bin/`](.github/bin/)：可执行入口脚本，可引入 `zod` 等更重的依赖；负责 CLI 组装、
  退出码与进程调用。
- [`.github/scripts/`](.github/scripts/)：Workflow 入口脚本，**优先复用 `lib/`**，
  不在入口 inline 重复实现同一逻辑。

新增模块规约：

- 任何新增 `lib/*.mjs` 必须配套 `lib/*.test.mjs`（`node:test`；参照现有 `lib/*.test.mjs` 风格）。
- 任何新增 `bin/` 脚本须在 `package.json` 的 `scripts` 里注册一条命令。
- 新增逻辑若对应已知形态/坑（变体 tag、融合 schema…），先补一条最小回归 case 再写实现。

## 5. 文档写作规约（见 docs/ 目录）

- 每个文档只负责一个主题，文件头写「> 职责（唯一）：…」，越界内容用**相对路径链接**指过去，
  **禁止把同一规则复制到多个文件**（单一事实来源）。
- 有效内容不足约 40 行的文档不单独成文件，并入相邻主题文档。
- Markdown 代码栅栏必须闭合，内部链接用相对路径；提交前跑 `npm run docs:check`。
- **应用根 README（`<app>/README.md`）也在 `docs:check` 扫描范围内**：跨应用链接必须写对相对层级
  （应用 README 在仓库根下一层，引用别的应用写 `../<app>/`），指向本仓不存在的上游文件时用行内代码而非链接。
- **文档里的 `data.yml` 示例也会被真实 schema 校验**（与 lint 同一套白名单与必填规则）：
  写示例时 `type` / `rule` / 必填字段必须与 [docs/data-yml-schema.md](docs/data-yml-schema.md) 一致；
  示意性占位（`<app-key>`、`- ...`、`https://...`）不会被误判。

## 6. 工作区卫生（临时脚本与 Trace-less 执行）

- 诊断 / 分拆探测用的临时脚本一律放 `.agent_cache/`（`.gitignore` 已忽略该目录），
  用完删除，不把诊断脚本提交进仓库。
- 结束前自查：`git status --short` 应只含本次任务实际要提交的文件；应用配置目录（`<app>/<version>/`）
  出现在无关 diff 里即为污染，先回滚再提交。
- 严禁把 secrets / token 写进仓库文件或 git config 的明文 helper。

## 7. 相关文档

- [docs/git-workflow.md](docs/git-workflow.md) — 分支 / commit / push / PR / 回滚
- [docs/automation.md](docs/automation.md) — 自动更新链路与门禁
- [docs/postmortems.md](docs/postmortems.md) — 历史事故与教训（新改动先查相关复盘）
