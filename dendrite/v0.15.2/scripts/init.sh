#!/bin/sh
# Dendrite 首次启动初始化脚本
# 1. 生成 matrix_key.pem（如果不存在）
# 2. 生成 dendrite.yaml（如果不存在）
# 3. 注入注册相关配置（registration_shared_secret / registration_disabled）
# 4. exec /usr/bin/dendrite
#
# 注意：
# - 镜像 WORKDIR=/etc/dendrite，由 DATA_PATH bind-mount 提供
# - 已存在的 matrix_key.pem / dendrite.yaml 不会被覆盖（升级 / 重启安全）
# - 用户后续手动修改 dendrite.yaml 后再次启动也会被保留（我们只在文件首次生成时改）

set -eu

CONFIG_DIR=/etc/dendrite
KEY_FILE="${CONFIG_DIR}/matrix_key.pem"
CONFIG_FILE="${CONFIG_DIR}/dendrite.yaml"

# ---------- 1. 签名密钥 ----------
if [ ! -f "${KEY_FILE}" ]; then
    echo "[init.sh] Generating matrix signing key..."
    /usr/bin/generate-keys -private-key "${KEY_FILE}"
else
    echo "[init.sh] Reusing existing matrix signing key"
fi

# ---------- 2. 配置文件 ----------
if [ ! -f "${CONFIG_FILE}" ]; then
    echo "[init.sh] Generating dendrite.yaml (server=${SERVER_NAME}, db=${DATABASE_URL})..."
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

# ---------- 3. 启动 ----------
echo "[init.sh] Starting dendrite..."
exec /usr/bin/dendrite "$@"
