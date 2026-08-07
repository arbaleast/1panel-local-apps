# LlamaIndex

LlamaIndex RAG 与 Agent 框架，连接本地 Ollama LLM 提供文档索引和智能问答服务。

## 功能特性

- **RAG（检索增强生成）**：上传文档，构建本地知识库
- **Agent 推理**：连接 Ollama 本地 LLM 进行智能问答
- **向量存储**：内置持久化向量存储
- **Human-in-the-Loop**：支持人工审核关键操作

## 必要配置

- **Ollama 服务**：需要先部署 Ollama（本地或远程），确保 `OLLAMA_BASE_URL` 可访问
- **模型**：首次使用需确保 Ollama 中已下载对应模型

## 端口

- HTTP: `8000`（可自定义宿主机端口）
