#!/bin/sh
# cfnb 初始化脚本（在 1Panel 宿主机上跑，容器内没有可用的 shell 逻辑）
#
# 调用时机: 1Panel 在 docker compose up -d 之前先调本脚本 (runScript "init")
#   (backend/app/service/app.go:477)
# 执行环境: 1Panel 宿主机（不是容器内）。
#
# 为什么需要这个脚本:
#   baizw/cfnb 镜像里只有一个静态 Go 二进制 cfx, 没有 Web UI / CLI 参数 / 环境变量支持,
#   唯一配置入口是工作目录 (WORKDIR=/app) 下的 config.yaml。
#   而且该二进制用 viper + mapstructure 解码配置, 键名是 **Go 结构体字段名 (小写、无下划线)**,
#   不是它自己生成的那份默认 config.yaml 里的 snake_case 键名 —— 也就是说上游默认配置里的
#   top_n / api_token / zone_id / dns_record_name 等键其实读不进来。
#   所以这里按实测生效的键名生成 config.yaml, 交给容器读取。
#
# 工作流程:
#   1. 从 1Panel 写出的 .env 读取 formField 值 (UID/GID 先改名, bash 下 UID 是只读变量)
#   2. 建好宿主机数据目录, 并 chown 给容器内运行身份 (镜像无 USER 指令, 靠 compose user:)
#   3. 生成 ./data/config.yaml (原地覆写, 不用 mv, 避免 bind mount 的 inode 问题)
#   4. exit 0 -> 1Panel 接着 docker compose up -d

set -eu

# ---------- 0. 定位 1Panel 写的 .env ----------
WORKDIR="${INIT_WORKDIR:-$(pwd)}"
ENV_FILE=""
for candidate in \
    "${WORKDIR}/.env" \
    "/opt/1panel/apps/local/cfnb/cfnb/.env" \
    "/opt/1panel/apps/local/cfnb/.env" \
    "/.env"; do
    if [ -f "${candidate}" ]; then
        ENV_FILE="${candidate}"
        break
    fi
done

# ---------- 1. 数据目录 ----------
# 固定用 compose 同级的 ./data (compose 里挂的是 ./data:/app), 不读 DATA_PATH:
# 万一 .env 里带了别的 DATA_PATH, 配置就会写到容器挂载不到的地方。
HOST_DATA_DIR="${WORKDIR}/data"
mkdir -p "${HOST_DATA_DIR}/logs"

# ---------- 2. 读取 formField 值 ----------
# UID / GID 在 bash 下是只读变量, 直接 source .env 会报 "UID: readonly variable" 并中断,
# 所以先另存一份改名后的副本再 source。
if [ -n "${ENV_FILE}" ]; then
    echo "[init.sh] Loading formField values from ${ENV_FILE}"
    ENV_TMP="${WORKDIR}/.env.cfnb.tmp"
    sed -e 's/^UID=/CFNB_UID=/' -e 's/^GID=/CFNB_GID=/' "${ENV_FILE}" > "${ENV_TMP}"
    set -a
    . "${ENV_TMP}"
    set +a
    rm -f "${ENV_TMP}"
else
    echo "[init.sh] WARNING: no .env found at ${WORKDIR}, using shell env"
fi

CFNB_UID="${CFNB_UID:-99}"
CFNB_GID="${CFNB_GID:-100}"
SCHEDULE_ENABLED="${SCHEDULE_ENABLED:-true}"
SCHEDULE_INTERVAL="${SCHEDULE_INTERVAL:-1h}"
GLOBAL_MODE="${GLOBAL_MODE:-global}"
TOP_N="${TOP_N:-50}"
TCP_PROBES="${TCP_PROBES:-2}"
MIN_SUCCESS_RATE="${MIN_SUCCESS_RATE:-0.5}"
AVAILABILITY_ENABLED="${AVAILABILITY_ENABLED:-true}"
BANDWIDTH_SIZE_MB="${BANDWIDTH_SIZE_MB:-50}"
PORTS="${PORTS:-443}"
BLOCKED_COUNTRIES="${BLOCKED_COUNTRIES:-CN}"
ALLOWED_COUNTRIES="${ALLOWED_COUNTRIES:-}"
CF_ENABLED="${CF_ENABLED:-false}"
CF_API_TOKEN="${CF_API_TOKEN:-}"
CF_ZONE_ID="${CF_ZONE_ID:-}"
CF_DNS_RECORD_NAME="${CF_DNS_RECORD_NAME:-}"
CF_TTL="${CF_TTL:-60}"
CF_PROXIED="${CF_PROXIED:-false}"
HTTP_PATH="${HTTP_PATH:-/ips}"

