# AGENTS.md — 1Panel Local Apps

## Project

1Panel 本地应用仓库，包含自建 Docker 应用的 compose 文件、元数据和图标。
用于同步到 1Panel 应用商店并持续维护。

## Structure

```
<app-key>/               # 应用目录直接在仓库根
├── data.yml              # 根元数据 (key, name, type, description, website, github)
├── logo.png              # 应用图标
├── README.md             # 中文说明
└── <version>/            # 版本目录 (名称=版本参数，禁止使用 "latest")
    ├── data.yml          # 版本配置 + formFields (环境变量定义)
    ├── docker-compose.yml
    ├── data/             # 持久化数据目录 (.gitkeep)
    └── scripts/          # 可选: init.sh 等初始化脚本
```

## Rules

### Compose 文件

- 主服务: `container_name: ${CONTAINER_NAME}`
- 所有服务: `restart: always`, `networks: [1panel-network]`, `labels: {createdBy: "Apps"}`
- `1panel-network` 必须声明为 external
- 公开端口: 使用 `PANEL_APP_PORT_*` 变量
- 持久化挂载: 优先使用 `./data/...` 相对路径
- 镜像引用: 变量型应用使用 `${IMAGE}` / `${APP_VERSION}`；hardcode 类应用直接写 `image:tag`，由自动更新守护

### 变量声明

- compose 中每个 `${...}` 变量必须在版本 `data.yml` 的 formFields 中声明
- 1Panel 自动提供的变量可豁免: `${CONTAINER_NAME}`, `${HOST_IP}`, `${HOST_ADDRESS}`, `${PANEL_DB_PORT}`, `${CPUS}`, `${MEMORY_LIMIT}`
- 端口变量命名: `PANEL_APP_PORT_HTTP`, `PANEL_APP_PORT_HTTPS`, `PANEL_APP_PORT_API` 等

### 元数据

- `additionalProperties.key` 必须匹配应用目录名
- `type` 字段: 默认 `tool`
- `description` 和 form field `labels` 应包含 i18n: `en, zh, zh-Hant, ja, ko, ru, ms, pt-br`

### 图标

- 不允许占位符图标
- 优先级: 显式 URL → Dashboard Icons → Simple Icons → selfh.st Icons

## Scripts

```bash
# 检查镜像更新
./scripts/check-updates.sh [app-name...]
```

## lib/ 模块

仓库根 [`lib/`](lib/) 下三个 ESM 模块为脚本层提供共享能力：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| [`lib/semver.mjs`](lib/semver.mjs:1) | 段值比较、纯 semver 选末位、黑名单过滤 | `parse` / `compare` / `isStable` / `pickLatest` |
| [`lib/registry.mjs`](lib/registry.mjs:1) | DockerHub / GHCR 适配器、镜像字符串解析 | `parseImage` / `DockerHubAdapter` / `GhcrAdapter` / `createAdapter` |
| [`lib/apps.mjs`](lib/apps.mjs:1) | 应用目录扫描、版本目录解析、嵌套应用补全 | `SKIP_DIRS` / `listApps` / `getAppMeta` / `getCurrentVersion` |

### 本地跑测试

```bash
npm test          # 等价 node --test lib/，27 case
```

需要 `node >= 18`（`engines` 字段已声明）。

### 新增模块规约

- 任何新增 `lib/*.mjs` **必须**配套 `*.test.mjs`（用 `node:test`）
- `lib/` 下**禁止**引入 `js-yaml` 之外的第三方依赖；新增依赖须先讨论
- 三个入口脚本（[`detect-updates.mjs`](.github/scripts/detect-updates.mjs:1) / [`sync-readme.mjs`](.github/scripts/sync-readme.mjs:1) / [`check-updates.sh`](scripts/check-updates.sh:1)）应**优先**复用 `lib/` 模块，不在入口内 inline 重复实现

### DockerHub 镜像选取口径

`DockerHubAdapter` 用 `page_size=20&ordering=last_updated` 取最近更新的 20 个 tag，再过滤不稳定关键字（`latest|nightly|dev|edge`）后选末位。GHCR 用 OCI Registry API + 匿名 token（`n=1000`），黑名单包含 `alpha|beta|rc|main|master`。

