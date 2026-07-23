# AGENTS.md — 1Panel Local Apps

## Project

1Panel 本地应用仓库，包含自建 Docker 应用的 compose 文件、元数据和图标。
用于同步到 1Panel 应用商店并持续维护。

## Structure

```
apps/<app-key>/
├── data.yml              # 根元数据 (key, name, type, description, website, github)
├── logo.png              # 应用图标
├── README.md             # 中文说明
└── <version>/            # 版本目录 (名称=版本参数)
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
- 镜像引用: 使用 `${IMAGE}` 变量，不要硬编码

### 变量声明

- compose 中每个 `${...}` 变量必须在版本 `data.yml` 的 formFields 中声明
- 1Panel 自动提供的变量可豁免: `${CONTAINER_NAME}`, `${HOST_IP}`, `${HOST_ADDRESS}`, `${PANEL_DB_PORT}`
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
# 同步应用到 1Panel
./scripts/sync-to-1panel.sh [app-name...]

# 检查镜像更新
./scripts/check-updates.sh [app-name...]
```

## Deployment

1. 修改 compose 或 data.yml
2. `git commit` 并 `git push`
3. 在服务器运行 `./scripts/sync-to-1panel.sh <app>`
4. 在 1Panel UI 重新部署应用

## Common Pitfalls

- 版本目录名就是版本参数，改目录名即改版本选项
- `1pctl restart` 不会重新扫描本地应用，需要 `POST /api/v1/apps/sync`
- SQLite key 有 `local` 前缀: `jellyfin` → `localjellyfin`
- 更新时只复制版本子目录，不要复制整个 `apps/<key>/*`
- sed -i 在 bind-mount 上会失败，用 tempfile + mv
- 端口变更会影响反向代理配置
