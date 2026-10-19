# Vane AI 问答引擎

Vane 是一款 AI 驱动的问答引擎，支持 OpenAI、Ollama、Groq、Anthropic、OpenRouter、Gemini、DeepSeek 等多种 AI 提供商。

> ⚠️ 本项目原名 Perplexica，已于 2026 年由作者改名为 Vane。Docker 镜像已迁移至 `itzcrazykns1337/vane`。

## 访问

- Web: `http://<主机IP>:<端口>`

## 功能特性

- 🔍 AI 驱动的语义搜索，理解查询意图并返回精准结果
- 🤖 支持多种 AI 提供商：OpenAI、Ollama、Groq、Anthropic、OpenRouter、Gemini、DeepSeek、LMStudio
- 📖 引用来源可追溯，每条结果附带参考链接
- 🎯 多种搜索模式：简易搜索、综合搜索、研究模式等
- 🔒 本地部署，数据完全自控

## 配置

### 必填项

| 变量 | 说明 | 默认值 |
|------|------|--------|
| AI_PROVIDER | AI 提供商 | openai |
| AI_MODEL | 模型名称 | gpt-4o-mini |
| API_KEY | API 密钥 | - |

### 可选项

| 变量 | 说明 | 默认值 |
|------|------|--------|
| API_URL | 自定义 API 端点（用于 Ollama/LMStudio/Custom） | - |

### 数据目录

- 持久化数据（SQLite 数据库）存储在 `./data/` 目录
- 升级应用时数据不会丢失

## 使用示例

### 使用 OpenAI

- AI_PROVIDER: `openai`
- AI_MODEL: `gpt-4o-mini`
- API_KEY: 你的 OpenAI API Key

### 使用 Ollama（需确保 Ollama 可达）

- AI_PROVIDER: `ollama`
- AI_MODEL: `llama3.1`
- API_URL: `http://host.docker.internal:11434/v1`

### 使用 Groq

- AI_PROVIDER: `groq`
- AI_MODEL: `llama-3.1-70b-versatile`
- API_KEY: 你的 Groq API Key

### 使用 DeepSeek

- AI_PROVIDER: `deepseek`
- AI_MODEL: `deepseek-chat`
- API_KEY: 你的 DeepSeek API Key

## 注意事项

- 端口变更会影响反向代理配置
- 使用 Ollama 时需通过 `host.docker.internal` 访问宿主机上的 Ollama 服务

## 迁移说明

从旧版 Perplexica 升级到 Vane 时，需要在 1Panel 中**重新部署**应用（不能原地升级）。数据目录 `./data/` 中的数据库可保留，但容器配置需要重新生成以匹配新的镜像地址。

## 已知问题

- ⚠️ 官方 Vane logo 暂未抓取（上游仓库中未找到对应资源），当前仍为旧品牌图标，待后续更新。

## 运行用户 UID / GID

安装参数 `UID` / `GID` 通过 compose 的 `user:` 指定容器内进程身份，默认 `99` / `100`。

⚠️ **首次部署前必须把数据目录属主改到同一 UID / GID**，否则容器无权写入、启动即失败：

```bash
# 以应用实际安装目录为准（1Panel → 应用 → vane → 详情 → 路径）
sudo chown -R 99:100 <应用安装目录>/data
```

需要 chown 的目录（相对于应用安装目录）：`./data`

- 想以 root 运行：把 `UID` / `GID` 都填 `0`
- 升级到新版本目录后要**重新 chown 一次**（新目录下的 `data` 为空、属主是 root）
- 容器内所有新文件都以该 UID / GID 创建，宿主机上看到属主是 99:100 属正常现象
