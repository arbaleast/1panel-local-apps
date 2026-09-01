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
- **1Panel 主 PG 18 凭据**（复用 1Panel-postgresql，**非捆绑独立容器**）：
  - `PostgreSQL Host`：1Panel 应用商店的 `1Panel-postgresql-XXXX` 容器名（`XXXX` 为随机后缀，从 1Panel 容器列表复制）
  - `PostgreSQL User / Password`：取自 1Panel-postgresql 应用详情页（`user_xxxxxx` + 强随机密码）
  - `PostgreSQL Database`：**部署前必须先在 1Panel 主 PG 中预创建** `marginalia` 库（参见下文"快速开始"第 1 步）
- **MinIO 凭据**（内置容器）：默认用户名密码均为 `marginalia`，建议首次部署后通过 1Panel 终端修改。

## 快速开始

1. **预创建数据库**（必做，仅首次）：登录 1Panel 主 PG，执行 `CREATE DATABASE marginalia;`（在 1Panel 数据库管理页或终端内 `psql` 均可）。
2. 在 1Panel 应用商店搜索 **Marginalia** 并安装。
3. 部署参数页填写：
   - **PostgreSQL 段**：`PostgreSQL Host` 填 1Panel-postgresql 容器名（如 `1Panel-postgresql-ZU4y`）、`PostgreSQL User / Password` 取自主 PG 详情页、`PostgreSQL Database` 填 `marginalia`
   - **LLM 段**：`LLM API Key`（必填）、`LLM Provider`（openai / openai-compatible / anthropic）、`LLM Model`（默认 `gpt-4o-mini`，可改为 `gpt-4o` / `claude-3-5-sonnet-...` 等）
   - 自建/第三方网关：填 `LLM Base URL`
4. 等待 1-2 分钟（包含 MinIO 桶创建、上游应用启动时自动跑 Alembic 迁移与 `_inbox` seed）。
5. 访问 `http://<宿主机IP>:<端口>` 进入 API（默认 8000）。

