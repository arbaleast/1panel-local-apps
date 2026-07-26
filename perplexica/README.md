# Perplexica AI 搜索引擎

开源 AI 搜索引擎，类 Perplexity 的开源替代品。支持 OpenAI、Ollama、Groq、Anthropic、OpenRouter、Gemini、DeepSeek 等多种 AI 提供商。

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
