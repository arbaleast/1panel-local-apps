# Llama.cpp

高性能本地大语言模型推理引擎，基于 C/C++ 实现，支持 GGUF 量化模型，提供 OpenAI 兼容 API。

## 特性

- 支持 NVIDIA CUDA GPU 加速（默认启用）
- 兼容 OpenAI API 格式，可直接对接各类 AI 应用
- 支持多种 GGUF 量化格式（Q4_0, Q5_K_M, Q8_0 等）
- 内置 Web UI 可视化界面
- 轻量级部署，资源占用低

## 配置说明

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 镜像 | `ghcr.io/anbeeld/beellama.cpp:server-cuda12-v0.4.1` | CUDA 12.4 加速版本（支持 Pascal sm_61） |
| API 端口 | 8080 | HTTP API 端口 |
| GPU 层数 | -1 | 卸载到 GPU 的层数（-1=全部） |
| Embeddings 接口 | true | 启用 `/v1/embeddings` 端点（需 llama-server 支持） |
| 上下文长度 | 4096 | 模型上下文窗口大小 |
| CPU 线程 | 4 | CPU 推理线程数 |

## 使用方法

1. 部署应用后，将 GGUF 模型文件放入 `data/models/` 目录
2. 在配置中设置 `MODEL_FILE` 为模型文件名（如 `qwen2-7b-q4_k_m.gguf`）
3. 通过 `http://localhost:8080` 访问 Web UI
4. 使用 `http://localhost:8080/v1/chat/completions` 调用 OpenAI 兼容 API

## 硬件要求

- **GPU**: 支持 CUDA 的 NVIDIA 显卡（推荐显存 ≥ 8GB）
- **CPU**: 4 核以上（作为 GPU 的辅助处理）

### Pascal GPU 适配

本镜像基于 CUDA 12.4，兼容 Pascal 架构 sm_61（P104、GTX 10xx 系列等）。

- 宿主 NVIDIA 驱动版本需 ≥ 550.xx
- 可通过 `nvidia-smi` 查看当前驱动版本
- 如驱动版本 < 530，可改用 `ghcr.io/ggml-org/llama.cpp:server-cpu` 并设置 `GPU_LAYERS=0` 以纯 CPU 模式运行

## 参考

- [llama.cpp GitHub](https://github.com/ggml-org/llama.cpp)
- [GGUF 模型下载](https://huggingface.co/models?library=gguf)
