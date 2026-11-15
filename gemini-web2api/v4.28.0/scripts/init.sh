#!/bin/sh
# gemini-web2api 初始化脚本（在 1Panel 宿主机上跑，容器启动之前）
#
# 调用时机：1Panel 在 `docker compose up -d` 之前先调本脚本
#   （同仓库 linguaflow / navi-homepage 同款机制），工作目录 = 应用安装目录。
#
# 为什么需要它：
#   上游镜像是 distroless static + `USER nonroot`，容器内进程 uid/gid = 65532，
#   镜像内 /data 就属 65532。但 1Panel 用 bind mount 挂 ./data 时，宿主机目录是
#   root 创建/拥有的，属主不对 → SQLite 启动报 `unable to open database file (14)`。
#   本脚本只做一件事：把 ./data 建好并 chown 到容器运行身份。
#
# 幂等：目录已存在时只补 chown，不删数据。

set -eu

WORKDIR="${INIT_WORKDIR:-$(pwd)}"
DATA_DIR="${WORKDIR}/data"
# 与镜像 Dockerfile 的 chown 65532:65532 保持一致
RUN_UID="${GEMINI_WEB2API_UID:-65532}"
RUN_GID="${GEMINI_WEB2API_GID:-65532}"

mkdir -p "${DATA_DIR}"

if [ "$(id -u)" = "0" ]; then
    chown -R "${RUN_UID}:${RUN_GID}" "${DATA_DIR}"
else
    echo "[gemini-web2api-init] WARN: 当前不是 root，跳过 chown；请手工执行 chown -R ${RUN_UID}:${RUN_GID} ${DATA_DIR}" >&2
fi

# 空目录在 git 里靠 .gitkeep 占位；运行时不需要它，但被 init 重建出来也无害
touch "${DATA_DIR}/.gitkeep"

echo "[gemini-web2api-init] data dir ready: ${DATA_DIR} (owner ${RUN_UID}:${RUN_GID})"
