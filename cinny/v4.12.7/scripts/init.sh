#!/bin/sh
# Cinny 首次安装初始化脚本（在 1Panel 宿主机上跑）
#
# 调用时机: 1Panel 在 docker compose up -d 之前先调本脚本
#   (appspec: "Installation initialization, before container startup")
# 执行环境: 1Panel 宿主机（不是容器内！）。
#
# Cinny config.json 真实结构（v4.12.6 实测）:
#   {
#     "defaultHomeserver": 1,                                  // homeserverList 数组下标
#     "homeserverList": ["converser.eu", "matrix.org", ...],   // 域名数组（不含 https://）
#     "allowCustomHomeservers": true,
#     ...
#   }
# 因此「默认 homeserver」实际是：把用户填的域名追加到 homeserverList 开头，
# 并把 defaultHomeserver 改为 0（指向新加的那一项）。
#
# 工作流程:
#   1. 从 1Panel 写的 .env 加载 formField 值（DEFAULT_HOMESERVER / IMAGE / APP_VERSION）
#   2. 若 host 端 ./data/config.json 不存在：
#        docker run 临时 cinny 镜像，把镜像内 /app/config.json 拷到 host ./data/config.json
#      若 host 端已存在：保留用户历史编辑（不覆盖）
#   3. 用 jq (优先) 或 sed/awk (兜底)：
#        a) 把 DEFAULT_HOMESERVER 域名添加到 homeserverList 数组开头
#           （若已存在则不重复添加，先移除旧位置）
#        b) 把 defaultHomeserver 改为 0
#   4. exit 0 → 1Panel 接着 docker compose up -d 启动 cinny 容器
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
DEFAULT_HOMESERVER="${DEFAULT_HOMESERVER:-matrix.org}"
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

# 兜底：去掉可能的 https:// 前缀
DEFAULT_HOMESERVER_CLEAN=$(printf '%s' "${DEFAULT_HOMESERVER}" | sed -E 's#^https?://##; s#/$##')
echo "[cinny-init] DEFAULT_HOMESERVER (cleaned): ${DEFAULT_HOMESERVER_CLEAN}"

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
    if ! docker pull "${IMAGE}:${APP_VERSION}" >/dev/null 2>&1; then
        echo "[cinny-init] WARNING: docker pull failed, will try to use local image if present"
    fi
    docker run --rm --entrypoint "" \
        -v "${HOST_DATA_DIR}:/out" \
        "${IMAGE}:${APP_VERSION}" \
        sh -c 'cp -f /app/config.json /out/config.json && chmod 0644 /out/config.json'
    echo "[cinny-init] Wrote default config to ${CONFIG_FILE}"
fi

# ---------- 3. 注入用户 DEFAULT_HOMESERVER 到 homeserverList ----------
if command -v jq >/dev/null 2>&1; then
    echo "[cinny-init] Patching homeserverList with jq"
    TMP_FILE="${CONFIG_FILE}.tmp"
    jq --arg hs "${DEFAULT_HOMESERVER_CLEAN}" '
        # 把 defaultHs 移到 0；先从数组移除（若有）再 unshift
        .homeserverList = ([$hs] + (.homeserverList | map(select(. != $hs))))
        | .defaultHomeserver = 0
    ' "${CONFIG_FILE}" > "${TMP_FILE}"
    mv "${TMP_FILE}" "${CONFIG_FILE}"
else
    # 兜底: sed 处理 (jq 不可用时)
    # Cinny 镜像默认 config.json 用单行 inline 数组形式:
    #   "homeserverList": ["converser.eu", "matrix.org", ...]
    # 但也兼容多行形式:
    #   "homeserverList": [
    #     "converser.eu",
    #     ...
    #   ]
    # GNU sed 走 ERE, 支持 [[:space:]] POSIX 字符类
    echo "[cinny-init] Patching homeserverList with sed (jq not available)"
    TMP_FILE="${CONFIG_FILE}.tmp"

    # 步骤 1: 移除 homeserverList 中可能已存在的同域名（避免重复）
    # 同时处理两种数组形式:
    #   单行: "hs", "hs2", "hs3"  → 移除 "hs", 或 ", "hs"  (后者不干净, 走第二种)
    #   多行: \n    "hs",\n
    # 简化: 先尝试多行 (独立一行), 再尝试单行 inline (用 "hs" 周围 context)
    # 用 sed 把 "hs",? 替换为空; 同时清理可能残留的 ", ,"
    sed -E "/^\s*\"${DEFAULT_HOMESERVER_CLEAN}\",?\s*\$/d; s#(\"${DEFAULT_HOMESERVER_CLEAN}\",\s*)##g; s#(,\s*\"${DEFAULT_HOMESERVER_CLEAN}\")##g" \
        "${CONFIG_FILE}" > "${TMP_FILE}"

    # 步骤 2: 在 homeserverList 第一个条目之前插入新域名
    # 用 2 个 capture group: \1 = "homeserverList": [   \2 = "converser.eu" (原 first entry)
    # 优先尝试单行形式: "homeserverList": ["converser.eu", ...]
    if sed -E 's#("homeserverList"\s*:\s*\[\s*)"([^"]+)"#\1"'"${DEFAULT_HOMESERVER_CLEAN}"'", "\2"#' "${TMP_FILE}" > "${TMP_FILE}.2" \
            && grep -q "\"${DEFAULT_HOMESERVER_CLEAN}\"" "${TMP_FILE}.2"; then
        # 单行形式命中
        mv "${TMP_FILE}.2" "${TMP_FILE}"
    else
        # 多行形式: "homeserverList": [\n  "converser.eu",
        # 严格匹配 [ 后紧邻行尾（不吞 \n），避免 replacement 与原内容重复
        sed -E 's#("homeserverList"\s*:\s*\[)$#\1\n    "'"${DEFAULT_HOMESERVER_CLEAN}"'",#' \
            "${TMP_FILE}" > "${TMP_FILE}.2"
        mv "${TMP_FILE}.2" "${TMP_FILE}"
    fi

    # 步骤 3: 把 defaultHomeserver 改为 0
    sed -E 's#("defaultHomeserver"[[:space:]]*:[[:space:]]*)[0-9]+#\10#' \
        "${TMP_FILE}" > "${TMP_FILE}.2"
    mv "${TMP_FILE}.2" "${CONFIG_FILE}"
    rm -f "${TMP_FILE}"
fi

chmod 0644 "${CONFIG_FILE}"
echo "[cinny-init] Final homeserverList:"
if command -v jq >/dev/null 2>&1; then
    jq '.homeserverList' "${CONFIG_FILE}"
    echo "[cinny-init] Final defaultHomeserver: $(jq '.defaultHomeserver' "${CONFIG_FILE}")"
else
    grep -A20 "homeserverList" "${CONFIG_FILE}" | head -15
fi
echo "[cinny-init] Init complete. cinny container will now start with custom default homeserver."
