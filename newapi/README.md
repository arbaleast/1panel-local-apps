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

## 依赖：外接 PostgreSQL + Redis

**本应用不再捆绑 PostgreSQL / Redis 容器**。启动前请先在 1Panel 安装：

- **PostgreSQL**（1Panel 应用商店 → 搜索 `postgresql` 安装）
- **Redis**（1Panel 应用商店 → 搜索 `redis` 安装）

安装完成后到「容器」列表里抄两个容器名（默认格式 `1Panel-postgresql-XXXX` / `1Panel-redis-XXXX`，X 是 Base32 4 字符 `[A-Za-z0-9]`），填进 newapi 表单的 **PG Host / Redis Host** 字段。容器名**必须完全一致**（1Panel 网络解析依赖容器名，DNS 不会自动找 IP）。

> **默认配置已经填好本仓库作者的容器名**（`1Panel-postgresql-ZU4y` / `1Panel-redis-wd53`）+ 演示账号 `user_wEJsSp` / `password_tyrcEJ`，仅作演示；你部署前必须改成自己主机上的实际容器名和账号。

## 目录结构

```
newapi/
├── data.yml                    # 根元数据（跨版本共享）
├── logo.png                    # 应用图标（来自 upstream web/public/logo.png）
├── README.md                   # 本说明
└── v1.0.0-rc.40/               # 当前版本
    ├── data.yml                # 版本元数据 + formFields
    ├── docker-compose.yml      # 仅 new-api（依赖外部 postgresql + redis）
    └── data/                   # 持久化占位
```

## 安装

1. 1Panel → 应用商店 → 本地应用 → 选择 `newapi`
2. 选择版本 `v1.0.0-rc.40`（上游目前唯一持续发布的预发布 tag；detect-updates 后续会自动跟踪新 RC）
3. **关键参数**（不修改即可，但请核对）：
   - `PG_HOST` = `1Panel-postgresql-ZU4y`（改成你主机上的实际 postgresql 容器名）
   - `PG_PORT` = `5432`
   - `PG_USER` / `PG_PASSWORD` = `user_wEJsSp` / `password_tyrcEJ`（1Panel 内置 postgresql 应用默认；改成你实际账号）
   - `PG_DATABASE` = `newapi`（new-api 启动时会自动建表；如用受限账号需 pre-create 空库并赋权）
   - `REDIS_HOST` = `1Panel-redis-wd53`（改成你主机上的实际 redis 容器名）
   - `REDIS_PASSWORD` = `1panel123`（redis 应用默认密码）
   - `PANEL_APP_PORT_HTTP` = `3000`（容器内 new-api 固定监听）
   - `SESSION_SECRET` 默认 `please-change-this-secret-in-production`，**生产前必须改**
   - `NODE_NAME` 默认 `newapi-node-1`（多节点部署时区分节点）
4. 提交安装 → 容器启动（无内置依赖，new-api 直连外部 postgresql + redis）
5. 等约 30-60 秒（healthcheck `start_period: 60s`），浏览器访问 `http://<1Panel 主机 IP>:3000` 打开 New API 控制台
6. **首次登录**：用任意邮箱 + 密码注册即可成为超级管理员（上游行为，第一注册用户为 root）

## 配置

### 为什么 formField 把 DSN / Redis URL 拆成多个字段？

直接暴露 `SQL_DSN=postgresql://user:pass@host:5432/db` 这种完整字符串到表单**不可行**：1Panel 前端 `checkParamCommon` 正则 `/^[a-zA-Z0-9]{1}[a-zA-Z0-9._-]{1,63}$/` 不接受 `:` / `@` / `/` 等字符，前端会直接拒掉。本应用按 dendrite 复盘（同根因：AGENTS.md 「dendrite 复盘（2026-09-11）」）拆成 5 个分字段：

| 用户填的 | compose 拼成 | 来源 |
|---|---|---|
| `PG_HOST` | `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}` | PG 标准 URL（上游官方推荐） |
| `PG_PORT` | ↑ | |
| `PG_USER` | ↑ | |
| `PG_PASSWORD` | ↑ | |
| `PG_DATABASE` | ↑ | |
| `REDIS_HOST` | `redis://:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}` | redis URL 标准格式（含 auth） |
| `REDIS_PORT` | ↑ | |
| `REDIS_PASSWORD` | ↑（**可空**） | 1Panel-redis 应用默认带密码 `1panel123`，无密码 redis 需手动改 compose，见下文 |

