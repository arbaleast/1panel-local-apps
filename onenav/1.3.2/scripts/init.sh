#!/bin/sh
# OneNav 首次安装初始化脚本（在 1Panel 宿主机上跑）
#
# 调用时机: 1Panel 在 docker compose up -d 之前先调本脚本
#   (appspec: "Installation initialization, before container startup")
# 执行环境: 1Panel 宿主机（不是容器内！）。
#
# 背景（来自上游 helloxz/docker-onenav install.sh + controller/login.php）：
#   上游镜像 helloz/onenav 在 install.sh 阶段从 GitHub git clone helloxz/onenav
#   源码到 /data/wwwroot/default，然后 run.sh 启动 php-fpm7 + nginx。
#   OneNav 没有环境变量直接驱动初始化，admin 账号密码在 config.php 中定义，
#   而 config.php 是用户在首次访问 http://host/index.php 引导页填写的
#   （写盘前要生成正确的 ENCRYPTED_PASSWORD = md5(USER.PASSWORD)）。
#
# 工作流程:
#   1. 加载 1Panel 写的 .env（IMAGE / APP_VERSION / ONENAV_USER / ONENAV_PASSWORD / ...）
#   2. 创建 ./data 与必要的子目录
#   3. 若 ./data/config.php 不存在：
#        docker pull <IMAGE>:<APP_VERSION>
#        docker run --rm 临时容器，把镜像内 /data/wwwroot/default/data 的
#        示例 config.php 拷到 host ./data/config.php，再用 ONENAV_USER /
#        ONENAV_PASSWORD 计算 ENCRYPTED_PASSWORD = md5(user + "$pass") 替换占位符
#   4. 若 ./data/config.php 已存在：保留用户历史编辑（不覆盖）
#   5. 兜底创建 ./data/.htaccess 与 ./data/templates/.gitkeep
#
# 升级行为:
#   1Panel 升级/参数更新时不重跑 init.sh（appspec.md 明示）。
#   若需要重置管理员账号：删除 ./data/config.php 后重新触发「安装」
#   **注意**：重置 config.php 后已存在的 SQLite 数据库（onenav.db3）不受影响，
#   旧的 USER / ENCRYPTED_PASSWORD 仍然能登录；若想强制改密请同步重置数据库
#   或在后台修改。
#
# 注意：1Panel formField ONENAV_PASSWORD 留空会由 compose 端
#   ${ONENAV_PASSWORD:?...} 强制报错；本 init.sh 不重复校验。

set -eu

# ---------- 0. 路径 / 环境变量解析 ----------
WORKDIR="${INIT_WORKDIR:-$(pwd)}"
ENV_FILE=""
for candidate in \
    "${WORKDIR}/.env" \
    "/opt/1panel/apps/local/onenav/onenav/.env" \
    "/opt/1panel/apps/local/onenav/.env" \
    "/.env"; do
    if [ -f "${candidate}" ]; then
        ENV_FILE="${candidate}"
        break
    fi
done

if [ -n "${ENV_FILE}" ]; then
    echo "[onenav-init] Loading formField values from ${ENV_FILE}"
    set -a
    . "${ENV_FILE}"
    set +a
else
    echo "[onenav-init] WARNING: no .env found at ${WORKDIR}, using shell env"
fi

# 兜底默认值
IMAGE="${IMAGE:-helloz/onenav}"
APP_VERSION="${APP_VERSION:-1.2.4}"
ONENAV_USER="${ONENAV_USER:-admin}"
ONENAV_PASSWORD="${ONENAV_PASSWORD:-onenav123}"

