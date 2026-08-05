# 支持模型与显存建议

以下为 Infinity 常见嵌入模型的配置建议。`维度` 为 embedding 输出维度（与下游向量库/AnythingLLM 配置强相关），`dtype` 与 `batch` 为建议起始值，`显存估算` 为单个 GPU 上模型权重 + 推理缓存的粗略占用。

> 显存估算随模型尺寸、`BATCH_SIZE`、序列长度浮动；以 `nvidia-smi` 实测为准。Pascal（sm_61）一律建议 `dtype=int8`（见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)）。

## 预设模型

| model id（HuggingFace repo） | 维度 | dtype | 推荐 batch | 显存估算 | 备注 |
|---|---|---|---|---|---|
| `BAAI/bge-large-zh-v1.5` | 1024 | int8 | 32 | ~2 GB | 中文为主，默认值 |
| `BAAI/bge-m3` | 1024 | int8 | 32 | ~6 GB | 多语言，长文本/稠密检索 |
| `Qwen/Qwen3-Embedding-0.6B` | 1024 | int8 | 32 | ~1.5 GB | 多语言，轻量 |

## 自定义模型

任意 HuggingFace repo id 均可填入 `EMBEDDING_MODEL`。通用估算：

| 模型规模 | 维度 | dtype | 推荐 batch | 显存估算 | 备注 |
|---|---|---|---|---|---|
| ~0.1B（如 bge-small 系列） | 512–768 | int8 | 64 | < 1 GB | 轻量场景 |
| ~0.3–0.4B（如 bge-base 系列） | 768 | int8 | 32–64 | ~1–2 GB | 通用 |
| ~1.5B（如 e5-large-v2 / bge-large 系列） | 1024 | int8 | 32 | ~2–4 GB | 效果优先 |
| ~7B（如 Qwen3-Embedding-7B） | 1024 | int8 | 8–16 | ~8–12 GB | 需中高端 GPU |

## dtype 与显存关系

| dtype | 相对 int8 | 说明 |
|---|---|---|
| `int8` | 1×（基准） | Pascal 兼容性最佳，默认值 |
| `float16` | ~2× | Ampere+ 推荐，效果更稳 |
| `bfloat16` | ~2× | Hopper / Ampere 原生支持 |
| `auto` | 由框架自动选择 | 不确定时可选 |

> 示例：`BAAI/bge-m3` 在 int8 下约 6 GB；切到 `float16` 预计 8–10 GB，Pascal 上不推荐（见 KNOWN_ISSUES 中 flash-attn 与 int8 说明）。

## 调整建议

- `BATCH_SIZE` 过大导致 OOM 时：先降到 `16` / `8`，或改用 `int8`。
- 多卡：`NVIDIA_VISIBLE_DEVICES=0,1` 可把模型分到多张 GPU。
- 首次启动会从 HuggingFace 拉取模型，耗时取决于网络；可参考 [KNOWN_ISSUES.md](KNOWN_ISSUES.md) 配置代理或镜像源。
