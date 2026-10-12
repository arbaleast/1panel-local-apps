# Hindsight 长期记忆系统

Vectorize.io Agent 记忆系统：retain/recall/reflect，跨会话持久化事实。

## 访问
- Dashboard: https://hindsight.arbaleast.top/dashboard
- HTTP API: http://192.168.98.246:8888

## 用途
- 存 Hermes Agent 等 AI Agent 的跨会话记忆
- retain: 写入事实
- recall: 语义搜索
- reflect: 综合推理多个事实

## 依赖
- PostgreSQL + pgvector (HNSW 向量索引)
- Redis (缓存)

## 凭证
- 后台登录: 见 .env HINDSIGHT_ADMIN_USER / HINDSIGHT_ADMIN_PASSWORD

## Reranker 配置

Hindsight 支持多种 Reranker 提供方。在 1Panel UI 部署时，`Reranker Provider` 默认 `local`（内置 `cross-encoder/ms-marco-MiniLM-L-6-v2`，无需任何 API key）。

### 切换到 SiliconFlow（硅基流动）

国内推荐使用 SiliconFlow（走 Cohere 兼容 `/rerank` 协议）：

1. 在 [cloud.siliconflow.cn](https://cloud.siliconflow.cn/account/ak) 申请 API Key（首次充值 1 元即可，新用户有免费额度）
2. 1Panel 部署表单 `Reranker Provider` 选 `siliconflow`
3. 填入 3 个字段：
   - `SiliconFlow API Key` — 你的 SK
   - `SiliconFlow Rerank Model` — 默认 `BAAI/bge-reranker-v2-m3`（多语言、100+ 语种）
   - `SiliconFlow Base URL` — 默认 `https://api.siliconflow.cn/v1`（已留空则使用官方）
4. 部署 / 重启 Hindsight 即可。

模型参考：

| Model | 适用场景 |
|---|---|
| `BAAI/bge-reranker-v2-m3` | 默认，多语言 100+ 语种 |
| `Qwen/Qwen3-Reranker-8B` | 更大、精度更高，慢但更准 |
| `Pro/BAAI/bge-reranker-v2-m3` | 同模型 Pro 通道（更快） |

### 切换到其他第三方

`Reranker Provider` 下拉里其他档位（`tei` / 自建 Cohere 兼容端点等）的配置项在表单里共用同组 key / model / base URL 字段，按需填写即可；如果是 LiteLLM 代理，请额外配置 `HINDSIGHT_API_LITELLM_API_BASE`（当前 1Panel 表单未暴露，请走应用内配置）。

### 自托管 TEI（自建 HuggingFace Text Embeddings Inference）

适合不想走任何第三方但需要 GPU 加速的场景：

1. `Reranker Provider` 选 `tei`
2. 启动 TEI 服务（如 `ghcr.io/huggingface/text-embeddings-inference`）暴露 rerank 端点
3. 1Panel 当前版本未单独暴露 `HINDSIGHT_API_RERANKER_TEI_URL` 字段，请走应用内环境变量配置（启动前 `docker exec` 设置或通过 Control Plane API）

