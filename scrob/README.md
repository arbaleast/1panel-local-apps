# Scrob

Scrob 是一款**自托管媒体追踪应用**，可与 Jellyfin / Plex / Emby 媒体服务器同步，自动记录观影历史、评分与个人片单（watchlist / favorites / lists），帮助你在多端跨设备统一管理自己的观影数据。

- **GitHub**: <https://github.com/ellite/scrob>
- **官网**: <https://scrob.app>
- **License**: GPL-3.0
- **上游镜像**: `bellamy/scrob`（DockerHub）

## 功能要点

- 与 Jellyfin / Plex / Emby 的库与播放历史同步
- 追踪观看历史、评分、个人片单
- 多用户注册与登录（默认关闭，可选开启）
- Web UI，容器内监听 `7330` 端口

## 目录结构

本仓库按 1Panel 应用规范组织：

```
scrob/
├── data.yml               # 根元数据
├── logo.png               # 应用图标
├── README.md              # 本说明
├── v2.5.0/                # amd64 镜像
│   ├── data.yml
│   ├── docker-compose.yml
│   └── data/              # 持久化占位（.gitkeep）
└── v2.5.0-arm64v8/        # arm64 镜像（树莓派 / Apple Silicon / 鲲鹏等）
    ├── data.yml
    ├── docker-compose.yml
    └── data/
```

> 仅提供 `amd64` 与 `arm64` 两种架构；本项目无 `arm/v7` 镜像，32 位 ARM 主机请勿安装。

## 端口说明

- 容器内服务端口固定为 `7330`
- 主机侧端口由 1Panel 在安装时自动分配，引用变量 `${PANEL_APP_PORT_HTTP}`

## 数据持久化

| 容器内路径 | 主机侧路径 | 用途 |
| --- | --- | --- |
| `/var/lib/postgresql/data` | `./data/scrob_db` | PostgreSQL 16 数据（scrob-db 容器） |
| `/app/backend/data` | `./data/scrob_app` | Scrob 应用数据（缓存、配置、上传） |

> 请勿把 `./data` 目录加入版本库外的备份（应用本身已完成 SQL 迁移）；如需重置数据，停止容器后删除 `scrob/data/` 即可。

## 必填环境变量

| 变量 | 说明 |
| --- | --- |
| `POSTGRES_PASSWORD` | PostgreSQL 密码，**必填**，建议使用密码管理器生成 |
| `SECRET_KEY` | 应用密钥（用于会话签名），**必填**，建议 `openssl rand -hex 32` 生成 |

可选：`POSTGRES_USER`（默认 `scrob`）、`POSTGRES_DB`（默认 `scrob`）、`TZ`（默认 `UTC`，推荐 `Asia/Shanghai`）、`ENABLE_REGISTRATIONS`（默认 `false`）、`REGISTRATION_MAX_ALLOWED_USERS`（默认 `0`，即不限制）。

## 升级方式

由于本应用为 hardcode 模式（不通过 `${IMAGE}` 变量），升级流程如下：

1. 1Panel 后台 → 应用商店 → 已安装 → 找到本应用
2. 点击「升级」按钮，1Panel 将按当前版本目录中的 compose 重新拉取 `bellamy/scrob:v2.5.0` 镜像
3. 等待容器重建完成

新版本发布后，仓库会同步新增版本目录（如 `v2.5.1/`），届时可在 1Panel 应用商店切换到新版本。

## 部署

参考 [`AGENTS.md`](../AGENTS.md) 的 *Deployment* 章节：本地修改 compose 或 data.yml → `git commit` & `git push` → 1Panel 计划任务拉取最新仓库 → 1Panel UI 重新部署应用。

## 备注

- arm64 镜像优先使用 `bellamy/scrob:v2.5.0-arm64v8`；若该 tag 暂未发布，仓库会改用 `bellamy/scrob:latest-arm64` 或 `ghcr.io/ellite/scrob:v2.5.0-arm64`，请以 `docker-compose.yml` 内实际 `image` 字段为准。
- PostgreSQL 使用 `postgres:16-alpine` 多架构清单，amd64 / arm64 均原生支持。
