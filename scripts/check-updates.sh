#!/usr/bin/env bash
#
# check-updates.sh — 检查所有应用的 Docker 镜像是否有新版本
#
# 用法:
#   ./scripts/check-updates.sh              # 检查所有
#   ./scripts/check-updates.sh jellyfin     # 只检查 jellyfin
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

check_app() {
    local app_name="$1"
    local compose_file=""
    
    # 找 docker-compose.yml（优先版本目录）
    for f in "$REPO_DIR/$app_name"/*/docker-compose.yml "$REPO_DIR/$app_name"/docker-compose.yml; do
        if [[ -f "$f" ]]; then
            compose_file="$f"
            break
        fi
    done

    if [[ -z "$compose_file" ]]; then
        log "$app_name: 无 compose 文件"
        return
    fi

    # 提取镜像名和 tag
    local image
    image=$(grep -E '^\s*image:' "$compose_file" | head -1 | sed 's/.*image:\s*//' | tr -d '"' | tr -d "'")
    
    if [[ -z "$image" ]] || [[ "$image" == *'$'* ]]; then
        log "$app_name: 使用变量引用，跳过检查 ($image)"
        return
    fi

    local repo tag
    repo=$(echo "$image" | cut -d: -f1)
    tag=$(echo "$image" | cut -d: -f2)
    
    if [[ "$tag" == "latest" ]]; then
        log "$app_name: 使用 latest 标签，跳过"
        return
    fi

    # 通过 Docker Hub API 检查最新版本
    local hub_repo="$repo"
    # 如果是 ghcr.io 镜像，需要特殊处理
    if [[ "$repo" == ghcr.io/* ]]; then
        hub_repo="${repo#ghcr.io/}"
    fi

    local latest_tag
    latest_tag=$(curl -s --max-time 10 \
        "https://hub.docker.com/v2/repositories/$hub_repo/tags/?page_size=10&ordering=last_updated" 2>/dev/null \
        | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    tags = [r['name'] for r in data.get('results', [])]
    # 过滤掉 latest、nightly、dev 等
    stable = [t for t in tags if not any(x in t for x in ['latest', 'nightly', 'dev', 'edge'])]
    print(stable[0] if stable else 'unknown')
except:
    print('unknown')
" 2>/dev/null)

    if [[ "$latest_tag" == "unknown" ]] || [[ -z "$latest_tag" ]]; then
        log "$app_name: $repo — 无法获取最新版本"
        return
    fi

    if [[ "$tag" == "$latest_tag" ]]; then
        log "$app_name: ✓ 已是最新 ($image)"
    else
        log "$app_name: ⚠ 有新版本! 当前=$tag 最新=$latest_tag"
        log "           更新: 将 image 中的 :$tag 改为 :$latest_tag"
    fi
}

# 确定要检查的应用
if [[ $# -gt 0 ]]; then
    APPS=("$@")
else
    APPS=($(ls -d "$REPO_DIR"/*/ 2>/dev/null | xargs -I{} basename {} | grep -v -E '^\.|scripts|docs'))
fi

log "检查 ${#APPS[@]} 个应用的镜像更新..."
for app in "${APPS[@]}"; do
    check_app "$app"
done
