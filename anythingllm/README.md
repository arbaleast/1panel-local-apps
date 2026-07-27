# AnythingLLM

本地化 AI 文档问答与 RAG 一体化平台，支持多用户工作区、智能体与多种大模型对接。

## 功能特性

- **文档问答（RAG）**：上传 PDF、TXT、Markdown 等文档，构建本地知识库并进行智能问答
- **多用户工作区**：支持多个独立工作区，每个工作区可配置不同的 LLM 与向量数据库
- **多种 LLM 支持**：内置对接 OpenAI、Ollama、LM Studio、本地 LLM 等多种大模型
- **向量数据库**：内置 LanceDB，可选对接 Qdrant、Chroma、Pinecone、Weaviate 等
- **智能体（Agent）**：支持工具调用、网页搜索等 Agent 能力
- **多模态支持**：支持图片理解、语音转文字等多模态交互

## 部署说明

### 默认端口

- Web UI：`3001`（通过 `PANEL_APP_PORT_HTTP` 自定义宿主机端口）

### 首次访问流程

1. 部署完成后通过浏览器访问 `http://<宿主机IP>:<端口>`
2. 首次访问会进入设置向导，配置 LLM 提供方与 API Key
3. 创建第一个工作区即可开始使用

### 持久化目录

- `./data/storage` → `/app/server/storage`（文档、工作区等数据）
- `./data/.env` → `/app/server/.env`（运行时环境变量配置）

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `STORAGE_DIR` | 持久化存储目录（容器内） | `/app/server/storage` |
| `JWT_SECRET` | JWT 认证密钥（必填） | — |
| `DISABLE_TELEMETRY` | 禁用遥测数据上报 | `true` |
| `SERVER_PORT` | 服务监听端口 | `3001` |
| `ANYTHING_LLM_RAG_API_URL` | 外部 RAG API 地址（可选） | — |
| `VECTOR_DB` | 向量数据库引擎（`lancedb` / `qdrant`） | `lancedb` |
| `QDRANT_ENDPOINT` | Qdrant 地址（使用 qdrant 时填写） | `http://qdrant:6333` |
| `DATABASE_URL` | PostgreSQL 连接地址（需 :pg 标签镜像） | — |

## 向量数据库

### LanceDB（默认）

无需任何配置，部署即用。LanceDB 是内置的本地向量数据库，适合大多数场景。

### Qdrant

如需使用 Qdrant 作为向量数据库：

1. 将 `VECTOR_DB` 设为 `qdrant`
2. `QDRANT_ENDPOINT` 填入 Qdrant 地址（同 1Panel 环境下默认 `http://qdrant:6333`）
3. 需要单独部署 [Qdrant](../qdrant/) 应用，且与 AnythingLLM 在同一网络

部署完成后，在 AnythingLLM 设置中 `Vector Database → LanceDB` 切换为 `Qdrant`，重启生效。

## 外部数据库（可选）

AnythingLLM 默认使用 SQLite 存储所有数据（位于 `./data/storage`），无需额外配置即可运行。

如需切换到 PostgreSQL，请按以下步骤操作：

### PostgreSQL 部署步骤

1. **切换镜像**：将 Docker 镜像改为 `mintplexlabs/anythingllm:pg`（这是启用 PostgreSQL 的必要条件，标准 `latest` 镜像不含 PostgreSQL Prisma 客户端）
2. **填写连接地址**：在 `DATABASE_URL` 填入 PostgreSQL 连接串，格式为 `postgresql://用户名:密码@主机:端口/数据库名`
3. **首次启动迁移**：部署后执行一次数据库迁移：
   ```bash
   docker exec <容器名> yarn prisma:setup
   ```
4. **单独部署 PostgreSQL**：1Panel 环境下需单独部署 [pgvector](../pgvector/) 应用，然后将 `DATABASE_URL` 中的主机指向该应用的容器名

> **注意**：
> - `DATABASE_URL` 留空时应用继续使用 SQLite，完全向后兼容
> - PostgreSQL 支持仅适用于 `:pg` 标签镜像（如 `mintplexlabs/anythingllm:pg` 或 `pg-1.15.0`），使用标准 `latest` 镜像设置 `DATABASE_URL` 无效
> - 切换后原有 SQLite 数据不会自动迁移

## 相关链接

- [项目主页](https://anythingllm.com/)
- [GitHub 仓库](https://github.com/Mintplex-Labs/anything-llm)
- [官方文档](https://docs.anythingllm.com/)