> 上游 [`src/marginalia/db/bootstrap.py`](https://github.com/shenmintao/marginalia/blob/main/src/marginalia/db/bootstrap.py) 在 `uvicorn` 启动时会自动调用 `bootstrap_schema()`，在 1Panel 主 PG 18 上**首次启动即建表 + 跑 16 个增量 shim + stamp `alembic_version` 到 head**，无需额外迁移容器。

## 服务端口

| 端口 | 用途 | 暴露策略 |
|------|------|----------|
| 8000 | Marginalia API | 对外（`PANEL_APP_PORT_HTTP`） |
| 9001 | MinIO 控制台 | 仅 127.0.0.1（本地调试） |
| 9000 | MinIO S3 API | 内部网络（外部 PG 在 1Panel 主机的 `1Panel-postgresql` 容器内，不暴露给本应用） |

如需在 LAN 上访问 API，请同时设置 `MARGINALIA_API_TOKEN`（API Bearer Token），并在 HTTP 客户端请求头中携带 `Authorization: Bearer <token>`。

## 持久化目录

| 容器路径 | 主机路径 | 用途 |
|----------|----------|------|
| `/data/library` | `./data/library` | 资料库元数据与目录树 |
| `/data/objects` | `./data/objects` | 资料对象存储（指向 MinIO S3 桶） |
| `/data/runtime` | `./data/runtime` | 运行时缓存与日志 |
| `/data`（MinIO） | `./data/minio` | MinIO 对象存储 |

> **PostgreSQL 不在本地落盘**：本应用复用 1Panel 主机的 `1Panel-postgresql-XXXX` 容器，库与表都建在 1Panel 主 PG（默认 PG 18）中，`./data/minio` 仅负责 MinIO 对象存储。

## 服务架构

应用包含 4 个容器：

| 服务 | 角色 | 重启策略 |
|------|------|----------|
| `api` | FastAPI + uvicorn 主服务（启动时自动跑 `bootstrap_schema()` 创建表/迁移） | `always` |
| `worker` | 异步 ingest 流水线 + 周期任务（同样启动时 bootstrap） | `always` |
| `minio` | S3 兼容对象存储 | `always` |
| `minio-init` | 一次性创建 `marginalia` 桶 | `no` |

> PostgreSQL **不在本应用**中声明：复用 1Panel 主机已部署的 `1Panel-postgresql-XXXX` 容器（通常为 PG 18），库 `marginalia` 需要预创建（参见"快速开始"第 1 步）。

## 环境变量

### 核心凭据与服务

| 变量 | 必填 | 默认 | 用途 |
|------|------|------|------|
| `LLM_DEFAULT_PROVIDER` | 是 | `openai` | `openai` / `openai-compatible` / `anthropic` |
| `LLM_DEFAULT_API_KEY` | **是** | — | 大模型 API 密钥（缺失时容器启动失败） |
| `LLM_DEFAULT_MODEL` | 是 | `gpt-4o-mini` | 模型名 |
| `LLM_DEFAULT_BASE_URL` | 否 | — | 自建/网关的 API 端点 |
| `MARGINALIA_API_TOKEN` | 否 | — | API Bearer Token（LAN 暴露时必填） |
| `POSTGRES_HOST` | 是 | — | 1Panel 主 PG 容器名（如 `1Panel-postgresql-ZU4y`，随机后缀） |
| `POSTGRES_PORT` | 是 | `5432` | 1Panel 主 PG 端口（默认 `5432`） |
| `POSTGRES_USER` | 是 | — | 1Panel 主 PG 用户（随机 `user_xxxxxx`） |
| `POSTGRES_PASSWORD` | **是** | — | 1Panel 主 PG 密码（1Panel-postgresql 应用详情页） |
| `POSTGRES_DB` | 是 | `marginalia` | 数据库名，**部署前需在 1Panel 主 PG 中预创建** |
| `MINIO_ROOT_USER` / `PASSWORD` | 是 | `marginalia` | MinIO 凭据 |
| `TZ` | 是 | `Asia/Shanghai` | 时区 |
| `PANEL_APP_PORT_HTTP` | 是 | `8000` | 宿主机 HTTP 端口 |
| `PANEL_APP_PORT_MINIO_CONSOLE` | 是 | `9001` | MinIO 控制台端口（仅 127.0.0.1） |

### 运行调优（可选）

| 变量 | 默认 | 用途 |
|------|------|------|
| `LOG_LEVEL` | `INFO` | 应用日志级别（`DEBUG` / `INFO` / `WARNING` / `ERROR`） |
| `MARGINALIA_API_HOST` | `0.0.0.0` | 容器内 API 绑定地址（`127.0.0.1` = 仅本机） |
| `MARGINALIA_UPLOAD_TOKEN` | — | 上传端点独立 Bearer Token（留空=沿用 API Token） |
| `MARGINALIA_UPLOAD_MAX_BYTES` | `0` | 单次上传字节上限（`0` = 不限；推荐 `209715200` ≈ 200 MB） |
| `STORAGE_BACKEND` | `s3` | 存储后端：`s3`（MinIO）/ `local`（UUID 扁平）/ `mirror`（目录镜像） |
| `S3_BUCKET` | `marginalia` | S3 桶名（仅当 `STORAGE_BACKEND=s3`） |
| `S3_REGION` | `us-east-1` | S3 区域标识 |
| `SEMANTIC_RECALL_ENABLED` | `true` | 语义检索开关（关闭则仅关键词） |
| `AUTO_LIFECYCLE_ENABLED` | `false` | 自动资料库生命周期（保留/清理） |
| `LIBRARY_DOCUMENT_LIMIT` | `0` | 资料库最大文档数（`0` = 不限） |
| `MAINTENANCE_DAILY_TOKEN_BUDGET` | `0` | 后台维护每日 token 预算（`0` = 不限） |

### Embedding / Rerank 子 profile

marginalia 将 embedding 与 LLM 主模型**完全解耦**，可独立配置凭据与模型：

| 变量 | 默认 | 用途 |
|------|------|------|
| `EMBEDDING_API_KEY` | — | Embedding API 密钥（留空=沿用 `LLM_DEFAULT_API_KEY`） |
| `EMBEDDING_BASE_URL` | — | Embedding API 端点（留空=沿用 `LLM_DEFAULT_BASE_URL`） |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding 模型名 |
| `RERANK_ENABLED` | `false` | 启用 Rerank 阶段（默认 `qwen3-rerank`） |

## 镜像说明

| 镜像 | 用途 |
|------|------|
| `muhfalihr/marginalia:v0.3.4` | Marginalia API / Worker（第三方构建，启动时跑 `bootstrap_schema()`） |
| `minio/minio:latest` | MinIO 对象存储（与上游官方保持一致） |
| `minio/mc:latest` | MinIO 客户端（minio-init） |

> PostgreSQL **不在本应用内提供**：使用 1Panel 主机上已部署的 `1Panel-postgresql` 容器（默认 PG 18）。

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

### Q5：1Panel 主机上装的是 PostgreSQL 18，marginalia 能用吗？

A：可以直接用。**v0.3.4 已切换为"复用 1Panel 主 PG 18"模式**，本应用不再捆绑独立 PG 容器。整体架构：

- **数据库**：使用 1Panel 主机上已部署的 `1Panel-postgresql-XXXX` 容器（默认 PG 18），元数据落在 `marginalia` 库中；
- **对象存储**：本应用仍自带 MinIO（bind mount `./data/minio` → 容器内 `/data`）；
- **迁移**：由上游 [`src/marginalia/db/bootstrap.py`](https://github.com/shenmintao/marginalia/blob/main/src/marginalia/db/bootstrap.py) 在 `uvicorn` 启动时自动调用 `bootstrap_schema()` 完成建表 + 16 个增量 shim + stamp `alembic_version`，**无需独立迁移容器**。

**完整部署步骤**（首次安装）：

1. **预创建数据库**：登录 1Panel → 数据库 → `1Panel-postgresql` → 进入 `psql` 终端（或用 pgAdmin 等 GUI），执行：
   ```sql
   CREATE DATABASE marginalia;
   ```
2. **记录 1Panel 主 PG 连接信息**（1Panel-postgresql 应用详情页或容器环境变量）：
   - 容器名（`1Panel-postgresql-XXXX`）
   - 端口（默认 `5432`）
   - 用户名（`user_xxxxxx`）
   - 密码（强随机字符串）
3. **部署 marginalia**：在 1Panel 应用商店安装 marginalia，参数页填写：
   - `PostgreSQL Host`：第 2 步拿到的容器名
   - `PostgreSQL Port`：`5432`
   - `PostgreSQL User / Password`：第 2 步拿到的用户名 / 密码
   - `PostgreSQL Database`：`marginalia`
   - `LLM API Key`：必填
4. **首次启动自动迁移**：`api` / `worker` 容器启动时会上游 bootstrap 跑表结构 + 16 个 shim + stamp `alembic_version`，日志中可见 `bootstrap_schema complete`，无需手动干预。

**为什么选复用而不是捆绑独立容器**：

- 1Panel 主机已装 PG 18，再起一个 PG 16 容器会**重复占用内存 / 重复维护两套升级**；
- 复用主 PG 可以**沿用 1Panel 的备份 / 监控**链路；
- marginalia 上游 SQLAlchemy 2.x + asyncpg 不依赖 16 专属特性，**理论上 PG 13+ 都可运行**（上游未在 ≥17 上做完整回归，但 `bootstrap.py` 用的是通用 DDL）。

**回退到旧版（内置独立 PG 16）**：如确实需要回到 v0.3.4 之前的"自带 PG"版本，请降级到 [`marginalia/0.3.3`](../0.3.3/README.md)（如有）或回退 git 提交。

### Q6：为什么没看到 Embedding / Rerank 的配置项？

A：v0.3.4 应用商店版本已暴露 4 个独立 formField（`EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `RERANK_ENABLED`），默认沿用 LLM 主模型的凭据。单独填写即可覆盖。

## 相关链接

- [上游仓库](https://github.com/shenmintao/marginalia)
- [上游 README（中文）](https://github.com/shenmintao/marginalia/blob/main/README.zh-CN.md)
- [上游设计文档](https://github.com/shenmintao/marginalia/blob/main/DESIGN.md)
- [DockerHub 第三方镜像](https://hub.docker.com/r/muhfalihr/marginalia)
