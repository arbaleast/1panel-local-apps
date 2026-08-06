#!/usr/bin/env bash
# =============================================================================
# download_wheels.sh
#
# 用途: 一键下载 torch==2.6.0+cu124 与 torchvision==0.21.0+cu124 的
#       cp310 Linux x86_64 wheel 到本仓库 infinity/latest/wheels/ 目录,
#       供本地构建 infinity-pascal:cu124 镜像时使用 (构建上下文 = latest/)。
#
# 适用环境: Linux x86_64 (Pascal sm_61 / Ampere / Hopper 均可)
#           在 Windows / macOS 上运行会直接跳过并提示。
#
# 使用方式:
#   chmod +x scripts/infinity/download_wheels.sh
#   bash scripts/infinity/download_wheels.sh
#
# 注意:
#   - 本脚本不会硬编码任何凭据 / IP / 内网域名。
#   - wheel 文件名带时间戳后缀, 避免覆盖已有文件。
# =============================================================================

set -euo pipefail

# 仓库根目录 = 脚本所在目录的上一级 (scripts/infinity -> scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# 构建上下文为 infinity/latest/, wheels 目录放在 latest/wheels/ (对应 Dockerfile 的 COPY wheels/)
WHEELS_DIR="${REPO_ROOT}/latest/wheels"

# 目标 wheel 包信息 (cp310, Linux x86_64, cu124)
TORCH_VERSION="2.6.0%2Bcu124"     # URL 编码后的 + (PyTorch index 规则)
TORCHVISION_VERSION="0.21.0%2Bcu124"
PYTHON_TAG="cp310"
INDEX_URL="https://download.pytorch.org/whl/cu124"

# 时间戳后缀, 保证文件名唯一, 避免覆盖历史 wheel
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

echo "==> 检测运行环境..."

# 仅支持 Linux (bash 脚本本身的平台)
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "!! 检测到非 Linux 系统 ($(uname -s))。"
  echo "!! 本脚本仅适配 Linux x86_64 (Pascal/Ampere/Hopper GPU 主机)。"
  echo "!! Windows/macOS 请改用 WSL2、Docker 或远程 Linux 主机后重试。"
  exit 1
fi

# 校验 CPU 架构 (arm64 会被跳过)
ARCH="$(uname -m)"
if [[ "${ARCH}" != "x86_64" ]]; then
  echo "!! 当前 CPU 架构为 ${ARCH}, 仅支持 x86_64。"
  exit 1
fi

# 检查必备工具
for tool in curl python3 pip; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "!! 缺少必需工具: ${tool}。请先安装 (Ubuntu: apt install curl python3 python3-pip)。"
    exit 1
  fi
done

mkdir -p "${WHEELS_DIR}"

echo "==> 从 PyTorch 官方 index 查询可用 wheel 列表: ${INDEX_URL}"
echo "==> 目标版本: torch ${TORCH_VERSION}, torchvision ${TORCHVISION_VERSION}"

# 定义查询 + 下载函数:
# 参数 $1 = 包名 (torch/torchvision), $2 = 编码后版本号
download_wheel() {
  local pkg="$1"
  local ver="$2"
  local page

  echo "---- 处理 ${pkg}==${ver} ----"

  # 从 index 页面中筛选出 cp310 / linux_x86_64 的 wheel 文件名
  page="$(curl -fsSL "${INDEX_URL}/" || { echo "!! 无法访问 PyTorch index, 请检查网络或配置代理后重试。"; exit 1; })"

  # 规则: 文件名形如 torch-2.6.0+cu124-cp310-cp310-linux_x86_64.whl
  # 这里用 grep 提取完整 .whl 文件名
  local filename
  filename="$(echo "${page}" | grep -oE "${pkg}-${ver//%2B/+}-${PYTHON_TAG}-${PYTHON_TAG}-linux_x86_64\.whl" | head -n 1 || true)"

  if [[ -z "${filename}" ]]; then
    echo "!! 未在 index 中找到 ${pkg}==${ver} 的 cp310 linux_x86_64 wheel。"
    echo "!! 请检查版本号或网络 (可先配置 HTTPS_PROXY)。"
    exit 1
  fi

  # 目标文件名带时间戳, 避免覆盖旧文件
  local target="${WHEELS_DIR}/${filename%.whl}_${TIMESTAMP}.whl"

  echo "==> 下载 ${filename} -> ${target}"
  curl -fSL -o "${target}" "${INDEX_URL}/${filename}"
  echo "==> 已下载: ${target} ($(du -h "${target}" | cut -f1))"
}

# 依次下载 torch 与 torchvision
download_wheel "torch" "${TORCH_VERSION}"
download_wheel "torchvision" "${TORCHVISION_VERSION}"

echo ""
echo "========================================================"
echo "全部下载完成, 输出目录: ${WHEELS_DIR}"
ls -lh "${WHEELS_DIR}"/torch*cu124*.whl "${WHEELS_DIR}"/torchvision*cu124*.whl 2>/dev/null || true
echo ""
echo "下一步: 用 Git LFS 跟踪这些 wheel (见 docs/BUILD.md 策略 A), 再执行 build 脚本。"
echo "========================================================"
