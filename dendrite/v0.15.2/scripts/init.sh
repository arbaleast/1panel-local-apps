#!/bin/sh
# Dendrite 首次启动初始化脚本（在 1Panel 宿主机上跑，bash 解释器）
#
# 调用时机: 1Panel 在 docker compose up -d 之前先调本脚本 (runScript "init")
#   (backend/app/service/app.go:477)
# 执行环境: 1Panel 宿主机（不是容器内！）。所以 /usr/bin/dendrite 找不到，
#   必须通过 docker run 临时跑 dendrite-monolith 镜像里的 generate-config /
#   generate-keys 来生成 matrix_key.pem / dendrite.yaml。
#
# 工作流程:
#   1. 从 1Panel 写的 .env 加载 formField 值（DB_TYPE / DB_HOST / ...）
#   2. 拼装 DATABASE_URL
#   3. 用 docker run + 挂载 ${DATA_PATH} 到 /etc/dendrite，调用镜像里的
#      generate-config / generate-keys 生成配置文件
#   4. sed 注入 registration_shared_secret
#   5. exit 0 → 1Panel 接着 upApp (docker compose up -d) 启动容器
#
# 容器内的事:
#   dendrite 容器起来时，/etc/dendrite 已经包含 matrix_key.pem + dendrite.yaml，
#   容器的 ENTRYPOINT ["/usr/bin/dendrite"] 会直接用这些文件启动。
#   容器内不需要任何 init 逻辑。

set -eu

# ---------- 0. 路径 / 环境变量解析 ----------
# 1Panel 在调用 init.sh 时 workdir 是 <install_path>，即
# /opt/1panel/apps/local/dendrite/dendrite/。我们从 .env 读 formField 值。
# 1Panel compose env 段会把 formField 渲染进容器；宿主机上能直接拿到
# 这些值的方式是读 compose 同目录的 .env。

WORKDIR="${INIT_WORKDIR:-$(pwd)}"
ENV_FILE=""
for candidate in \
    "${WORKDIR}/.env" \
    "/opt/1panel/apps/local/dendrite/dendrite/.env" \
    "/opt/1panel/apps/local/dendrite/.env" \
    "/.env"; do
    if [ -f "${candidate}" ]; then
        ENV_FILE="${candidate}"
        break
    fi
done

if [ -n "${ENV_FILE}" ]; then
    echo "[init.sh] Loading formField values from ${ENV_FILE}"
    set -a
    . "${ENV_FILE}"
    set +a
else
    echo "[init.sh] WARNING: no .env found at ${WORKDIR}, using shell env"
fi

# 兜底值
DB_TYPE="${DB_TYPE:-sqlite}"
DB_HOST="${DB_HOST:-}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-dendrite}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-}"
SERVER_NAME="${SERVER_NAME:-matrix.local}"
REGISTRATION_SHARED_SECRET="${REGISTRATION_SHARED_SECRET:-}"

