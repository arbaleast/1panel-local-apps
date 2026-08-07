#!/usr/bin/env bash
# =============================================================================
# verify.sh
#
# 用途: 验证 Infinity Embeddings 服务是否正常:
#   1) GET  /health             -> 期望 HTTP 200
#   2) POST /embeddings         -> 期望返回 data[0].embedding 且维度 > 0
#
# 使用方式:
#   chmod +x infinity/.scripts/verify.sh
#   bash infinity/.scripts/verify.sh                  # 默认 BASE_URL=http://localhost:7997
#   BASE_URL=http://<host>:7997 bash infinity/.scripts/verify.sh   # 覆盖地址
#
# 注意:
#   - 依赖 curl (通常已内置)。
#   - 不硬编码任何凭据 / IP / 内网域名。
# =============================================================================

set -euo pipefail

# 默认服务地址, 可通过环境变量 BASE_URL 覆盖
BASE_URL="${BASE_URL:-http://localhost:7997}"

echo "==> 验证目标: ${BASE_URL}"
echo "==> (可用 BASE_URL=... 环境变量覆盖)"

# -----------------------------------------------------------------------------
# 步骤 1: 健康检查
# -----------------------------------------------------------------------------
echo ""
echo "---- [1/2] GET ${BASE_URL}/health ----"

# curl -fsS: -f 失败(非 2xx/3xx)即返回非零; -s 静默进度; -S 出错时显示错误
HEALTH_JSON="$(curl -fsS --max-time 15 "${BASE_URL}/health" 2>/dev/null \
  || { echo "!! 健康检查失败 (HTTP 非 2xx 或连接被拒)。"; echo "   请确认:"; \
       echo "   - 容器已启动 (docker ps / 1Panel 应用状态)"; \
       echo "   - 端口正确 (默认 7997, 与 PANEL_APP_PORT_HTTP 一致)"; \
       echo "   - 容器日志无报错 (docker logs <container>)"; exit 1; })"

echo "健康检查响应: ${HEALTH_JSON}"

# -----------------------------------------------------------------------------
# 步骤 2: Embedding 接口验证
# -----------------------------------------------------------------------------
echo ""
echo "---- [2/2] POST ${BASE_URL}/embeddings ----"

TEST_INPUT="hello world"
EMBEDDING_JSON="$(curl -fsS --max-time 120 -X POST "${BASE_URL}/embeddings" \
  -H "Content-Type: application/json" \
  -d "{\"input\": \"${TEST_INPUT}\"}" 2>/dev/null \
  || { echo "!! Embedding 请求失败 (HTTP 非 2xx 或超时)。"; \
       echo "   请确认模型已加载完成 (首次启动需下载模型, 耗时较长)"; \
       echo "   或查看容器日志定位错误 (docker logs <container>)。"; exit 1; })"

# 校验返回内容: 使用 python3 解析 JSON, 检查 data[0].embedding 存在且非空
echo "==> 校验返回结构 (data[0].embedding 存在且维度 > 0)..."

if command -v python3 >/dev/null 2>&1; then
  # python3 可用: 严格解析 JSON
  python3 -c "
import json, sys

try:
    data = json.loads(sys.argv[1])
except Exception:
    print('!! 返回内容不是合法 JSON:', sys.argv[1][:200])
    sys.exit(1)

try:
    vec = data['data'][0]['embedding']
except (KeyError, IndexError, TypeError):
    print('!! JSON 中缺少 data[0].embedding 字段')
    sys.exit(1)

if not isinstance(vec, list) or len(vec) == 0:
    print('!! embedding 为空或不是数组')
    sys.exit(1)

print('OK: embedding 维度 =', len(vec))
" "${EMBEDDING_JSON}"
else
  # 无 python3 时的兜底: 仅做字符串级粗检
  if echo "${EMBEDDING_JSON}" | grep -q '"embedding"'; then
    echo "OK: 响应包含 embedding 字段 (未安装 python3, 仅做粗检)"
  else
    echo "!! 响应中未找到 embedding 字段"
    echo "${EMBEDDING_JSON}" | head -c 500
    exit 1
  fi
fi

echo ""
echo "========================================================"
echo "验证通过: 服务正常, 可接入 AnythingLLM / 其他客户端。"
echo "   Endpoint: ${BASE_URL}/v1  (OpenAI 兼容)"
echo "========================================================"