## Automation

- `.github/workflows/auto-update.yml` — 每周一 UTC 0 点（也可手动）检测 hardcode 类应用镜像更新
- 命中即开 PR（分支 `auto-update/<date>`，单 PR 合并本批次全部变更），PR body 列出所有 service 变更
- 修改 `<app>/<version>/docker-compose.yml` 与 `<app>/data.yml`
- 变量型应用（compose 用 `${IMAGE}` / `${APP_VERSION}`）不在自动范围
- PR title 含 `[skip ci]`，防合并时递归触发
- 同步更新仓库根 `README.md` 的"应用列表"表格（应用名/描述/版本）
  - 应用名映射与描述覆盖：[`.github/app-aliases.yml`](.github/app-aliases.yml)
  - 同步脚本：[`.github/scripts/sync-readme.mjs`](.github/scripts/sync-readme.mjs)

## Deployment

1. 修改 compose 或 data.yml
2. `git commit` 并 `git push`
3. 由 1Panel 计划任务拉取最新仓库并触发本地应用同步
4. 在 1Panel UI 重新部署应用

## Common Pitfalls

- **禁止使用 `latest` 作为版本目录名或镜像 tag**：`latest` 会导致版本漂移，1Panel UI 中该目录名即为版本参数。应使用具体 semver / date-based / functional tag（如 `v1.2.3`、`2024.08`、`pg` 等）。仅当上游镜像完全无版本化 tag 时方可例外保留 `latest`（需在 PR 描述中注明根因）。
- 版本目录名就是版本参数，改目录名即改版本选项
- SQLite key 有 `local` 前缀: `jellyfin` → `localjellyfin`
- 更新时只复制版本子目录，不要复制整个 `<key>/*`
- sed -i 在 bind-mount 上会失败，用 tempfile + mv
- 端口变更会影响反向代理配置
- **formField type 不支持 boolean**: 1Panel 前端 [`params/index.vue`](https://github.com/1Panel-dev/1Panel/blob/main/frontend/src/views/app-store/apps/params/index.vue) 使用 `v-if` 按 type 渲染表单控件，**仅支持 6 种 type**：`text` / `number` / `password` / `service` / `select` / `apps`。如果在 formFields 中使用 `type: boolean`，UI 中该字段会完全不显示且无任何报错。**解决方式**：布尔开关一律用 `type: select` + `values: [{label: 'true', value: 'true'}, {label: 'false', value: 'false'}]` 来模拟。参考应用：`anirss`、`firecrawl`、`mihomo`、`moviepilot`、`handbrake`、`traefik` 等均有同模式字段。**检测技巧**：新增 formField 后如果 UI 未出现，先核对 `type` 是否在上述白名单内。
- **GHCR 镜像更新检测应使用 OCI Registry API**：GitHub Packages API（`https://api.github.com/orgs/<org>/packages/container/<repo>/versions`）对匿名访问返回 401，即使提供 `GITHUB_TOKEN` 也无法跨组织读取 packages，导致 hardcode 类 GHCR 镜像永远检测不到更新。**正确方式**：先用 `https://ghcr.io/token?scope=repository:<repo>:pull` 获取匿名 pull token（无需认证），再用 `https://ghcr.io/v2/<repo>/tags/list?n=1000` 列出 tags（`n=1000` 覆盖绝大多数场景）。参考：`detect-updates.mjs` 的 `getLatestTagFromGHCR` 与 `check-updates.sh` 的 GHCR 分支。
- **compose 环境变量名需与上游实际读取名一致**：上游容器进程读取的环境变量名未必与 compose 中声明的相同（如上游 `start-all.sh` 读取 `HINDSIGHT_CP_HOSTNAME` 而非 `HINDSIGHT_CP_HOST`）。在新增版本目录或补全 formField 时，应通过阅读上游 Dockerfile / 启动脚本 / `.env.example` 交叉验证变量名，不确定时查上游仓库对应 tag 的 `docker/standalone/start-all.sh`。
