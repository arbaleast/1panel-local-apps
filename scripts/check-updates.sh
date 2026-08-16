#!/usr/bin/env bash
# 1Panel Local Apps - 镜像更新检查薄壳
# DEPRECATED: 实际逻辑已迁至 .github/scripts/detect-updates.mjs
# 保留此脚本仅为兼容本地手跑，详见 AGENTS.md "lib/ 模块" 节

set -euo pipefail

# 检查 node 可用
command -v node >/dev/null 2>&1 || { echo "[ERROR] 需要 node >= 18"; exit 1; }

# 透传所有参数
exec node "$(dirname "$0")/../.github/scripts/detect-updates.mjs" "$@"
