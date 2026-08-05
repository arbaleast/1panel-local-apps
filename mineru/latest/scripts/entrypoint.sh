#!/bin/bash
# MinerU Router 入口脚本
# 根据 ENABLE_GPU 环境变量控制 GPU 行为
set -e

if [ "${ENABLE_GPU}" = "false" ]; then
    # 关闭 GPU：强制 worker 仅聚合无本地推理
    export LOCAL_GPUS="none"
    unset GPU_RUNTIME
    unset NVIDIA_VISIBLE_DEVICES
else
    # 启用 GPU：确保 runtime 设为 nvidia（兼容用户自定义 GPU_RUNTIME）
    export GPU_RUNTIME="${GPU_RUNTIME:-nvidia}"
fi

# 执行 mineru-router，传递所有原始参数
exec mineru-router "$@"
