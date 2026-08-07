# Hindsight 长期记忆系统

Vectorize.io Agent 记忆系统：retain/recall/reflect，跨会话持久化事实。

## 访问
- Dashboard: https://hindsight.arbaleast.top/dashboard
- HTTP API: http://192.168.98.246:8888

## 用途
- 存 Hermes Agent 等 AI Agent 的跨会话记忆
- retain: 写入事实
- recall: 语义搜索
- reflect: 综合推理多个事实

## 依赖
- PostgreSQL + pgvector (HNSW 向量索引)
- Redis (缓存)

## 凭证
- 后台登录: 见 .env HINDSIGHT_ADMIN_USER / HINDSIGHT_ADMIN_PASSWORD
