#!/bin/sh
# opencloud 初始化脚本（在 1Panel 宿主机上跑，容器内没有可用的 shell 逻辑）
#
# 调用时机: 1Panel 在 docker compose up -d 之前先调本脚本 (runScript "init")
#   (backend/app/service/app.go:477)
# 执行环境: 1Panel 宿主机（不是容器内）。
#
# 为什么需要这个脚本:
#   opencloudeu/opencloud-rolling 镜像内置 `USER 1000` (opencloud-user),
#   并且没有 PUID/PGID 降权机制, 所以运行身份由 compose 的 user: "${UID}:${GID}" 指定。
#   而 1Panel 创建出来的宿主机目录默认属主是 root:root, 容器内的 uid 1000 无权写入 ->
#   `opencloud init` 写不进 opencloud.yaml, 容器启动即失败 (permission denied)。
#   所以这里先把目录建好, 再 chown 给容器内运行身份。
#
# 工作流程:
#   1. 定位 1Panel 写出的 .env
#   2. 读取 UID / GID（bash 下 UID 是只读变量, 需改名后 source）
#   3. 建好 ./data/config 与 ./data/data (含 web/assets/apps) 目录
#   4. chown 给 UID:GID
#   5. exit 0 -> 1Panel 接着 docker compose up -d

set -eu

# ---------- 0. 定位 1Panel 写的 .env ----------
WORKDIR="${INIT_WORKDIR:-$(pwd)}"
ENV_FILE=""
for candidate in \
    "${WORKDIR}/.env" \
    "/opt/1panel/apps/local/opencloud/opencloud/.env" \
    "/opt/1panel/apps/local/opencloud/.env" \
    "/.env"; do
    if [ -f "${candidate}" ]; then
        ENV_FILE="${candidate}"
        break
    fi
done

# ---------- 1. 读取 formField 值 ----------
# UID / GID 在 bash 下是只读变量, 直接 source .env 会报 "UID: readonly variable" 并中断,
# 所以先另存一份改名后的副本再 source。
if [ -n "${ENV_FILE}" ]; then
    echo "[init.sh] Loading formField values from ${ENV_FILE}"
    ENV_TMP="${WORKDIR}/.env.opencloud.tmp"
    sed -e 's/^UID=/RUN_UID=/' -e 's/^GID=/RUN_GID=/' "${ENV_FILE}" > "${ENV_TMP}"
    set -a
    . "${ENV_TMP}"
    set +a
    rm -f "${ENV_TMP}"
else
    echo "[init.sh] WARNING: no .env found at ${WORKDIR}, using default UID/GID"
fi

# 与镜像内置用户 opencloud-user (1000:1000) 保持一致
RUN_UID="${RUN_UID:-1000}"
RUN_GID="${RUN_GID:-1000}"

# ---------- 2. 数据目录 ----------
# 固定用 compose 同级的 ./data (compose 里挂的是 ./data/config 与 ./data/data),
# 不读 .env 里可能存在的 DATA_PATH, 否则配置会写到容器挂载不到的地方。
HOST_DATA_DIR="${WORKDIR}/data"
mkdir -p "${HOST_DATA_DIR}/config"
# /var/lib/opencloud/web/assets/apps 是 Web 扩展 (apps) 的落盘目录, 镜像里已预建,
# 这里一并建好, 避免容器内首次启动没有该目录。
mkdir -p "${HOST_DATA_DIR}/data/web/assets/apps"

# ---------- 3. 运行身份 ----------
# 镜像没有 USER 切换能力, compose 用 user: "${UID}:${GID}" 指定身份,
# 数据目录必须属于同一 UID/GID, 否则容器写不出 opencloud.yaml / 用户文件。
echo "[init.sh] chown ${HOST_DATA_DIR} -> ${RUN_UID}:${RUN_GID}"
chown -R "${RUN_UID}:${RUN_GID}" "${HOST_DATA_DIR}" 2>/dev/null \
    || echo "[init.sh] WARNING: chown failed, make sure ${HOST_DATA_DIR} is writable by ${RUN_UID}:${RUN_GID}"

echo "[init.sh] Init complete. 1Panel will now docker-compose up -d the opencloud container."