case "${GLOBAL_MODE}" in
    country) GLOBAL_ENABLE="false" ;;
    *)       GLOBAL_ENABLE="true" ;;
esac

# 白名单非空才启用国家白名单过滤
if [ -n "$(printf '%s' "${ALLOWED_COUNTRIES}" | tr -d '[:space:]')" ]; then
    COUNTRIES_ENABLED="true"
else
    COUNTRIES_ENABLED="false"
fi

# ---------- 3. 列表转 YAML 数组 ----------
# $1 = 逗号分隔的原始值, $2 = num | str
yaml_list() {
    _kind="$2"
    _old_ifs="${IFS}"
    _out=""
    set -f
    IFS=','
    for _item in ${1}; do
        _item=$(printf '%s' "${_item}" | tr -d '[:space:]')
        [ -z "${_item}" ] && continue
        if [ "${_kind}" = "num" ]; then
            _val="${_item}"
        else
            _val=$(printf '%s' "${_item}" | tr '[:lower:]' '[:upper:]')
            _val="\"${_val}\""
        fi
        if [ -z "${_out}" ]; then
            _out="${_val}"
        else
            _out="${_out}, ${_val}"
        fi
    done
    set +f
    IFS="${_old_ifs}"
    if [ -z "${_out}" ]; then
        printf '[]'
    else
        printf '[%s]' "${_out}"
    fi
}

PORTS_LIST=$(yaml_list "${PORTS}" num)
BLOCKED_LIST=$(yaml_list "${BLOCKED_COUNTRIES}" str)
ALLOWED_LIST=$(yaml_list "${ALLOWED_COUNTRIES}" str)

# ---------- 4. 生成 config.yaml ----------
CONFIG_FILE="${HOST_DATA_DIR}/config.yaml"
echo "[init.sh] Writing ${CONFIG_FILE}"

# 注意: 原地覆写 (不用 mv), bind mount 的文件被替换会导致容器仍持有旧 inode
cat > "${CONFIG_FILE}" <<EOF
# 本文件由 1Panel init.sh 自动生成, 重新部署会被覆盖。
# 键名必须是 Go 字段名的小写无下划线形式 (viper + mapstructure 解码),
# 例如 topn / apitoken / zoneid —— 上游默认 config.yaml 里的 top_n / api_token 读不进来。
additionalsources:
    - url: https://zip.cm.edu.kg/all.txt
      enabled: true
    - url: https://countrymerge.pages.dev/all.txt
      enabled: true
    - url: https://wtf-359.pages.dev/wtf.txt
      enabled: true
global:
    enable: ${GLOBAL_ENABLE}
    topn: ${TOP_N}
    bandwidthcandidates: ${TOP_N}
    outputfile: ./ip.txt
filter:
    countriesenabled: ${COUNTRIES_ENABLED}
    allowedcountries: ${ALLOWED_LIST}
    blockedcountries: ${BLOCKED_LIST}
    ports: ${PORTS_LIST}
tcp:
    probes: ${TCP_PROBES}
    minsuccessrate: ${MIN_SUCCESS_RATE}
availability:
    enabled: ${AVAILABILITY_ENABLED}
bandwidth:
    sizemb: ${BANDWIDTH_SIZE_MB}
dns:
    enabled: ${CF_ENABLED}
cloudflare:
    enabled: ${CF_ENABLED}
    apitoken: "${CF_API_TOKEN}"
    zoneid: "${CF_ZONE_ID}"
    dnsrecordname: "${CF_DNS_RECORD_NAME}"
    ttl: ${CF_TTL}
    proxied: ${CF_PROXIED}
http:
    enabled: true
    port: 8080
    path: "${HTTP_PATH}"
logger:
    enabled: true
    logdir: ./logs
schedule:
    enabled: ${SCHEDULE_ENABLED}
    interval: ${SCHEDULE_INTERVAL}
EOF

chmod 0644 "${CONFIG_FILE}"

# ---------- 5. 运行身份 ----------
# 镜像没有 USER 指令, compose 用 user: "${UID}:${GID}" 指定身份,
# 数据目录必须属于同一 UID/GID, 否则容器写不出 ip.txt / 日志。
echo "[init.sh] chown ${HOST_DATA_DIR} -> ${CFNB_UID}:${CFNB_GID}"
chown -R "${CFNB_UID}:${CFNB_GID}" "${HOST_DATA_DIR}" 2>/dev/null \
    || echo "[init.sh] WARNING: chown failed, make sure ${HOST_DATA_DIR} is writable by ${CFNB_UID}:${CFNB_GID}"

echo "[init.sh] Init complete. 1Panel will now docker-compose up -d the cfnb container."