# 解析 DATA_PATH (宿主机绝对路径)
DATA_PATH="${DATA_PATH:-./data}"
case "${DATA_PATH}" in
    /*) HOST_DATA_DIR="${DATA_PATH}" ;;
    *)  HOST_DATA_DIR="${WORKDIR}/${DATA_PATH#./}" ;;
esac

mkdir -p "${HOST_DATA_DIR}"
echo "[init.sh] Host data dir: ${HOST_DATA_DIR}"

# ---------- 1. 拼装 DATABASE_URL ----------
case "${DB_TYPE}" in
    sqlite)
        DATABASE_URL="file:${DB_NAME}.db"
        echo "[init.sh] DB type: SQLite (file:${DB_NAME}.db)"
        ;;
    postgres)
        ENCODED_USER=$(printf '%s' "${DB_USER}"     | sed 's|%|%25|g; s|@|%40|g; s|:|%3A|g; s|/|%2F|g; s|?|%3F|g; s|#|%23|g')
        ENCODED_PASS=$(printf '%s' "${DB_PASSWORD}" | sed 's|%|%25|g; s|@|%40|g; s|:|%3A|g; s|/|%2F|g; s|?|%3F|g; s|#|%23|g')
        DATABASE_URL="postgres://${ENCODED_USER}:${ENCODED_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=disable"
        echo "[init.sh] DB type: PostgreSQL (${DB_HOST}:${DB_PORT}/${DB_NAME})"
        ;;
    *)
        echo "[init.sh] ERROR: DB_TYPE must be 'sqlite' or 'postgres', got '${DB_TYPE}'" >&2
        exit 1
        ;;
esac

# ---------- 2. 镜像 / docker 可用性检查 ----------
if ! command -v docker >/dev/null 2>&1; then
    echo "[init.sh] FATAL: docker not found in PATH (init.sh must run on 1Panel host)" >&2
    exit 1
fi

DENDRITE_IMAGE="ghcr.io/element-hq/dendrite-monolith:v0.15.2"
# 拉镜像（如果本地没拉过）；pull 失败也不阻塞，可能用本地已有镜像
echo "[init.sh] Pulling image (if not cached): ${DENDRITE_IMAGE}"
if ! docker pull "${DENDRITE_IMAGE}" >/dev/null 2>&1; then
    echo "[init.sh] WARNING: docker pull failed, will try to use local image if present"
fi

# ---------- 3. 生成 matrix_key.pem（如不存在） ----------
KEY_FILE="${HOST_DATA_DIR}/matrix_key.pem"
if [ ! -f "${KEY_FILE}" ]; then
    echo "[init.sh] Generating matrix signing key (via docker run)..."
    docker run --rm \
        -v "${HOST_DATA_DIR}:/etc/dendrite" \
        "${DENDRITE_IMAGE}" \
        /usr/bin/generate-keys -private-key /etc/dendrite/matrix_key.pem
else
    echo "[init.sh] Reusing existing matrix signing key"
fi

# ---------- 4. 生成 dendrite.yaml（如不存在） ----------
CONFIG_FILE="${HOST_DATA_DIR}/dendrite.yaml"
if [ ! -f "${CONFIG_FILE}" ]; then
    echo "[init.sh] Generating dendrite.yaml (server=${SERVER_NAME})..."
    docker run --rm \
        -v "${HOST_DATA_DIR}:/etc/dendrite" \
        "${DENDRITE_IMAGE}" \
        /usr/bin/generate-config \
            -dir /etc/dendrite \
            -db "${DATABASE_URL}" \
            -server "${SERVER_NAME}" \
            > "${CONFIG_FILE}.tmp"
    mv "${CONFIG_FILE}.tmp" "${CONFIG_FILE}"

    # 注入注册策略
    TMP_CONF="${CONFIG_FILE}.tmp2"
    if [ -n "${REGISTRATION_SHARED_SECRET}" ]; then
        echo "[init.sh] Enabling token-based registration (shared secret is set)"
        sed \
            -e "s|^  registration_disabled: true$|  registration_disabled: false|" \
            -e "s|^  registration_shared_secret: \"\"$|  registration_shared_secret: \"${REGISTRATION_SHARED_SECRET}\"|" \
            "${CONFIG_FILE}" > "${TMP_CONF}"
    else
        echo "[init.sh] Keeping registration disabled (no shared secret)"
        sed \
            -e "s|^  registration_disabled: true$|  registration_disabled: true|" \
            "${CONFIG_FILE}" > "${TMP_CONF}"
    fi
    mv "${TMP_CONF}" "${CONFIG_FILE}"
    chmod 0644 "${CONFIG_FILE}"
else
    echo "[init.sh] Reusing existing dendrite.yaml"
fi

chmod 0644 "${KEY_FILE}" 2>/dev/null || true

echo "[init.sh] Init complete. 1Panel will now docker-compose up -d the dendrite container."
