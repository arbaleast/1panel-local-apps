# syntax=docker/dockerfile:1
# =============================================================================
# Infinity — 本地 GPU Embeddings 推理服务镜像
# 目标: Pascal (sm_61) 最低兼容 / CUDA 12.4 (cu124) / Python 3.10
#
# 代理说明: 本文件不硬编码任何内网代理地址或凭据。
#   如构建期需要代理, 通过 build-arg 传入 (默认空值 = 直连):
#     docker build --build-arg HTTP_PROXY=http://<proxy>:<port> \
#                  --build-arg HTTPS_PROXY=http://<proxy>:<port> \
#                  -t infinity-pascal:cu124 .
# =============================================================================

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

# ---- 构建期代理参数 (默认空值, 不硬编码内网 IP) ----
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY}

# ---- 系统依赖: Python 3.10 + pip + venv (Ubuntu 22.04 默认 python3 = 3.10) ----
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

# ---- Python 虚拟环境 (固定路径, 供下方 LD_LIBRARY_PATH 引用) ----
WORKDIR /app
RUN python3 -m venv /app/.venv
ENV PATH=/app/.venv/bin:${PATH} \
    PIP_NO_CACHE_DIR=1

# ---- PyTorch cu124 wheels (可选策略, 详见 docs/BUILD.md 策略 A) ----
# wheels/ 目录由 Git LFS 跟踪, 构建前用 scripts/download_wheels.sh 预置。
# 若目录为空或没有 .whl 文件, 回退到 PyTorch 官方 cu124 index 拉取。
COPY wheels/ /tmp/wheels/
RUN if [ -d /tmp/wheels ] && [ -n "$(ls -A /tmp/wheels/*.whl 2>/dev/null)" ]; then \
        pip install /tmp/wheels/*.whl; \
    else \
        pip install torch==2.6.0+cu124 torchvision==0.21.0+cu124 \
            --index-url https://download.pytorch.org/whl/cu124; \
    fi

# ---- Infinity 本体 (从 PyPI 安装, all extras) ----
RUN pip install "infinity-emb[all]"

# ---- CUDA 动态库路径: cusparselt 提供 Pascal (sm_61) 稀疏矩阵内核 ----
ENV LD_LIBRARY_PATH=/app/.venv/lib/python3.10/site-packages/nvidia/cusparselt/lib:${LD_LIBRARY_PATH}

# ---- 运行时 HuggingFace 模型缓存 (compose 挂载 ./data:/app/.cache) ----
ENV HF_HOME=/app/.cache/huggingface

# ---- 对外端口 (与 formFields INFINITY_PORT 默认值 7997 一致) ----
EXPOSE 7997

# ---- 默认启动命令 (默认值写死; 运行时由 INFINITY_* 环境变量覆盖) ----
CMD ["infinity_emb", "--port", "7997", "--model-id", "BAAI/bge-large-zh-v1.5", "--dtype", "int8", "--batch-size", "32"]
