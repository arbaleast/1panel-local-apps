#!/bin/sh
# LinguaFlow 初始化脚本（在 1Panel 宿主机上跑，容器启动之前）
#
# 调用时机：1Panel 在 `docker compose up -d` 之前先调本脚本
#   （1Panel v1: backend/app/service/app.go → runScript(appInstall, "init")），
#   工作目录是应用安装目录（= 1Panel 写 .env 的目录 = compose 所在目录）。
#
# 为什么必须有这个脚本：
#   1) 官方镜像默认跑的是**服务器模式**（linguaflow serve），启动前必须提供三项输入，
#      缺一即拒绝启动：
#        - JWT 签名密钥（≥32 字节）              -> LINGUAFLOW_JWT_SECRET
#        - 凭据加密密钥（32 字节随机值的 Base64）  -> LINGUAFLOW_CREDENTIALS_MASTER_KEY
#        - 初始管理员用户名 / 密码                 -> LINGUAFLOW_BOOTSTRAP_ADMIN_*
#      前两项必须**长期稳定**：换掉凭据加密密钥 = 数据库里已保存的 AI 密钥全部无法解密。
#      所以它们只生成一次并保存在 ./data/secrets/（与 SQLite 库同处一个持久化目录，
#      版本升级时随数据目录一起保留）。
#   2) 官方镜像内置非 root 用户（appuser），本应用用 compose `user: "${UID}:${GID}"`
#      指定运行身份，宿主机 ./data 必须属于同一 UID/GID，否则容器写不进 SQLite。
#
# 本脚本做的事：
#   1) 建 ./data 与 ./data/secrets
#   2) 首次部署生成两份密钥（**已存在则绝不覆盖**，保证重启/重装后密钥不变）
#   3) 把安装参数里的初始管理员密码写进 ./data/secrets/bootstrap-admin-password
#   4) 把 ./data（含密钥文件）chown 给 UID/GID
#
# 幂等：重复部署 / 重跑本脚本都不会换密钥（已存在的密钥文件只会被原样保留）。

set -eu

# ---------- 0. 定位 1Panel 写出的 .env ----------
WORKDIR="${INIT_WORKDIR:-$(pwd)}"
ENV_FILE=""
for candidate in \
    "${WORKDIR}/.env" \
    "/opt/1panel/apps/local/linguaflow/linguaflow/.env" \
    "/opt/1panel/apps/local/linguaflow/.env" \
    "/.env"; do
    if [ -f "${candidate}" ]; then
        ENV_FILE="${candidate}"
        break
    fi
done

# 从 .env 里取某个键的原始值。
# 不用 `source` 的原因：1Panel 把字符串值写成 KEY="value"，shell 双引号里的 $ 与 `
# 会被展开（密码里出现 $ 会被吃掉），所以这里按行取原文再剥掉两端引号，不做求值。
read_env() {
    if [ -z "${ENV_FILE}" ]; then
        printf '%s' ""
        return 0
    fi
    _lf_value=$(sed -n "s/^$1=//p" "${ENV_FILE}" | head -n 1)
    case "${_lf_value}" in
        \"*\") _lf_value=${_lf_value#\"} ;;
        \'*\') _lf_value=${_lf_value#\'} ;;
    esac
    case "${_lf_value}" in
        *\") _lf_value=${_lf_value%\"} ;;
        *\') _lf_value=${_lf_value%\'} ;;
    esac
    printf '%s' "${_lf_value}"
}

if [ -n "${ENV_FILE}" ]; then
    echo "[linguaflow-init] Loading formField values from ${ENV_FILE}"
else
    echo "[linguaflow-init] WARNING: no .env found at ${WORKDIR}, using defaults"
fi

LF_UID=$(read_env UID)
LF_GID=$(read_env GID)
LF_UID="${LF_UID:-99}"
LF_GID="${LF_GID:-100}"
LF_ADMIN_PASSWORD=$(read_env LINGUAFLOW_BOOTSTRAP_ADMIN_PASSWORD)

