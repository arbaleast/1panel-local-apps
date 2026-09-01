# Marginalia

> 本地优先的私人知识库 + LLM 研究代理（AGPL-3.0）。
> 上游仓库：<https://github.com/shenmintao/marginalia>

## 简介

Marginalia 是一个本地优先的个人知识管理系统，集成了 LLM 研究代理能力。基于 FastAPI + PostgreSQL + MinIO 构建，支持 PDF、笔记、表格、日志、压缩包等多种异构资料摄入，可对本地资料库进行语义检索并产出**带引用的回答**。

## 许可证

**AGPL-3.0-or-later**。商业分发受上游许可证约束，1Panel 应用商店分发时需注意保留版权与源代码可获得性。

## ⚠️ 必填配置

部署时**必须**填写以下字段，否则容器会因为 `${LLM_DEFAULT_API_KEY:?}` 强校验而启动失败：

- **LLM API Key**（必填）：支持 OpenAI、OpenAI 兼容网关、Anthropic 三种 Provider。
  - OpenAI：填写 `https://api.openai.com/v1` 的 Key
  - 自建 / 网关：在 `LLM Base URL` 填网关地址（如 `https://your-gateway/v1`）
  - Anthropic：`LLM Provider` 选 `anthropic`，`LLM Model` 填 `claude-3-5-sonnet-...`
- **PostgreSQL / MinIO 凭据**：默认用户名密码均为 `marginalia`，建议首次部署后通过 1Panel 终端修改。

## 快速开始

1. 在 1Panel 应用商店搜索 **Marginalia** 并安装。
2. 部署参数页填写：
   - `LLM API Key`（必填）
   - `LLM Provider`（openai / openai-compatible / anthropic）
   - `LLM Model`（默认 `gpt-4o-mini`，可改为 `gpt-4o` / `claude-3-5-sonnet-...` 等）
   - 若使用自建/第三方网关：填 `LLM Base URL`
3. 等待 1-2 分钟（包含 PostgreSQL 初始化、MinIO 桶创建、Alembic 迁移）。
4. 访问 `http://<宿主机IP>:<端口>` 进入 API（默认 8000）。

## 服务端口

| 端口 | 用途 | 暴露策略 |
|------|------|----------|
| 8000 | Marginalia API | 对外（`PANEL_APP_PORT_HTTP`） |
| 9001 | MinIO 控制台 | 仅 127.0.0.1（本地调试） |
| 5432 | PostgreSQL | 内部网络 |
| 9000 | MinIO S3 API | 内部网络 |

如需在 LAN 上访问 API，请同时设置 `MARGINALIA_API_TOKEN`（API Bearer Token），并在 HTTP 客户端请求头中携带 `Authorization: Bearer <token>`。

## 持久化目录

| 容器路径 | 主机路径 | 用途 |
|----------|----------|------|
| `/data/library` | `./data/library` | 资料库元数据与目录树 |
| `/data/objects` | `./data/objects` | 资料对象存储（指向 MinIO S3 桶） |
| `/data/runtime` | `./data/runtime` | 运行时缓存与日志 |
| `/var/lib/postgresql/data` | 命名卷 `${CONTAINER_NAME}-pgdata` | PostgreSQL 数据 |
| `/data`（MinIO） | 命名卷 `${CONTAINER_NAME}-miniodata` | MinIO 对象存储 |

> PostgreSQL 与 MinIO 使用独立命名卷（`${CONTAINER_NAME}-pgdata` / `${CONTAINER_NAME}-miniodata`），与应用目录隔离，避免污染。

## 服务架构

应用包含 6 个容器：

| 服务 | 角色 | 重启策略 |
|------|------|----------|
| `api` | FastAPI + uvicorn 主服务 | `always` |
| `worker` | 异步 ingest 流水线 + 周期任务 | `always` |
| `postgres` | 元数据库（PostgreSQL 16） | `always` |
| `minio` | S3 兼容对象存储 | `always` |
| `minio-init` | 一次性创建 `marginalia` 桶 | `no` |
| `db-prepare` | 一次性运行 Alembic 迁移 | `no` |

