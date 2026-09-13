#!/bin/sh
# Cinny 首次安装初始化脚本（在 1Panel 宿主机上跑）
#
# 调用时机: 1Panel 在 docker compose up -d 之前先调本脚本
#   (appspec: "Installation initialization, before container startup")
# 执行环境: 1Panel 宿主机（不是容器内！）。
#
# 工作流程:
#   1. 从 1Panel 写的 .env 加载 formField 值（DEFAULT_HOMESERVER / IMAGE / APP_VERSION）
#   2. 若 host 端 ./data/config.json 不存在：
#        a) 用 docker run 临时起 cinny 镜像（带 nginx 静态文件），
#           挂载 host ./data 到 /out，把镜像内 /app/config.json 拷到 /out/config.json
#        b) 用 jq 改写 default_hs 字段为用户填的 DEFAULT_HOMESERVER
#      若 host 端 ./data/config.json 已存在：保留用户历史编辑（不覆盖）
#   3. 兜底：若 jq 不可用则用 sed 替换（容错）
#   4. exit 0 → 1Panel 接着 docker compose up -d 启动 cinny 容器
#
# 容器内的事:
#   cinny 容器启动时，./data/config.json 已包含用户自定义的 default_hs。
#   compose 把 ./data/config.json bind mount 到容器内 /app/config.json:ro。
#   nginx 的 rewrite 规则把请求 /config.json 映射到 /app/config.json，
#   前端 fetch /config.json 即可读到用户配置。
#
# 升级行为:
#   1Panel 升级/参数更新时不重跑 init.sh（appspec.md 明示）。
#   如需修改默认 homeserver，编辑 host 端 ./data/config.json 后
#   在 1Panel UI 重启 cinny 容器即可（bind mount 自动生效）。

set -eu

# ---------- 0. 路径 / 环境变量解析 ----------
WORKDIR="${INIT_WORKDIR:-$(pwd)}"
ENV_FILE=""
for candidate in \
    "${WORKDIR}/.env" \
    "/opt/1panel/apps/local/cinny/cinny/.env" \
    "/opt/1panel/apps/local/cinny/.env" \
    "/.env"; do
    if [ -f "${candidate}" ]; then
        ENV_FILE="${candidate}"
        break
    fi
done

if [ -n "${ENV_FILE}" ]; then
    echo "[cinny-init] Loading formField values from ${ENV_FILE}"
    set -a
    . "${ENV_FILE}"
    set +a
else
    echo "[cinny-init] WARNING: no .env found at ${WORKDIR}, using shell env"
fi

# 兜底默认值
DEFAULT_HOMESERVER="${DEFAULT_HOMESERVER:-https://matrix.org}"
IMAGE="${IMAGE:-ghcr.io/cinnyapp/cinny}"
APP_VERSION="${APP_VERSION:-v4.12.6}"

# 解析 DATA_PATH（compose 里的 ./data；相对路径相对 WORKDIR）
DATA_PATH="${DATA_PATH:-./data}"
case "${DATA_PATH}" in
    /*) HOST_DATA_DIR="${DATA_PATH}" ;;
    *)  HOST_DATA_DIR="${WORKDIR}/${DATA_PATH#./}" ;;
esac
mkdir -p "${HOST_DATA_DIR}"
CONFIG_FILE="${HOST_DATA_DIR}/config.json"
echo "[cinny-init] Host data dir: ${HOST_DATA_DIR}"
echo "[cinny-init] DEFAULT_HOMESERVER: ${DEFAULT_HOMESERVER}"
echo "[cinny-init] Image: ${IMAGE}:${APP_VERSION}"

# ---------- 1. 镜像 / docker 可用性检查 ----------
if ! command -v docker >/dev/null 2>&1; then
    echo "[cinny-init] FATAL: docker not found in PATH (init.sh must run on 1Panel host)" >&2
    exit 1
fi

# ---------- 2. 提取默认 config.json（仅当 host 端不存在）----------
if [ -f "${CONFIG_FILE}" ]; then
    echo "[cinny-init] Reusing existing ${CONFIG_FILE} (preserves user edits)"
else
    echo "[cinny-init] Extracting default config.json from ${IMAGE}:${APP_VERSION}..."
    # 用同一镜像跑一个临时容器，把 /app/config.json 拷到 host /out
    # --entrypoint="" 覆盖镜像默认 nginx ENTRYPOINT；改用 sh 跑 cp
    # 注意：必须先把镜像拉下来（如果本地没有）；pull 失败也继续（用本地已有）
    if ! docker pull "${IMAGE}:${APP_VERSION}" >/dev/null 2>&1; then
        echo "[cinny-init] WARNING: docker pull failed, will try to use local image if present"
    fi
    docker run --rm --entrypoint "" \
        -v "${HOST_DATA_DIR}:/out" \
        "${IMAGE}:${APP_VERSION}" \
        sh -c 'cp -f /app/config.json /out/config.json && chmod 0644 /out/config.json'
    echo "[cinny-init] Wrote default config to ${CONFIG_FILE}"
fi

# ---------- 3. 用 jq 或 sed 注入用户 DEFAULT_HOMESERVER ----------
if command -v jq >/dev/null 2>&1; then
    echo "[cinny-init] Patching default_hs with jq"
    TMP_FILE="${CONFIG_FILE}.tmp"
    jq --arg hs "${DEFAULT_HOMESERVER}" '.default_hs = $hs' "${CONFIG_FILE}" > "${TMP_FILE}"
    mv "${TMP_FILE}" "${CONFIG_FILE}"
else
    # 兜底：sed 替换 default_hs 字符串值（jq 不可用时）
    # 用 # 作分隔符避免与 https:// 中的 / 冲突
    # 用 [ ] 匹配可能的空格/制表符（POSIX BRE 兼容，GNU/BSD sed 都支持）
    echo "[cinny-init] Patching default_hs with sed (jq not available)"
    TMP_FILE="${CONFIG_FILE}.tmp"
    if grep -q '"default_hs"' "${CONFIG_FILE}"; then
        sed -E 's#("default_hs"[ ]*:[ ]*)"[^"]*"#\1"'"${DEFAULT_HOMESERVER}"'"#' \
            "${CONFIG_FILE}" > "${TMP_FILE}"
    else
        # 上游某版本可能改字段名，尝试其他常见 key
        for key in defaultHs defaultHsUrl; do
            if grep -q "\"${key}\"" "${CONFIG_FILE}"; then
                sed -E "s#(\"${key}\"[ ]*:[ ]*)\"[^\"]*\"#\\1\"${DEFAULT_HOMESERVER}\"#" \
                    "${CONFIG_FILE}" > "${TMP_FILE}"
                break
            fi
        done
        if [ ! -f "${TMP_FILE}" ]; then
            echo "[cinny-init] WARNING: no default_hs/defaultHs key found, leaving config.json unchanged"
            exit 0
        fi
    fi
    mv "${TMP_FILE}" "${CONFIG_FILE}"
fi

chmod 0644 "${CONFIG_FILE}"
echo "[cinny-init] Init complete. cinny container will now start with custom default_hs."
