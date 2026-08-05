#!/usr/bin/env bash
# =============================================================================
# build.sh
#
# 用途: 在本地构建 Infinity 镜像 (tag: infinity-pascal:cu124)。
#       构建上下文为 infinity/latest/ (包含 Dockerfile)。
#
# 使用方式:
#   chmod +x infinity/scripts/build.sh
#   bash infinity/scripts/build.sh                  # 默认构建
#   bash infinity/scripts/build.sh --no-cache       # 禁用层缓存, 全量重建
#
# 前置条件:
#   - infinity/latest/wheels/ 下已有 cu124 wheels (先跑 download_wheels.sh)
#   - 本机已安装 Docker
#
# 注意:
#   - 本脚本不硬编码任何凭据 / IP / 内网域名。
# =============================================================================

set -euo pipefail

# 仓库根目录 = 脚本所在目录的上一级 (infinity/scripts -> infinity/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 镜像 tag 与构建上下文
IMAGE_TAG="infinity-pascal:cu124"
BUILD_CONTEXT="${REPO_ROOT}/latest"

# 收集附加参数 (如 --no-cache), 原样透传给 docker build
EXTRA_ARGS=("$@")

echo "==> 检查 Docker 是否可用..."
if ! command -v docker >/dev/null 2>&1; then
  echo "!! 未找到 docker 命令, 请先安装 Docker。"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "!! Docker 守护进程不可用, 请确认 Docker 已启动。"
  exit 1
fi

echo "==> 检查 wheels 是否已就绪..."
# 粗略检查: 上下文目录中应存在 cu124 的 wheel (Dockerfile 会 COPY wheels/)
if ! ls "${BUILD_CONTEXT}"/wheels/*cu124*.whl >/dev/null 2>&1; then
  echo "!! 未在 ${BUILD_CONTEXT}/wheels/ 中找到 cu124 wheel。"
  echo "   请先执行: bash infinity/scripts/download_wheels.sh"
  echo "   并确认 wheel 已放置到构建上下文可访问的位置 (见 docs/BUILD.md)。"
  exit 1
fi

echo "==> 构建命令: docker build ${EXTRA_ARGS[*]:-} -t ${IMAGE_TAG} ${BUILD_CONTEXT}"
# 注意: 参数数组为空时 ${EXTRA_ARGS[*]:-} 会展开为空字符串, 避免多余空格问题
# 这里直接展开为数组元素
docker build "${EXTRA_ARGS[@]}" -t "${IMAGE_TAG}" "${BUILD_CONTEXT}"

echo ""
echo "========================================================"
echo "构建完成: ${IMAGE_TAG}"
echo "下一步: 在 1Panel 安装表单中 IMAGE 填 ${IMAGE_TAG}, 部署后"
echo "        执行 bash infinity/scripts/verify.sh 验证服务。"
echo "========================================================"
