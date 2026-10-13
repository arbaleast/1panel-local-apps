#!/usr/bin/with-contenv sh
# 00-host-fonts.sh
# jlesage baseimage-gui 的 10-cjk-font.sh 走 apt-get install fonts-wqy-zenhei,
# 在国内/受限服务器拉不动 deb.debian.org, init 步骤失败 → s6 服务退出 → restart: always
# 进入"启动→秒退→再启动"循环。本应用通过 ENABLE_CJK_FONT=0 禁用 jlesage 的安装脚本,
# 改由本脚本在 init 阶段把宿主机 CJK 字体目录挂载到容器内, 跑 fc-cache 注册。
#
# 工作流:
#   1. 宿主机准备 CJK 字体目录 (典型路径: /usr/share/fonts/truetype/wqy, Debian/Ubuntu
#      `apt install fonts-wqy-zenhei` 装出来的位置; 也可填自定义目录, 里面放 .ttf/.otf/.ttc)
#   2. 1Panel 表单填 FONT_PATH (默认 /usr/share/fonts/truetype/wqy, 留空跳过)
#   3. compose 挂载 ${FONT_PATH}:/usr/share/fonts/truetype/wqy:ro (宿主机目录非空时挂)
#   4. 本脚本检测容器内目标目录非空后, 跑 fc-cache -fv 刷新 fontconfig 缓存
#   5. fc-list :lang=zh 校验, 失败不退出 (容错: 即便字体注册失败, 容器其他功能照常起)
#
# 注意: 即便脚本失败, 容器也能起 — 这是个"增强 CJK 渲染"步骤, 不是阻塞步骤。

set +e  # 容错, 字体问题不应影响容器启动

log() { echo "[cont-init.d] $(basename "$0"): $*"; }

# 1Panel 注入的 FONT_PATH, 默认 Debian/Ubuntu 装 fonts-wqy-zenhei 后的位置
FONT_PATH="${FONT_PATH:-/usr/share/fonts/truetype/wqy}"
TARGET_DIR="/usr/share/fonts/truetype/wqy"

# 校验: 只接受绝对路径, 避免 shell 注入
case "$FONT_PATH" in
    /*) ;;
    *)  log "FONT_PATH='${FONT_PATH}' 非绝对路径, 跳过"; exit 0 ;;
esac

# 宿主机目录若不存在, 跳过 (compose 挂载会失败, 不在此报错)
# 注意: 此时容器内 /usr/share/fonts/truetype/wqy 还**未挂** (挂载在 init 后生效? 不, init 前挂好)
#       所以这里读的是容器内真实路径, 若已挂则有内容
if [ ! -d "$TARGET_DIR" ]; then
    log "容器内 ${TARGET_DIR} 不存在 (compose 挂载失败或 FONT_PATH 为空), 跳过字体注册"
    exit 0
fi

# 检测至少有一个字体文件
count=$(find "$TARGET_DIR" -maxdepth 3 -type f \( -name "*.ttf" -o -name "*.otf" -o -name "*.ttc" \) | wc -l)
if [ "$count" -eq 0 ]; then
    log "${TARGET_DIR} 内无 .ttf/.otf/.ttc 文件, 跳过"
    exit 0
fi

log "发现 ${count} 个字体文件, 刷新 fontconfig 缓存..."

# fc-cache 在容器基础镜像里通常可用; 失败时降级输出诊断
if command -v fc-cache >/dev/null 2>&1; then
    if fc-cache -fv "$TARGET_DIR" 2>&1 | tail -5; then
        log "fc-cache 成功"
    else
        log "fc-cache 失败 (非致命)"
    fi
else
    log "fc-cache 不可用, 跳过"
    exit 0
fi

# 校验: 至少看到一个 zh 字体
zh_count=$(fc-list :lang=zh 2>/dev/null | wc -l)
if [ "$zh_count" -gt 0 ]; then
    log "fc-list :lang=zh 返回 ${zh_count} 条记录, 字体注册成功"
else
    log "警告: fc-list :lang=zh 仍为 0, noVNC 中文渲染可能仍异常"
fi