字段语义和提示一对一，提交不再被拒。

### 找 1Panel 内置 postgresql / redis 容器名

1. 1Panel → 容器 → 列表
2. 找到 `1Panel-postgresql-*` 与 `1Panel-redis-*` 两个容器
3. 拷贝**完整容器名**（含后缀 4 个字符），填入 newapi 表单

容器名规则：`1Panel-postgresql-XXXX` / `1Panel-redis-XXXX`，XXXX 是 1Panel 自动生成的 Base32 4 字符随机串（`[A-Z2-7]` 字母数字），**没有**下划线/短横线。

### Redis 无密码模式（advanced）

`REDIS_PASSWORD` 表单字段已标 `required: false`（可空），但本应用 compose 拼装固定为：
```yaml
REDIS_CONN_STRING=redis://:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}
```
**当 `REDIS_PASSWORD` 为空字符串时**，会拼出 `redis://:@host:6379`，上游 `redis.ParseURL` 直接报错 `failed to parse Redis connection string`。所以**仅清空字段会让 new-api 容器启动失败**。

如果你的 redis 应用确实关掉了 `requirepass`（无密码鉴权），需要手动改 compose：

1. SSH 到 1Panel 主机，编辑 `<install_path>/newapi/v1.0.0-rc.40/docker-compose.yml`
2. 把
   ```yaml
   - REDIS_CONN_STRING=redis://:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}
   ```
   改为
   ```yaml
   - REDIS_CONN_STRING=redis://${REDIS_HOST}:${REDIS_PORT}
   ```
3. `REDIS_PASSWORD` 字段留空 + 1Panel UI 重启 new-api 容器

`REDIS_PASSWORD` 为空 + 仍带 `:@` 片段的 compose → `redis.ParseURL` 报错 → 容器重启循环。这是用户**主动选择无 auth 模式**需要付出的代价。

> 1Panel 内置 redis 应用**默认带密码** `1panel123`，绝大多数场景**无需**走无密码模式——直接保留默认密码即可。

### Session Secret（多节点必改）

`SESSION_SECRET` 用于跨节点 session 校验。单节点部署可保留默认；**多节点 / 多副本 / 反代后多实例必须改成 32+ 字符随机串**（否则 session 在节点间不一致，会反复登出）。生产推荐 `openssl rand -hex 32`。

### 错误日志 / 批量更新

- `ERROR_LOG_ENABLED=true`：记录上游返回的错误响应（诊断渠道异常用）
- `BATCH_UPDATE_ENABLED=true`：渠道余额/状态批量刷新（关闭后只懒加载更新）

关闭后调用明细不再持久化错误码，渠道健康度依赖定时检查。

## 数据持久化

| 容器内路径 | 主机侧路径 | 用途 |
| --- | --- | --- |
| `/data` | `./data/data` | new-api 应用数据（用户上传 / 配置导出 / 上游 settings 缓存） |
| `/app/logs` | `./data/logs` | new-api 启动日志 + 运行日志（`--log-dir` 注入） |

数据库与 Redis 数据由 1Panel 内置 postgresql / redis 应用各自持久化，**不在本应用目录下**。容器重启 / 升级不会清空 new-api 数据；卸载本应用只删 new-api 容器，postgresql / redis 应用保留 → 数据继续可用。

## 镜像更新

本应用使用变量型镜像（`${IMAGE}:${APP_VERSION}`），`detect-updates` 周一 cron 会拉取 `calciumion/new-api` 的新 tag，发现新 RC（如 `v1.0.0-rc.41`）会**新建版本目录** `v1.0.0-rc.41/` 并保留 `v1.0.0-rc.40/` 供回滚（在 1Panel UI「升级」中可下拉切换）。

手动升级方式：

1. 1Panel → 本地应用 → newapi → 升级
2. 选择最新版本目录（如 `v1.0.0-rc.41`）
3. 提交 → 旧容器停 + 新容器起 + 数据卷复用

## 常见问题