## 环境变量

| 变量 | 必填 | 默认 | 用途 |
|------|------|------|------|
| `LLM_DEFAULT_PROVIDER` | 是 | `openai` | `openai` / `openai-compatible` / `anthropic` |
| `LLM_DEFAULT_API_KEY` | **是** | — | 大模型 API 密钥（缺失时容器启动失败） |
| `LLM_DEFAULT_MODEL` | 是 | `gpt-4o-mini` | 模型名 |
| `LLM_DEFAULT_BASE_URL` | 否 | — | 自建/网关的 API 端点 |
| `MARGINALIA_API_TOKEN` | 否 | — | API Bearer Token（LAN 暴露时必填） |
| `POSTGRES_USER` / `PASSWORD` / `DB` | 是 | `marginalia` | PostgreSQL 凭据 |
| `MINIO_ROOT_USER` / `PASSWORD` | 是 | `marginalia` | MinIO 凭据 |
| `TZ` | 是 | `Asia/Shanghai` | 时区 |
| `PANEL_APP_PORT_HTTP` | 是 | `8000` | 宿主机 HTTP 端口 |
| `PANEL_APP_PORT_MINIO_CONSOLE` | 是 | `9001` | MinIO 控制台端口（仅 127.0.0.1） |

## 镜像说明

| 镜像 | 用途 |
|------|------|
| `muhfalihr/marginalia:v0.3.4` | Marginalia API / Worker / db-prepare（第三方构建） |
| `postgres:16-alpine` | PostgreSQL 16 |
| `minio/minio:latest` | MinIO 对象存储 |
| `minio/mc:latest` | MinIO 客户端（minio-init） |

> ⚠️ 官方未发布预构建镜像，本应用使用 DockerHub 上 `muhfalihr/marginalia:v0.3.4`（社区构建，仅 amd64 架构）。如需自行构建，请使用：
> ```bash
> docker build -t muhfalihr/marginalia:v0.3.4 https://github.com/shenmintao/marginalia.git#v0.3.4
> ```
> 上游最新版本为 v0.3.6，但 DockerHub 第三方镜像仅发布到 v0.3.4，存在版本滞后风险。

## 常见问题

### Q1：容器一直重启，日志提示 `set LLM_DEFAULT_API_KEY in .env`？

A：LLM API Key 是必填项。返回 1Panel 部署参数页，在 **LLM API Key** 输入框填入有效的 Key 后重新部署。

### Q2：MinIO 控制台无法访问？

A：MinIO 控制台默认仅绑定 `127.0.0.1:9001`，只能在宿主机本地访问。如需远程访问，请通过 1Panel 终端进入 `minio` 容器操作：
```bash
docker exec -it <CONTAINER_NAME>-minio mc admin info local
```

### Q3：API 报 401 Unauthorized？

A：当 API 部署在非 loopback 网络（即 `HOST_IP` 不是 `127.0.0.1`）时，必须设置 `MARGINALIA_API_TOKEN`，并在 HTTP 客户端请求头中携带：
```
Authorization: Bearer <your-token>
```

### Q4：如何升级到上游最新版本？

A：上游未发布 v0.3.5+ 的预构建镜像。如需升级，需自行构建：
```bash
git clone --branch v0.3.6 https://github.com/shenmintao/marginalia.git
cd marginalia
docker build -t muhfalihr/marginalia:v0.3.6 .
docker push muhfalihr/marginalia:v0.3.6
```
然后在 1Panel 中新建 `0.3.6` 版本目录，将 `docker-compose.yml` 中的镜像 tag 改为 `v0.3.6`。

## 相关链接

- [上游仓库](https://github.com/shenmintao/marginalia)
- [上游 README（中文）](https://github.com/shenmintao/marginalia/blob/main/README.zh-CN.md)
- [上游设计文档](https://github.com/shenmintao/marginalia/blob/main/DESIGN.md)
- [DockerHub 第三方镜像](https://hub.docker.com/r/muhfalihr/marginalia)
