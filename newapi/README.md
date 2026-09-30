# New API

New API 是 [QuantumNous](https://github.com/QuantumNous) 团队维护的 AI 大模型 API 聚合与分发平台，**兼容 OpenAI / Anthropic / Gemini / Azure / AWS Bedrock** 等多上游协议。在统一入口背后做渠道负载均衡、用户额度、配额管理、计费、兑换码、绘图、音频转写、任务插件等工作。

- **GitHub**: <https://github.com/QuantumNous/new-api>
- **License**: AGPL-3.0（上游）
- **上游镜像**: `calciumion/new-api`（DockerHub，multi-arch manifest: `linux/amd64` + `linux/arm64`）
- **当前 1Panel 版本**: `v1.0.0-rc.40`（2026-09-21 上游发布；目前上游仅发布 v1.0.0-rc.X 预发布序列，未见稳定 v1.0.0）

## 功能要点

- **多上游兼容**：以 OpenAI ChatCompletion / Anthropic Messages / Gemini / Azure OpenAI / AWS Bedrock / Cohere / Dify 等统一协议对外
- **渠道管理**：单上游多 Key 轮询 / 加权 / 故障转移；并发限速与黑名单
- **用户与额度**：注册 / 登录 / 分组 / 充值 / 兑换码 / 邀请返佣 / 余额警告
- **计费模型**：按次 / 按 token / 按倍率（适配 reasoning 模型 / 上下文缓存 / 流式补价）
- **任务能力**：图像生成、音频转写（TTS / STT）、异步任务（`/v1/responses` 风格）、智能体 / 插件
- **可观测**：审计日志、调用明细、消费排行、错误统计；支持 ClickHouse 单独存日志
- **跨架构**：amd64 (x86_64) + arm64 (aarch64) 一镜像双覆盖，N100 / 树莓派 / Apple Silicon Mac mini 都能跑

## 目录结构

按 1Panel 应用规范组织：

```
newapi/
├── data.yml                    # 根元数据（跨版本共享）
├── logo.png                    # 应用图标（来自 upstream web/public/logo.png）
├── README.md                   # 本说明
└── v1.0.0-rc.40/               # 当前版本
    ├── data.yml                # 版本元数据 + formFields
    ├── docker-compose.yml      # new-api + postgres + redis
    └── data/                   # 持久化占位
```

## 安装

1. 1Panel → 应用商店 → 本地应用 → 选择 `newapi`
2. 选择版本 `v1.0.0-rc.40`（上游目前唯一持续发布的预发布 tag；detect-updates 后续会自动跟踪新 RC）
3. 关键参数已预填，按需调整：
   - `PANEL_APP_PORT_HTTP` = `3000`（容器内 new-api 固定监听；改这里 = 改宿主机侧访问端口）
   - `POSTGRES_PASSWORD` / `REDIS_PASSWORD` 留空会自动生成安全随机值，**生产前必须手动改**
   - `SESSION_SECRET` 默认 `please-change-this-secret-in-production`，**生产前必须改**
   - `NODE_NAME` 默认 `newapi-node-1`（多节点部署时区分节点；单节点保持即可）
4. 提交安装 → 容器启动顺序：postgres / redis 先 healthcheck 通过 → new-api 启动
5. 等约 30-60 秒（healthcheck `start_period: 60s`），浏览器访问 `http://<1Panel 主机 IP>:3000` 打开 New API 控制台
6. **首次登录**：用任意邮箱 + 密码注册即可成为超级管理员（上游行为，第一注册用户为 root）

## 配置

### 数据库（内置 PostgreSQL + Redis）

为与上游 `docker-compose.yml` 保持一致，默认把 `postgres:15-alpine` + `redis:7-alpine` 作为 sidecar 起在同 compose 内。数据持久化到宿主机 `./data/postgres` 与 `./data/redis`（与 marginalia 同期规范一致，全部用相对路径 bind mount）。

如果你已有外部 PostgreSQL（如 1Panel 自带的 `1Panel-postgresql-XXXX` 容器），可以手动编辑 `v1.0.0-rc.40/docker-compose.yml`：

- 删除 `postgres` 整段
- 把 `SQL_DSN` 改成 `postgresql://<user>:<password>@<host>:<port>/<db>`（注意 1Panel-postgresql 容器名是 `1Panel-postgresql-XXXX` 大写 + Base32 4 字符，**没有**短横线/小写）
- 把 `depends_on.postgres` 一段删除

外部 Redis 同理：把 `REDIS_CONN_STRING` 改为 `redis://:<password>@<host>:6379`，删除 `redis` 服务。

### SQLite 模式（最轻量）

如果只是个人试玩、不想跑 postgres / redis：

1. 删除 `postgres` 与 `redis` 两个 service
2. 改 `SQL_DSN` 为 `SQLITE_PATH=/data/sqlite.db`（用空字符串即可让上游默认走 SQLite 路径）

### Session Secret（多节点必改）

`SESSION_SECRET` 用于跨节点 session 校验。单节点部署可保留默认；**多节点 / 多副本 / 反代后多实例必须改成 32+ 字符随机串**（否则 session 在节点间不一致，会反复登出）。生产推荐 `openssl rand -hex 32`。

### 错误日志 / 批量更新

- `ERROR_LOG_ENABLED=true`：记录上游返回的错误响应（诊断渠道异常用）
- `BATCH_UPDATE_ENABLED=true`：渠道余额/状态批量刷新（关闭后只懒加载更新）

关闭后调用明细不再持久化错误码，渠道健康度依赖定时检查。

## 数据持久化

| 容器内路径 | 主机侧路径 | 用途 |
| --- | --- | --- |
| `/data` | `./data/data` | new-api 应用数据（SQLite 文件 / 用户上传 / 配置导出） |
| `/app/logs` | `./data/logs` | new-api 启动日志 + 运行日志（`--log-dir` 注入） |
| `/var/lib/postgresql/data` | `./data/postgres` | PostgreSQL 数据目录（仅内置 PG 模式） |
| `/data` | `./data/redis` | Redis AOF + RDB 持久化（仅内置 Redis 模式） |

容器重启 / 升级不会清空这些数据；卸载应用再装时只要 `data/` 目录还在，账号、额度、调用明细都会保留。

## 镜像更新

本应用使用变量型镜像（`${IMAGE}:${APP_VERSION}`），`detect-updates` 周一 cron 会拉取 `calciumion/new-api` 的新 tag，发现新 RC（如 `v1.0.0-rc.41`）会**新建版本目录** `v1.0.0-rc.41/` 并保留 `v1.0.0-rc.40/` 供回滚（在 1Panel UI「升级」中可下拉切换）。

手动升级方式：

1. 1Panel → 本地应用 → newapi → 升级
2. 选择最新版本目录（如 `v1.0.0-rc.41`）
3. 提交 → 旧容器停 + 新容器起 + 数据卷复用

## 常见问题

**Q: 1Panel UI 升级后只看到 1 个版本下拉项？**
A: detect 还没跑出第二个版本目录。目前上游 `v1.0.0-rc.40` 是最新，detect 命中 `rc.41` 后会自动 cpSync 出新目录。也可以手动：用 SSH 在宿主机上 `cp -a newapi/v1.0.0-rc.40 newapi/v1.0.0-rc.41` + 改 compose 里的 `APP_VERSION` default，再 1Panel 重新同步仓库。

**Q: 启动后容器一直在 restart 循环？**
A: 大概率是 `SESSION_SECRET` / `POSTGRES_PASSWORD` / `REDIS_PASSWORD` 留空但 1Panel 自动填充了不合规字符，或 healthcheck 一直 fail。`docker logs <container>` 看最后 30 行：
- `connection refused postgres:5432`：内置 PG 还没 ready，等 30 秒再起 new-api 是 compose `depends_on: service_healthy` 的语义；如果持续失败，看 `docker logs <postgres container>` PG 是不是 OOM
- `pq: password authentication failed`：之前装过同目录应用但密码与持久化 PG 内 hash 不一致——删除 `data/postgres` 重新初始化（**会丢数据**）
- `fatal error: failed to start server`：通常是 `SESSION_SECRET` 包含特殊字符没 quote；改成纯字母数字 32+ 字符

**Q: 想用 OpenAI 官方上游，但新账号没余额怎么办？**
A: New API 不背靠 OpenAI；用它是**转发**你的 OpenAI 账号 / API Key 到面板下的用户。你需要在 New API 控制台「渠道管理」里添加自己的 OpenAI API Key（或 Azure / Anthropic / Gemini 凭据），然后给面板用户「充值」或「按量扣费」消费。

**Q: 数据库迁移到 MySQL 怎么做？**
A: 上游 compose 注释里给了 MySQL 示例（`SQL_DSN=root:123456@tcp(mysql:3306)/new-api`）。手动改 compose 即可，但**生产数据迁移需用 `pg_dump` / `mysqldump` 自行迁**，New API 不内置数据迁移工具。

**Q: 多节点怎么部署？**
A: 同一 compose 文件复制多份，挂载**同一** `data/postgres` 与 `data/redis` 共享存储（NFS / CephFS / 分布式块存储），改 `CONTAINER_NAME` 与 `NODE_NAME` 区分节点，`SESSION_SECRET` 全部相同。健康检查 + 反向代理（Traefik / Caddy）做 round-robin。

**Q: 上游只有 `v1.0.0-rc.X` 预发布，稳吗？**
A: 截至 2026-09-30，QuantumNous 团队共发布 40 个 RC tag（`v1.0.0-rc.1` ~ `v1.0.0-rc.40`），更新频率约 1-3 天/版。所有 RC tag 在 GitHub release 页都标记为 `prerelease: false`（即非 prerelease，可视为「非稳定但生产可用」）。如果你需要绝对稳定，可锁版本到 `v1.0.0-rc.40` 不再升级，等正式 v1.0.0 发布。

## 许可

- 上游 New API: AGPL-3.0（[原文](https://github.com/QuantumNous/new-api/blob/main/LICENSE)）
- 本仓库 1Panel 应用定义：随主仓库协议
- AI 模型服务条款归各上游（OpenAI / Anthropic / Google / etc.）所有，与本应用无关
