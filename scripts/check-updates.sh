#!/usr/bin/env bash
# 1Panel Local Apps - 镜像更新检查薄壳（**已弃用，只读**）
#
# 实际逻辑已迁至 .github/scripts/detect-updates.mjs；本脚本仅保留旧入口兼容。
#
# ⚠️ 行为变更（2026-11）：detect-updates.mjs 默认会**写仓库**（生成 updates.json 与
#    新版本目录），而仓库规约要求「检测链路在 CI 之外只允许 dry-run」
#    （见 AGENTS.md §8 / docs/automation.md §2）。本壳现在**强制追加 --dry-run**，
#    因此不可能再误改工作区；需要真正生成更新请在 CI（auto-update 工作流）里跑。
#
# 推荐用法：
#   npm run detect:dry-run                # 全量只读检测
#   npm run detect:dry-run -- jellyfin    # 仅检测指定应用（APPS_FILTER）
#
# 退出码与 detect-updates.mjs 一致。

set -euo pipefail

command -v node >/dev/null 2>&1 || {
  echo "[ERROR] 需要 node >= 24（见 package.json engines / .nvmrc）"
  exit 1
}

echo "[WARN] scripts/check-updates.sh 已弃用：本脚本已强制只读（--dry-run）。" >&2
echo "[WARN] 推荐使用: npm run detect:dry-run" >&2

# 透传参数，但强制只读（--dry-run 幂等：detect 侧按「是否包含」判定）
exec node "$(dirname "$0")/../.github/scripts/detect-updates.mjs" --dry-run "$@"