**Q: 容器启动后一直 restart loop？**
A: 通常是外部 postgresql / redis 连不上。三步排查：
1. 1Panel → 容器 → 确认 `1Panel-postgresql-XXXX` 和 `1Panel-redis-XXXX` 两个容器都在**运行**状态（不是 Exited）
2. new-api 容器与 postgresql / redis 必须在同一 `1panel-network` 网络。1Panel 内置应用默认就在，new-api compose 里也声明了 `1panel-network: external: true` —— 不需要额外配置
3. `docker logs <new-api container>` 看最后 30 行：
   - `dial tcp: lookup 1Panel-postgresql-ZU4y on ... no such host`：容器名写错，去 1Panel 容器列表重新抄
   - `pq: password authentication failed for user "user_wEJsSp"`：PG_USER / PG_PASSWORD 与 postgresql 应用不一致，去 postgresql 应用 UI 改用户密码后回填
   - `dial tcp ...:6379: connect: connection refused`：redis 应用没启 / 容器名错
   - `pq: database "newapi" does not exist`：PG_DATABASE 库没 pre-create，去 postgresql 应用 UI 创建一个空库 `newapi` 并赋权给当前用户
   - `failed to parse Redis connection string`：`REDIS_PASSWORD` 字段被你**清空**了，但 compose 拼装仍带 `:@` 片段，触发了 redis.ParseURL 错误 → 改回填默认密码 `1panel123`，或参考上文「Redis 无密码模式」手动改 compose

**Q: 想用 MySQL/MariaDB 而不是 PostgreSQL？**
A: 手动编辑 `v1.0.0-rc.40/docker-compose.yml`，把 `SQL_DSN` 行改为：
```yaml
- SQL_DSN=${DB_USER}:${DB_PASSWORD}@tcp(${DB_HOST}:${DB_PORT})/${DB_NAME}
```
然后把 formField `PG_HOST`/`PG_PORT`/`PG_USER`/`PG_PASSWORD`/`PG_DATABASE` 分别对应填 mariadb 应用的 `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`（因为 name 没变只是值不同），或者新增 `DB_*` 字段再相应改 compose。

**Q: 想用 SQLite 模式（最轻量，无外部依赖）？**
A: 手动编辑 `v1.0.0-rc.40/docker-compose.yml`：
- 删除 `SQL_DSN` 整行
- 把 `TZ` 行下面加一行 `- SQLITE_PATH=/data/sqlite.db`
- 把 `REDIS_CONN_STRING` 整行改为 `- REDIS_CONN_STRING=redis://localhost:6379`（不需要密码的本地 redis；或者直接删掉 REDIS_CONN_STRING 让上游走内存模式）
- 1Panel UI 把 `PG_*` 和 `REDIS_*` 字段**保留默认值**也行（不会被启动，但浪费配置面板）

**Q: 升级后只看到 1 个版本下拉项？**
A: detect 还没跑出第二个版本目录。目前上游 `v1.0.0-rc.40` 是最新，detect 命中 `v1.0.0-rc.41` 后会自动 cpSync 出新目录。也可以手动：用 SSH 在宿主机上 `cp -a newapi/v1.0.0-rc.40 newapi/v1.0.0-rc.41` + 改 compose 里的 `APP_VERSION` default，再 1Panel 重新同步仓库。

**Q: 想用 OpenAI 官方上游，但新账号没余额怎么办？**
A: New API 不背靠 OpenAI；用它是**转发**你的 OpenAI 账号 / API Key 到面板下的用户。你需要在 New API 控制台「渠道管理」里添加自己的 OpenAI API Key（或 Azure / Anthropic / Gemini 凭据），然后给面板用户「充值」或「按量扣费」消费。

**Q: 多节点怎么部署？**
A: 同一 compose 文件复制多份，每份连**同一** postgresql + redis 容器（共享后端），改 `CONTAINER_NAME` 与 `NODE_NAME` 区分节点，`SESSION_SECRET` 全部相同。健康检查 + 反向代理（Traefik / Caddy）做 round-robin。

**Q: 上游只有 `v1.0.0-rc.X` 预发布，稳吗？**
A: 截至 2026-09-30，QuantumNous 团队共发布 40 个 RC tag（`v1.0.0-rc.1` ~ `v1.0.0-rc.40`），更新频率约 1-3 天/版。所有 RC tag 在 GitHub release 页都标记为 `prerelease: false`（即非 prerelease，可视为「非稳定但生产可用」）。如果你需要绝对稳定，可锁版本到 `v1.0.0-rc.40` 不再升级，等正式 v1.0.0 发布。

## 许可

- 上游 New API: AGPL-3.0（[原文](https://github.com/QuantumNous/new-api/blob/main/LICENSE)）
- 本仓库 1Panel 应用定义：随主仓库协议
- AI 模型服务条款归各上游（OpenAI / Anthropic / Google / etc.）所有，与本应用无关