# 解析 DATA_PATH（compose 里的 ./data；相对路径相对 WORKDIR）
DATA_PATH="${DATA_PATH:-./data}"
case "${DATA_PATH}" in
    /*) HOST_DATA_DIR="${DATA_PATH}" ;;
    *)  HOST_DATA_DIR="${WORKDIR}/${DATA_PATH#./}" ;;
esac

mkdir -p "${HOST_DATA_DIR}"
mkdir -p "${HOST_DATA_DIR}/uploads"
mkdir -p "${HOST_DATA_DIR}/templates"
CONFIG_FILE="${HOST_DATA_DIR}/config.php"
echo "[onenav-init] Host data dir: ${HOST_DATA_DIR}"
echo "[onenav-init] Image: ${IMAGE}:${APP_VERSION}"
echo "[onenav-init] Admin user: ${ONENAV_USER}"

# ---------- 1. docker 可用性检查 ----------
if ! command -v docker >/dev/null 2>&1; then
    echo "[onenav-init] FATAL: docker not found in PATH (init.sh must run on 1Panel host)" >&2
    exit 1
fi

# ---------- 2. 预检镜像可拉取 ----------
if ! docker pull "${IMAGE}:${APP_VERSION}" >/dev/null 2>&1; then
    echo "[onenav-init] WARNING: docker pull failed, will try to use local image if present"
fi
if ! docker image inspect "${IMAGE}:${APP_VERSION}" >/dev/null 2>&1; then
    echo "[onenav-init] FATAL: ${IMAGE}:${APP_VERSION} is not available locally." >&2
    echo "[onenav-init] Hints:" >&2
    echo "[onenav-init]   1. 上游 OneNav release tag 与 helloz/onenav Docker tag 一致 (如 1.2.4)" >&2
    echo "[onenav-init]   2. 镜像仓库 visibility 需是 public" >&2
    echo "[onenav-init]   3. 国内服务器可能需要配置 Docker Hub 镜像加速器" >&2
    exit 1
fi

# ---------- 3. 提取默认 config.php（仅当 host 端不存在）----------
if [ -f "${CONFIG_FILE}" ]; then
    echo "[onenav-init] Reusing existing ${CONFIG_FILE} (preserves user edits)"
else
    echo "[onenav-init] Extracting default config.php from ${IMAGE}:${APP_VERSION}..."
    # 上游 install.sh 把示例 config.php 放在 /data/wwwroot/default/config.simple.php
    # （git clone 后位于源码根，不在 data/ 子目录下）。
    # 整目录挂载 ./data → /data/wwwroot/default/data 会遮住镜像内置 data/，
    # 但 config.simple.php 在 git clone 后的源码根，不会被遮住。
    # 用 --entrypoint "" 覆盖入口，仅跑 mkdir + cp + chmod。
    if ! docker run --rm --entrypoint "" \
        -v "${HOST_DATA_DIR}:/out" \
        "${IMAGE}:${APP_VERSION}" \
        sh -c 'mkdir -p /out && cp -f /data/wwwroot/default/config.simple.php /out/config.php && chmod 0644 /out/config.php'; then
        echo "[onenav-init] FATAL: cannot extract config.simple.php from ${IMAGE}:${APP_VERSION}" >&2
        exit 1
    fi

    # 计算 ENCRYPTED_PASSWORD = md5(USER.PASSWORD)（与 controller/login.php 一致）
    ENCRYPTED_PASSWORD="$(printf '%s' "${ONENAV_USER}${ONENAV_PASSWORD}" | md5sum | awk '{print $1}')"

    # 替换占位符
    # 上游 config.simple.php 中：
    #   define('USER','{username}');
    #   define('ENCRYPTED_PASSWORD','{encrypted_password}');
    #   define('EMAIL','{email}');
    # 用 sed 把 USER / ENCRYPTED_PASSWORD 换成实际值，EMAIL 留空字符串。
    sed -i.tmp \
        -e "s|define('USER','{username}')|define('USER','${ONENAV_USER}')|" \
        -e "s|define('ENCRYPTED_PASSWORD','{encrypted_password}')|define('ENCRYPTED_PASSWORD','${ENCRYPTED_PASSWORD}')|" \
        -e "s|define('EMAIL','{email}')|define('EMAIL','')|" \
        "${CONFIG_FILE}"
    rm -f "${CONFIG_FILE}.tmp"

    echo "[onenav-init] Wrote default config to ${CONFIG_FILE} (USER=${ONENAV_USER})"
fi

# ---------- 4. 写空目录占位 ----------
touch "${HOST_DATA_DIR}/uploads/.gitkeep"
touch "${HOST_DATA_DIR}/templates/.gitkeep"

# 兜底：确保 config.php 可写
chmod 0644 "${CONFIG_FILE}" 2>/dev/null || true

echo "[onenav-init] Init complete. OneNav container will now start with configured admin account."
echo "[onenav-init] IMPORTANT: visit http://<host>:<port> and login with username '${ONENAV_USER}'."