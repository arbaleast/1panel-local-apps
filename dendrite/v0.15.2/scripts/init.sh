#!/bin/sh
# Dendrite 首次启动初始化脚本
# 1. 显式从 1Panel 写的 .env 加载 formField 值（防止 1Panel 偶发不通过 environment 注入）
# 2. 拼装 DATABASE_URL（基于 DB_TYPE / DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD）
# 3. 生成 matrix_key.pem（如果不存在）
# 4. 生成 dendrite.yaml（如果不存在）
# 5. 注入注册相关配置（registration_shared_secret / registration_disabled）
# 6. exec /usr/bin/dendrite
#
# 注意：
# - 镜像 WORKDIR=/etc/dendrite，由 DATA_PATH bind-mount 提供
# - 已存在的 matrix_key.pem / dendrite.yaml 不会被覆盖（升级 / 重启安全）
# - 用户后续手动修改 dendrite.yaml 后再次启动也会被保留（我们只在文件首次生成时改）
# - 1Panel 把 formField 写到 /etc/dendrite/../.env（compose 同目录的 .env）。
#   我们在 init.sh 里 set -a 后 source 那个 .env，避免依赖 docker-compose 的 env-file
#   自动注入（避免 1Panel 偶发不注入 env 段导致 DB_TYPE 走兜底）。
# - 不开 `set -e`：希望即使 generate-config 失败 exec 仍然启动，容器不会无限重启

CONFIG_DIR=/etc/dendrite
KEY_FILE="${CONFIG_DIR}/matrix_key.pem"
CONFIG_FILE="${CONFIG_DIR}/dendrite.yaml"

# ---------- 0. 显式从 1Panel .env 加载 formField 值 ----------
# 1Panel docker-compose 启动时会自动加载 compose 同目录 .env；但我们 init.sh 不知道
# 自己的 workdir 在哪（被 /bin/sh /usr/local/bin/init.sh 直接调用，没有 cd）。
# 1Panel 的应用目录约定是 /opt/1panel/apps/local/<app>/<app>/。容器的 CWD 通常就是那里。
# 我们按优先级搜 .env：当前 CWD → /opt/1panel/apps/local/dendrite/dendrite/.env
# → /opt/1panel/apps/local/dendrite/.env
ENV_FILE=""
for candidate in \
    "./.env" \
    "/opt/1panel/apps/local/dendrite/dendrite/.env" \
    "/opt/1panel/apps/local/dendrite/.env" \
    "${CONFIG_DIR}/../.env" \
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
    echo "[init.sh] WARNING: no .env found, falling back to env-only (may be wrong)"
fi

# ---------- 1. formField 兜底值（仅在 .env 和环境变量都没设时使用） ----------
DB_TYPE="${DB_TYPE:-sqlite}"
DB_HOST="${DB_HOST:-}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-dendrite}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-}"
SERVER_NAME="${SERVER_NAME:-matrix.local}"
REGISTRATION_SHARED_SECRET="${REGISTRATION_SHARED_SECRET:-}"

echo "[init.sh] Effective config: DB_TYPE=${DB_TYPE} DB_HOST=${DB_HOST} DB_PORT=${DB_PORT} DB_NAME=${DB_NAME} DB_USER=${DB_USER} SERVER_NAME=${SERVER_NAME}"

# ---------- 2. 关键 binary 前置检查 ----------
# 镜像里这些 binary 必须在；找不到时立刻打印路径+挂载状态，方便排错
for binary in /usr/bin/dendrite /usr/bin/generate-config /usr/bin/generate-keys; do
    if [ ! -x "${binary}" ]; then
        echo "[init.sh] FATAL: ${binary} missing or not executable" >&2
        echo "[init.sh] /usr/bin/ contents:" >&2
        ls -la /usr/bin/ >&2 2>/dev/null || echo "[init.sh] (ls failed)" >&2
        echo "[init.sh] /usr/local/bin/ contents:" >&2
        ls -la /usr/local/bin/ >&2 2>/dev/null || echo "[init.sh] (ls /usr/local/bin/ failed)" >&2
        echo "[init.sh] PATH=${PATH}" >&2
        echo "[init.sh] PWD=${PWD}" >&2
        echo "[init.sh] 镜像应该用 ghcr.io/element-hq/dendrite-monolith:v0.15.2 (已 GHCR 验证 binary 在)" >&2
        echo "[init.sh] 如果 /usr/bin/ 是空的, 说明 compose 用了错的 image。卸载 dendrite → 重装" >&2
        exit 1
    fi
done

# ---------- 3. 拼装 DATABASE_URL ----------
# 拆分字段的目的：避开 1Panel formField `paramCommon` 规则对单字段的
# ^[a-zA-Z0-9._-]{2,64}$ 限制（连接串含 : / @ / ? 字符会被前端拦）。
# 这里把 6 个分字段在容器内拼成上游需要的 DSN。
case "${DB_TYPE}" in
    sqlite)
        DATABASE_URL="file:${CONFIG_DIR}/dendrite.db"
        echo "[init.sh] DB type: SQLite (file:./dendrite.db)"
        ;;
    postgres)
        # encode user / password（避免密码含 @ / : / ? 等 URL 保留字符导致解析失败）
        # 1Panel 自动生成的密码通常是 base64-like 安全字符，但 url_encode 一下不亏
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

# ---------- 4. 签名密钥 ----------
if [ ! -f "${KEY_FILE}" ]; then
    echo "[init.sh] Generating matrix signing key..."
    /usr/bin/generate-keys -private-key "${KEY_FILE}"
else
    echo "[init.sh] Reusing existing matrix signing key"
fi

# ---------- 5. 配置文件 ----------
if [ ! -f "${CONFIG_FILE}" ]; then
    echo "[init.sh] Generating dendrite.yaml (server=${SERVER_NAME})..."
    /usr/bin/generate-config \
        -dir "${CONFIG_DIR}" \
        -db "${DATABASE_URL}" \
        -server "${SERVER_NAME}" \
        > "${CONFIG_FILE}.tmp"
    mv "${CONFIG_FILE}.tmp" "${CONFIG_FILE}"

    # 注入注册策略：填了共享密钥 → 启用 token 注册；未填 → 默认完全禁止
    TMP_CONF="${CONFIG_FILE}.tmp2"
    if [ -n "${REGISTRATION_SHARED_SECRET:-}" ]; then
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
else
    echo "[init.sh] Reusing existing dendrite.yaml"
fi

# ---------- 6. 启动 ----------
echo "[init.sh] Starting dendrite..."
exec /usr/bin/dendrite "$@"
