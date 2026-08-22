# Linkwarden 自托管书签管理器

Linkwarden 是一个开源的自托管书签管理器，支持标签、全文搜索、网页归档、浏览器扩展等功能，帮助你整理和管理收藏的链接。

## 访问

- Web UI: http://192.168.98.246:3000

## 功能

- 书签收藏与标签分类
- 全文搜索（由 Meilisearch 提供）
- 网页归档（保存网页快照/PDF/截图）
- 浏览器扩展支持
- 导入/导出书签
- 多用户与 OAuth/SSO 支持

## 依赖

- PostgreSQL 16 - 主数据存储
- Meilisearch - 全文搜索引擎

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| PANEL_APP_PORT_HTTP | 宿主机 Web 端口 | 3000 |
| POSTGRES_PASSWORD | PostgreSQL 密码（必填，自动构建 DATABASE_URL） | (必填) |
| MEILI_MASTER_KEY | Meilisearch 主密钥（必填） | (必填) |
| NEXTAUTH_SECRET | NextAuth 密钥 | (必填，至少 32 字符) |
| NEXTAUTH_URL | 应用访问地址 | http://localhost:3000 |

## 数据持久化

- PostgreSQL 数据: ./data/postgres
- Meilisearch 数据: ./data/meili
- Linkwarden 上传文件: ./data/uploads

## 部署说明

1. 生成 NEXTAUTH_SECRET: `openssl rand -base64 32`
2. 生成 MEILI_MASTER_KEY: `openssl rand -hex 32`
3. 设置 NEXTAUTH_URL 为实际访问地址（含协议与端口）
4. 部署后访问 Web UI 完成初始化设置
5. 首次注册的用户自动成为管理员
