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

## 运行用户 UID / GID

安装参数 `UID` / `GID` 通过 compose 的 `user:` 指定容器内进程身份，默认 `99` / `100`。

⚠️ **首次部署前必须把数据目录属主改到同一 UID / GID**，否则容器无权写入、启动即失败：

```bash
# 以应用实际安装目录为准（1Panel → 应用 → llamaindex → 详情 → 路径）
sudo chown -R 99:100 <应用安装目录>/${DATA_PATH}
```

需要 chown 的目录（相对于应用安装目录）：`${DATA_PATH}`

- 想以 root 运行：把 `UID` / `GID` 都填 `0`
- 升级到新版本目录后要**重新 chown 一次**（新目录下的 `data` 为空、属主是 root）
- 容器内所有新文件都以该 UID / GID 创建，宿主机上看到属主是 99:100 属正常现象
