# PostgreSQL + pgvector

Postgres 向量相似度搜索扩展。

## 连接
- 端口: 5432
- 用户/密码: 见 .env

## 用途
- 存储 Hindsight/Immich 等 embeddings
- HNSW 索引加速向量搜索

## 数据库
- 见 .env POSTGRES_DB

## 运行用户 UID / GID

本应用**不提供** UID / GID 安装参数：Postgres 首次初始化（initdb）必须以 root 身份
chown `PGDATA` 后再降权，强制非 root 会导致数据目录初始化失败、容器无法启动。

容器内进程以 root 运行。如需限制运行身份，建议单独用非 root 账号 + ACL 方案部署，
或改用应用自带的数据库账号体系。
