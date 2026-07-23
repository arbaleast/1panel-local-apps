#!/usr/bin/env bash
#
# sync-to-1panel.sh — 从仓库同步应用到 1Panel 本地应用目录
#
# 用法:
#   ./scripts/sync-to-1panel.sh                    # 同步所有应用
#   ./scripts/sync-to-1panel.sh jellyfin            # 只同步 jellyfin
#   ./scripts/sync-to-1panel.sh jellyfin immich     # 同步多个
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PANEL_LOCAL="/opt/1panel/resource/apps/local"
SYNCED=0
FAILED=0

log() { echo "[$(date '+%H:%M:%S')] $*"; }

sync_app() {
    local app_name="$1"
    local src="$REPO_DIR/$app_name"
    local dst="$PANEL_LOCAL/$app_name"

    if [[ ! -d "$src" ]]; then
        log "SKIP  $app_name — 源目录不存在"
        return
    fi

    log "SYNC  $app_name ..."
    if sudo cp -r "$src/." "$dst/" 2>/dev/null; then
        sudo chown -R root:root "$dst"
        log "  OK  $app_name"
        ((SYNCED++))
    else
        log "  FAIL $app_name"
        ((FAILED++))
    fi
}

# 确定要同步的应用
if [[ $# -gt 0 ]]; then
    APPS=("$@")
else
    APPS=($(ls -d "$REPO_DIR"/*/ 2>/dev/null | xargs -I{} basename {}))
    # 排除非应用目录
    APPS=($(printf '%s\n' "${APPS[@]}" | grep -v -E '^\.|scripts|docs'))
fi

log "开始同步 ${#APPS[@]} 个应用到 $PANEL_LOCAL"
for app in "${APPS[@]}"; do
    sync_app "$app"
done

log "完成: $SYNCED 成功, $FAILED 失败"

# 触发 1Panel 同步
if command -v curl &>/dev/null; then
    log "触发 1Panel 应用同步..."
    curl -s -X POST "https://localhost:37790/api/v1/apps/sync" \
        -H "Content-Type: application/json" \
        -k --max-time 5 >/dev/null 2>&1 || true
fi

exit $FAILED