# ---------- 1. 数据目录 ----------
# 固定用 compose 同级的 ./data（compose 里挂的是 ./data:/app/data）
HOST_DATA_DIR="${WORKDIR}/data"
SECRET_DIR="${HOST_DATA_DIR}/secrets"
mkdir -p "${SECRET_DIR}"
echo "[linguaflow-init] Host data dir: ${HOST_DATA_DIR}"

# ---------- 2. 随机密钥 ----------
# 32 字节随机值 → 64 位十六进制字符串（JWT 签名密钥要求 ≥32 字节）
gen_hex_secret() {
    head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n'
}

# 32 字节随机值 → Base64（凭据加密主密钥要求 32 字节随机值的 Base64）
gen_base64_secret() {
    head -c 32 /dev/urandom | base64 | tr -d '\n'
}

# 写密钥文件：不含结尾换行（上游只剥离至多一个结尾换行符，其余空白原样保留）
write_secret_file() {
    printf '%s' "$2" > "$1"
    chmod 0400 "$1"
}

JWT_FILE="${SECRET_DIR}/jwt-secret"
MASTER_KEY_FILE="${SECRET_DIR}/credentials-master-key"
ADMIN_PASSWORD_FILE="${SECRET_DIR}/bootstrap-admin-password"

if [ -s "${JWT_FILE}" ]; then
    echo "[linguaflow-init] Reusing existing JWT secret (${JWT_FILE})"
else
    write_secret_file "${JWT_FILE}" "$(gen_hex_secret)"
    echo "[linguaflow-init] Generated JWT secret (32 random bytes -> hex) -> ${JWT_FILE}"
fi

if [ -s "${MASTER_KEY_FILE}" ]; then
    echo "[linguaflow-init] Reusing existing credentials master key (${MASTER_KEY_FILE})"
else
    write_secret_file "${MASTER_KEY_FILE}" "$(gen_base64_secret)"
    echo "[linguaflow-init] Generated credentials master key (32 random bytes -> base64) -> ${MASTER_KEY_FILE}"
fi

# 初始管理员密码：安装参数里填了就以参数为准（首次初始化前可随时改），
# 没填但文件已存在就沿用旧值；两者都没有则无法完成首次初始化，直接报错。
if [ -n "${LF_ADMIN_PASSWORD}" ]; then
    write_secret_file "${ADMIN_PASSWORD_FILE}" "${LF_ADMIN_PASSWORD}"
    echo "[linguaflow-init] Wrote bootstrap admin password -> ${ADMIN_PASSWORD_FILE}"
elif [ -s "${ADMIN_PASSWORD_FILE}" ]; then
    echo "[linguaflow-init] Reusing existing bootstrap admin password (${ADMIN_PASSWORD_FILE})"
else
    echo "[linguaflow-init] FATAL: LINGUAFLOW_BOOTSTRAP_ADMIN_PASSWORD is empty." >&2
    echo "[linguaflow-init]   服务器模式首次启动必须有一个初始管理员密码，" >&2
    echo "[linguaflow-init]   请在 1Panel 部署参数页的「管理员密码」里填写后重新部署。" >&2
    exit 1
fi

# ---------- 3. 运行身份 ----------
# compose 用 user: "${UID}:${GID}" 指定容器内进程身份，
# 数据目录必须属于同一 UID/GID，否则容器写不出 SQLite 数据库。
chmod 0700 "${SECRET_DIR}" 2>/dev/null || true
echo "[linguaflow-init] chown ${HOST_DATA_DIR} -> ${LF_UID}:${LF_GID}"
if ! chown -R "${LF_UID}:${LF_GID}" "${HOST_DATA_DIR}" 2>/dev/null; then
    echo "[linguaflow-init] WARNING: chown failed. Make sure ${HOST_DATA_DIR} is writable by ${LF_UID}:${LF_GID}" >&2
    echo "[linguaflow-init]   手动执行: chown -R ${LF_UID}:${LF_GID} ${HOST_DATA_DIR}" >&2
fi

echo "[linguaflow-init] Init complete. The linguaflow container will now start."
echo "[linguaflow-init] IMPORTANT: 首次启动会自动用「管理员用户名 / 管理员密码」建管理员账号。"
