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

    # 通过 Registry API 检查最新版本（ghcr.io 与 Docker Hub 分流）
    local latest_tag
    if [[ "$repo" == ghcr.io/* ]]; then
        # GHCR 是 OCI Registry：GitHub Packages API 匿名访问返回 401，
        # 改用 GHCR 原生 token + tags/list 端点（匿名可用）
        local ghcr_repo="${repo#ghcr.io/}"
        local ghcr_token
        ghcr_token=$(curl -s --max-time 10 "https://ghcr.io/token?scope=repository:${ghcr_repo}:pull" 2>/dev/null \
            | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || true)
        latest_tag=$(curl -s --max-time 10 -H "Authorization: Bearer ${ghcr_token}" \
            "https://ghcr.io/v2/${ghcr_repo}/tags/list?n=1000" 2>/dev/null \
            | python3 -c '
import sys, json, re
try:
    data = json.load(sys.stdin)
    tags = data.get("tags", [])
    def is_bad(t):
        return bool(re.match(r"^(latest|nightly|dev|edge|alpha|beta|rc|main|master)$", t, re.I)) or ("slim" in t.lower()) or ("sha256" in t.lower())
    tags = [t for t in tags if not is_bad(t)]
    if not tags:
        print("unknown")
    else:
        pure = [t for t in tags if re.match(r"^v?\d+\.\d+\.\d+$", t)]
        sel = pure or tags
        def key(t):
            m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$", t)
            if m:
                return (1, tuple(int(x) for x in m.groups()[:3]), t)
            return (0, (), t)
        sel.sort(key=key)
        print(sel[-1])
except:
    print("unknown")
' 2>/dev/null)
    else
        latest_tag=$(curl -s --max-time 10 \
            "https://hub.docker.com/v2/repositories/$repo/tags/?page_size=10&ordering=last_updated" 2>/dev/null \
            | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    tags = [r['name'] for r in data.get('results', [])]
    stable = [t for t in tags if not any(x in t for x in ['latest', 'nightly', 'dev', 'edge'])]
    print(stable[0] if stable else 'unknown')
except:
    print('unknown')
" 2>/dev/null)
    fi

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
