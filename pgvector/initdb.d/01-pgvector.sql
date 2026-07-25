-- pgvector 首次启动初始化脚本
-- 由 PostgreSQL 容器首次启动时自动执行（仅对 POSTGRES_DB 创建时生效一次）。
--
-- 此脚本在 1Panel 部署 pgvector 时确保 vector 扩展可用，
-- 避免用户必须手动 `psql -c "CREATE EXTENSION vector;"`。
--
-- 注意：本脚本只在 POSTGRES_DB 默认数据库中创建扩展。
-- 用户后续用 psql `CREATE DATABASE` 新建的库不会自动继承 vector 扩展，
-- 如需在新库中启用，请先 psql 连接新库再执行 `CREATE EXTENSION vector;`，
-- 或者把本文件改为 `ALTER DATABASE your_db ...` 形式。

-- 在当前默认数据库（POSTGRES_DB）中启用 vector 扩展
CREATE EXTENSION IF NOT EXISTS vector;