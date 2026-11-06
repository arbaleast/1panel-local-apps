# AGENTS.md — 1Panel Local Apps

> 本文件是唯一入口（路由器），只放硬规则与路由；细节手册在 `docs/`，规约见 [CONTRIBUTING.md](CONTRIBUTING.md)。
> 读法：先看 §3 的任务路由索引，按你手上的任务跳转到对应单一文档，不要通读全仓文档。

## 1. 项目介绍

1Panel 本地应用仓库：自建 Docker 应用的 compose、元数据与图标，用于同步到 1Panel 应用商店并持续维护。
CI（[automation](docs/automation.md)）自动守护 hardcode 镜像的更新；文档质量由 `npm run docs:check` 守护。

## 2. 仓库结构速查

```
<app-key>/                 # 应用目录直接在仓库根
├── data.yml / logo.png / README.md    # 根元数据（key 必须与目录名一致）、图标、中文说明
└── <version>/             # 版本目录，目录名即 1Panel 版本参数（禁止 latest）
    ├── data.yml           # 版本配置 + formFields
    ├── docker-compose.yml
    ├── data/              # 持久化（.gitkeep）
    └── scripts/           # 可选 init.sh
.github/{bin,scripts,lib}/  # 可执行入口 / workflow 入口 / 共享纯函数层
docs/                       # 手册（本路由器的下游）
.github/bin/check-docs.mjs  # 文档质量校验
```

## 3. 任务路由索引

| 任务 | 主文档（单一事实来源） |
|---|---|
| 新增 / 更新应用、目录与 README 规范 | [docs/app-structure.md](docs/app-structure.md) |
| data.yml 字段、formField、校验报错 | [docs/data-yml-schema.md](docs/data-yml-schema.md) |
| docker-compose 规则、运行身份、init.sh | [docs/compose-conventions.md](docs/compose-conventions.md) |
| 自动更新 / GitHub Actions / registry 选型 | [docs/automation.md](docs/automation.md) |
| 部署兼容性校验 / 架构核验 / GPU / 冒烟测试 / CI 分级 | [docs/deploy-compat.md](docs/deploy-compat.md) |
| Git 分支 / commit / push / PR / 回滚 | [docs/git-workflow.md](docs/git-workflow.md) |
| 环境、SSH、node 可见性、故障速判 | [docs/troubleshooting.md](docs/troubleshooting.md) |
| 历史事故与教训（写代码前先查相关复盘） | [docs/postmortems.md](docs/postmortems.md) |
| 本地环境 / 测试命令 / lib 分层 / 文档规约 | [CONTRIBUTING.md](CONTRIBUTING.md) |

## 4. Agent 工作原则

- **先读后改**：改前读现有实现与文档；已读过的规则不留任何任务外遗留。
- **代码即权威**：运行时行为以代码为准；文档与代码冲突，先核实真实行为再决定修哪边（严禁为文档一致性改运行时行为）。
- **行为保持**：不重写、不顺手重构；发现无关缺陷单独报告。
- **实证验收**：只声称实际执行过的验证；环境不可用时如实标「未验证」。
- **工作区保护**：`git status` 出现非本任务改动 → 停止询问，严禁 stash / checkout / reset 处置它。
- **远程操作**：未经授权禁止 push / 开合 PR / 触碰 `main`。
- 大文件读被截断时用 offset 续读到 EOF，不得凭片段断言。

## 5. 应用与元数据硬规则（细则见手册）

- 版本目录名 = 版本参数；**禁止 `latest`**（除非上游完全无版本化 tag，且 PR 注明根因）。
- 更新应用**只复制版本子目录**，不复制整个 `<key>/*`；SQLite key 有 `local` 前缀（jellyfin → localjellyfin）。
- 根 `data.yml` 的 `additionalProperties.key` 必须与应用目录名一致；`type` ∈ `tool|media|library`（默认 `tool`）。
- 描述与 formField `label` 走 i18n：`en, zh, zh-Hant, ja, ko, ru, ms, pt-br`。
- 图标禁占位符；优先级 显式 URL → Dashboard Icons → Simple Icons → selfh.st。

## 6. Compose 红线（细则见 [docs/compose-conventions.md](docs/compose-conventions.md)）

- 主服务 `container_name: ${CONTAINER_NAME}`；所有服务 `restart: always`、
  `networks: [1panel-network]`（须声明 external）、`labels: {createdBy: "Apps"}`。
- 公开端口用 `PANEL_APP_PORT_*`；持久化优先 `./data/...` 相对路径。
- 镜像一律 hardcode `image: tag`，由自动更新守护；**仅 3 个变量型例外**：
  `silo`、`infinity/cu124`、`xunlei`（不入自动更新范围，见 automation §2）。
- 上述例外清单由 `npm run lint` 校验：例外之外出现变量型镜像即报 error；
  清单单一事实来源在 `.github/lib/image-policy.mjs`（与本节内容由测试锁定一致）。
- compose 中每个 `${VAR}` 必须在版本 `data.yml` formFields 声明；豁免变量仅 6 个：
  `${CONTAINER_NAME}` `${HOST_IP}` `${HOST_ADDRESS}` `${PANEL_DB_PORT}` `${CPUS}` `${MEMORY_LIMIT}`。
- 端口变更影响 1Panel 反代配置，PR 必须说明；更新时 `sed -i` 在 bind mount 上会失败。

## 7. Git 安全红线（细则见 [docs/git-workflow.md](docs/git-workflow.md)）

- 动手前置 4 件套：`git status --short --branch` / `git branch --show-current` / `git remote -v` / `git log -5 --oneline`。
- 工作区不干净 → 停；未经授权不 push、不开合 PR、不碰 `main`（既有未推送提交同属保留区，未经授权禁改写）。
- 分支前缀 `feat/|fix/|docs/|refactor/|chore/|auto-update/`；Conventional Commits。
- 禁止跨分支 force-push、`reset --hard`、随意动 remote / 其它分支；回滚只用 `git revert`。
- 仓库与配置禁止出现任何 secret 或 token 类明文。
- 本地提交前自查三条：`npm run docs:check`、`git diff --check`、`git status --short`（无意外应用配置改动）。

## 8. 真实命令与验证

唯一命令来源是 [package.json](package.json) `scripts`（分层规约见 [CONTRIBUTING.md §4](CONTRIBUTING.md#4-lib-与-bin-分层与依赖规约)）：

```bash
npm test              # node --test ".github/lib/*.test.mjs"（约 500 case）
npm run lint          # node .github/bin/lint-apps.mjs（含 warning 时 PASSED (with warnings)，exit 0）
npm run lint:deploy   # 同上 + manifest 模式：额外核验镜像架构（需外网，只读 registry 元数据）
npm run smoke -- --app <应用名>  # 隔离沙箱冒烟测试（需 docker；详见 deploy-compat §7）
npm run validate:batch  # node .github/bin/validate-update-batch.mjs
npm run docs:check    # node .github/bin/check-docs.mjs
```

- 检测链路只允许 dry-run（见 [automation §2](docs/automation.md#2-检测链路detect)）；**不要**跑不存在的命令，
  也不要在 CI 外跑会写仓库的检测/批次。
- 环境（`node >= 24`）与沙箱故障见 [docs/troubleshooting.md](docs/troubleshooting.md)。
