# Infinity — 本地 GPU Embeddings 推理服务

1Panel 本地应用：基于 [项目主页](https://github.com/michaelf34/infinity) 的 Infinity 推理服务，兼容 OpenAI Embeddings API，可在 1Panel 内一键部署，自动批处理与动态批大小，支持 bge / e5 / qwen 等主流嵌入模型。

## 快速开始 / Quick Start

1. 打开 1Panel → **应用商店** → **本地应用**
2. 找到 **Infinity** → 点击 **安装**
3. 填写安装表单：
   - **Docker 镜像**：保持默认 `infinity-pascal:cu124`（本地构建镜像，详见 [BUILD.md](cu124/docs/BUILD.md)）
   - **嵌入模型**：默认 `BAAI/bge-large-zh-v1.5`，可切换为 `bge-m3` / `qwen3-emb-0.6b` 或填写任意 HuggingFace repo id
   - **模型精度**：Pascal（GTX 10 系）建议保持 `int8`
   - **推理批大小**：默认 `32`
   - **GPU 设备 ID**：默认 `0`，多卡填 `0,1`
   - **宿主机 API 端口**：默认 `7997`
4. 点击 **部署**，等待容器启动
5. 验证服务：浏览器访问 `http://<host>:7997/health`，或运行 [verify.sh](cu124/scripts/verify.sh)

## 功能特性 / Features

- 🚀 本地 GPU 推理，数据不出内网
- 🔌 兼容 OpenAI Embeddings API（`/v1/embeddings`），主流客户端（AnythingLLM、LangChain 等）可直接接入
- 📦 支持 bge / e5 / qwen 等主流嵌入模型，也支持任意 HuggingFace repo id
- ⚡ 自动批处理（batching）与动态批大小（dynamic batching）
- 🎯 多 GPU 支持，可指定 `NVIDIA_VISIBLE_DEVICES`

## GPU 要求 / GPU Requirements

| 架构 | 计算能力 | 建议 dtype | 显存建议 |
|------|----------|-----------|---------|
| Pascal（GTX 10 系等） | sm_61 / CC 6.1 | `int8`（最稳） | ≥ 4 GB |
| Ampere（RTX 30 系 / A 系列） | sm_80 / sm_86 | `float16` / `int8` | ≥ 6 GB |
| Hopper（H100 / H800 等） | sm_90 | `bfloat16` / `float16` | ≥ 8 GB |

> 说明：Pascal（sm_61）是默认构建的最低目标，`int8` 是其兼容性最佳选择；Ampere / Hopper 可用更高精度获取更好效果。不同模型的显存占用参考 [SUPPORTED_MODELS.md](cu124/docs/SUPPORTED_MODELS.md)。

## 支持模型 / Supported Models

| 模型 | HuggingFace repo id | 维度 |
|------|--------------------|------|
| bge-large-zh（中文） | `BAAI/bge-large-zh-v1.5` | 1024 |
| bge-m3（多语言） | `BAAI/bge-m3` | 1024 |
| qwen3-emb-0.6b（多语言） | `Qwen/Qwen3-Embedding-0.6B` | 1024 |

> 也支持任意自定义 HuggingFace repo id（填入 `EMBEDDING_MODEL` 即可）。更详细的维度 / dtype / batch / 显存建议见 [SUPPORTED_MODELS.md](cu124/docs/SUPPORTED_MODELS.md)。

## 环境变量 / Environment Variables

以下字段与 `cu124/data.yml` 的 formFields 严格一致：

| 环境变量 | 默认值 | 说明 |
|---------|-------|------|
| `IMAGE` | `infinity-pascal:cu124` | Docker 镜像（本地构建 tag） |
| `EMBEDDING_MODEL` | `BAAI/bge-large-zh-v1.5` | 嵌入模型 HF repo id，支持预设或自定义 |
| `DTYPE` | `int8` | 模型精度：`float16` / `int8` / `bfloat16` / `auto` |
| `BATCH_SIZE` | `32` | 推理批大小 |
| `NVIDIA_VISIBLE_DEVICES` | `0` | GPU 设备 ID，支持逗号分隔多卡（如 `0,1`） |
| `PANEL_APP_PORT_HTTP` | `7997` | 宿主机对外 API 端口 |
| `INFINITY_PORT` | `7997` | 容器内 API 端口（hidden，不建议修改） |

## 默认端口 / Default Ports

| 端口 | 用途 |
|------|------|
| `7997` | OpenAI 兼容 Embeddings API（宿主机与容器内 `INFINITY_PORT` 一致） |

## 持久化目录 / Persistent Directories

| 路径 | 说明 |
|------|------|
| `./data` | 容器内 HuggingFace 模型缓存目录（`HF_HOME`），首次下载后复用，避免重复拉取模型 |

> 模型默认下载到 `./data` 下缓存；如需清空重下，删除对应缓存目录后重启容器即可。

## 跟 AnythingLLM 集成 / Integration with AnythingLLM

AnythingLLM 与 Infinity 均部署在 1Panel 的 `1panel-network` 网络内：

1. 在 AnythingLLM 设置中选择 **Embedding Provider** → 使用自定义 OpenAI 兼容端点
2. Endpoint 填写 `http://infinity:7997/v1`（容器名 `infinity` 在同一网络内可直接解析）
3. 选择模型为 `EMBEDDING_MODEL` 对应名称（如 `BAAI/bge-large-zh-v1.5`）

> 注意：AnythingLLM 的 Embedding 维度需与所选模型维度一致（见 [SUPPORTED_MODELS.md](cu124/docs/SUPPORTED_MODELS.md)）。

## 已知问题 / Known Issues

- flash-attn 编译/安装问题
- bitsandbytes 与 Pascal 兼容性
- 数据集加载 HuggingFace 失败（需代理）

详见 [KNOWN_ISSUES.md](cu124/docs/KNOWN_ISSUES.md)。

## 自行构建 / Build from Source

镜像需要在本地源码构建（Pascal sm_61 限制，需预置 cu124 wheels）：

```bash
bash cu124/scripts/build.sh        # 构建 infinity-pascal:cu124
```

> 构建上下文为 `infinity/cu124/`，cu124 wheels 需预先放置到 `infinity/cu124/wheels/`（由 `cu124/scripts/download_wheels.sh` 下载、Git LFS 跟踪）。

构建策略（wheels 来源、Git LFS / Release 附件 / 外部下载源）详见 [BUILD.md](cu124/docs/BUILD.md)。

## 相关链接 / Related Links

- 项目主页：[https://github.com/michaelf34/infinity](https://github.com/michaelf34/infinity)
- Docker Hub：[`michaelf34/infinity`](https://hub.docker.com/r/michaelf34/infinity)
- GitHub：[https://github.com/michaelf34/infinity](https://github.com/michaelf34/infinity)

---

<!-- English version below -->

# Infinity — Local GPU Embeddings Inference Server

A 1Panel local app for the [project](https://github.com/michaelf34/infinity) Infinity inference server. OpenAI-compatible Embeddings API, one-click deploy inside 1Panel, with automatic and dynamic batching. Supports bge / e5 / qwen and other mainstream embedding models.

## Quick Start

1. Open 1Panel → **App Store** → **Local Apps**
2. Find **Infinity** → click **Install**
3. Fill in the install form:
   - **Docker Image**: keep `infinity-pascal:cu124` (locally built image, see [BUILD.md](cu124/docs/BUILD.md))
   - **Embedding Model**: default `BAAI/bge-large-zh-v1.5`; switch to `bge-m3` / `qwen3-emb-0.6b` or any HuggingFace repo id
   - **Model Precision**: keep `int8` on Pascal (GTX 10 series)
   - **Batch Size**: default `32`
   - **GPU Device IDs**: default `0`, use `0,1` for multi-GPU
   - **Host API Port**: default `7997`
4. Click **Deploy** and wait for the container to start
5. Verify: visit `http://<host>:7997/health`, or run [verify.sh](cu124/scripts/verify.sh)

## Features

- Local GPU inference, data never leaves your network
- OpenAI-compatible API (`/v1/embeddings`), drop-in for AnythingLLM, LangChain, etc.
- bge / e5 / qwen and any HuggingFace repo id
- Automatic batching with dynamic batch size
- Multi-GPU support via `NVIDIA_VISIBLE_DEVICES`

## GPU Requirements

| Architecture | Compute Capability | Suggested dtype | VRAM |
|--------------|--------------------|-----------------|------|
| Pascal (GTX 10 series) | sm_61 / CC 6.1 | `int8` (safest) | ≥ 4 GB |
| Ampere (RTX 30 / A series) | sm_80 / sm_86 | `float16` / `int8` | ≥ 6 GB |
| Hopper (H100 / H800 etc.) | sm_90 | `bfloat16` / `float16` | ≥ 8 GB |

> Pascal (sm_61) is the baseline build target; `int8` is the best compatibility choice there. Ampere / Hopper can use higher precision. See [SUPPORTED_MODELS.md](cu124/docs/SUPPORTED_MODELS.md) for per-model VRAM guidance.

## Supported Models

| Model | HuggingFace repo id | Dimensions |
|-------|--------------------|------------|
| bge-large-zh (Chinese) | `BAAI/bge-large-zh-v1.5` | 1024 |
| bge-m3 (multilingual) | `BAAI/bge-m3` | 1024 |
| qwen3-emb-0.6b (multilingual) | `Qwen/Qwen3-Embedding-0.6B` | 1024 |

Any custom HuggingFace repo id is also supported via `EMBEDDING_MODEL`. See [SUPPORTED_MODELS.md](cu124/docs/SUPPORTED_MODELS.md) for dtype / batch / VRAM details.

## Environment Variables

Strictly matching the formFields in `cu124/data.yml`:

| Env var | Default | Description |
|---------|---------|-------------|
| `IMAGE` | `infinity-pascal:cu124` | Docker image (local build tag) |
| `EMBEDDING_MODEL` | `BAAI/bge-large-zh-v1.5` | HF repo id, preset or custom |
| `DTYPE` | `int8` | Precision: `float16` / `int8` / `bfloat16` / `auto` |
| `BATCH_SIZE` | `32` | Inference batch size |
| `NVIDIA_VISIBLE_DEVICES` | `0` | GPU device IDs, comma-separated (e.g. `0,1`) |
| `PANEL_APP_PORT_HTTP` | `7997` | Host API port |
| `INFINITY_PORT` | `7997` | Container API port (hidden, not recommended to change) |

## Default Ports

| Port | Purpose |
|------|---------|
| `7997` | OpenAI-compatible Embeddings API (same host & container `INFINITY_PORT`) |

## Persistent Directories

| Path | Description |
|------|-------------|
| `./data` | HuggingFace model cache (`HF_HOME`) inside the container; models are reused across restarts |

## Integration with AnythingLLM

Both AnythingLLM and Infinity run on the 1Panel `1panel-network`:

1. In AnythingLLM settings, pick an OpenAI-compatible Embedding Provider
2. Endpoint: `http://infinity:7997/v1` (container name `infinity` resolves on the same network)
3. Set the model name to the one in `EMBEDDING_MODEL` (e.g. `BAAI/bge-large-zh-v1.5`)

> The embedding dimension must match the model (see [SUPPORTED_MODELS.md](cu124/docs/SUPPORTED_MODELS.md)).

## Known Issues

- flash-attn build/install problems
- bitsandbytes vs Pascal compatibility
- HuggingFace dataset download failures (proxy needed)

See [KNOWN_ISSUES.md](cu124/docs/KNOWN_ISSUES.md).

## Build from Source

The image is built locally (Pascal sm_61 constraint, cu124 wheels required):

```bash
bash cu124/scripts/build.sh        # build infinity-pascal:cu124
```

> Build context is `infinity/cu124/`; place cu124 wheels under `infinity/cu124/wheels/` (downloaded via `cu124/scripts/download_wheels.sh`, tracked with Git LFS).

Build strategies (wheels source, Git LFS / Release asset / external download) are in [BUILD.md](cu124/docs/BUILD.md).

## Related Links

- Project home: [https://github.com/michaelf34/infinity](https://github.com/michaelf34/infinity)
- Docker Hub: [`michaelf34/infinity`](https://hub.docker.com/r/michaelf34/infinity)
- GitHub: [https://github.com/michaelf34/infinity](https://github.com/michaelf34/infinity)