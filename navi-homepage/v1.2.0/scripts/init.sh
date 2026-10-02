#!/bin/sh
# Navi Homepage 首次安装初始化脚本（在 1Panel 宿主机上跑）
#
# 调用时机: 1Panel 在 docker compose up -d 之前先调本脚本
#   (appspec: "Installation initialization, before container startup")
# 执行环境: 1Panel 宿主机（不是容器内！）。
#
# 背景（来自上游 README）:
#   镜像内 /app/data/config.json 是空示例配置（config.example.json）。
#   ./data 整目录挂载到容器 /app/data 时，会**遮住**镜像内置示例。
#   若宿主机 ./data/config.json 不存在，容器启动后 Navi 会因为找不到
#   配置而退出（"Cannot find config file"）。
#   因此首次安装时必须从镜像里把示例配置复制到宿主机 ./data/。
#
# 工作流程:
#   1. 加载 1Panel 写的 .env（IMAGE / APP_VERSION / ...）
#   2. 创建 ./data 与 ./data/uploads 目录
#   3. 若 ./data/config.json 不存在：
#        docker pull <IMAGE>:<APP_VERSION>
#        docker run --rm 临时容器，把 /app/public/config.example.json
#        拷贝到 host ./data/config.json
#   4. 若已存在：保留用户历史编辑（不覆盖）
#
# 升级行为:
#   1Panel 升级/参数更新时不重跑 init.sh（appspec.md 明示）。
#   若上游 schema 变化需手动覆盖配置：删除 ./data/config.json 后
#   重新触发「安装」即可（用户编辑过的卡片会随 ./data/uploads 一并丢失，
#   **操作前请用 Navi 后台「备份」下载含图片的 zip**）。

set -eu

# ---------- 0. 路径 / 环境变量解析 ----------
WORKDIR="${INIT_WORKDIR:-$(pwd)}"
ENV_FILE=""
for candidate in \
    "${WORKDIR}/.env" \
    "/opt/1panel/apps/local/navi-homepage/navi-homepage/.env" \
    "/opt/1panel/apps/local/navi-homepage/.env" \
    "/.env"; do
    if [ -f "${candidate}" ]; then
        ENV_FILE="${candidate}"
        break
    fi
done

if [ -n "${ENV_FILE}" ]; then
    echo "[navi-init] Loading formField values from ${ENV_FILE}"
    set -a
    . "${ENV_FILE}"
    set +a
else
    echo "[navi-init] WARNING: no .env found at ${WORKDIR}, using shell env"
fi

# 兜底默认值
IMAGE="${IMAGE:-ghcr.io/damisunshine/navi-homepage}"
APP_VERSION="${APP_VERSION:-v1.2.0}"

# 解析 DATA_PATH（compose 里的 ./data；相对路径相对 WORKDIR）
DATA_PATH="${DATA_PATH:-./data}"
case "${DATA_PATH}" in
    /*) HOST_DATA_DIR="${DATA_PATH}" ;;
    *)  HOST_DATA_DIR="${WORKDIR}/${DATA_PATH#./}" ;;
esac

mkdir -p "${HOST_DATA_DIR}"
mkdir -p "${HOST_DATA_DIR}/uploads"
CONFIG_FILE="${HOST_DATA_DIR}/config.json"
echo "[navi-init] Host data dir: ${HOST_DATA_DIR}"
echo "[navi-init] Image: ${IMAGE}:${APP_VERSION}"

# ---------- 1. docker 可用性检查 ----------
if ! command -v docker >/dev/null 2>&1; then
    echo "[navi-init] FATAL: docker not found in PATH (init.sh must run on 1Panel host)" >&2
    exit 1
fi

# ---------- 2. 提取默认 config.json（仅当 host 端不存在）----------
if [ -f "${CONFIG_FILE}" ]; then
    echo "[navi-init] Reusing existing ${CONFIG_FILE} (preserves user edits)"
else
    echo "[navi-init] Extracting default config.json from ${IMAGE}:${APP_VERSION}..."
    if ! docker pull "${IMAGE}:${APP_VERSION}" >/dev/null 2>&1; then
        echo "[navi-init] WARNING: docker pull failed, will try to use local image if present"
    fi
    # 上游镜像里 /app/public/config.example.json 是示例配置。
    # 注意：./data 是空目录，**不会**遮住 /app/public/，所以可以直接拷。
    docker run --rm --entrypoint "" \
        -v "${HOST_DATA_DIR}:/out" \
        "${IMAGE}:${APP_VERSION}" \
        sh -c 'cp -f /app/public/config.example.json /out/config.json && chmod 0644 /out/config.json'
    echo "[navi-init] Wrote default config to ${CONFIG_FILE}"
fi

# ---------- 3. 写一个空 uploads/.gitkeep 防止空目录被 git 清掉 ----------
touch "${HOST_DATA_DIR}/uploads/.gitkeep"

# 兜底：确保 config.json 可写（root 创建的文件对非 root 1Panel 用户需放宽）
chmod 0644 "${CONFIG_FILE}" 2>/dev/null || true

echo "[navi-init] Init complete. navi-homepage container will now start with example config."
echo "[navi-init] IMPORTANT: visit http://<host>:<port> to set your access password and start adding cards."
