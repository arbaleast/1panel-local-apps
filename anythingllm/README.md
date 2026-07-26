# AnythingLLM

本地化 AI 文档问答与 RAG 一体化平台，支持多用户工作区、智能体与多种大模型对接。

## 功能特性

- **文档问答（RAG）**：上传 PDF、TXT、Markdown 等文档，构建本地知识库并进行智能问答
- **多用户工作区**：支持多个独立工作区，每个工作区可配置不同的 LLM 与向量数据库
- **多种 LLM 支持**：内置对接 OpenAI、Ollama、LM Studio、本地 LLM 等多种大模型
- **向量数据库**：内置 LanceDB，可选对接 Chroma、Pinecone、Qdrant、Weaviate 等
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

## 相关链接

- [项目主页](https://anythingllm.com/)
- [GitHub 仓库](https://github.com/Mintplex-Labs/anything-llm)
- [官方文档](https://docs.anythingllm.com/)
