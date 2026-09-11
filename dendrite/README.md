# Dendrite — Matrix Homeserver

> [element-hq/dendrite](https://github.com/element-hq/dendrite) ·
> `ghcr.io/element-hq/dendrite-monolith:v0.15.2` · Go · AGPL-3.0

Element 团队（Matrix 协议原作者）用 Go 编写的新一代 Matrix homeserver，对比 Synapse 资源占用更低、启动更快、API 完全兼容。本应用以 monolith 单镜像形式部署，内置 NATS Server，无需另起 JetStream / Kafka。

## 端口

| 端口 | 用途 |
|------|------|
| 8008 | Client-Server API（Element Web / 移动端 / 第三方客户端连接） |
| 8448 | Federation（服务器间互联，**仅当你直接在容器内终结 TLS 时才需对外开放**；通常交给反代） |

## 部署前准备

部署前你需要：

1. **一个公网域名**（例 `matrix.example.com`），DNS 解析到本机 IP；
2. **反代 + TLS**（强烈推荐 [Caddy](https://caddyserver.com) 自动证书）：
   ```
   handle /.well-known/matrix/* {
       header Content-Type application/json
       header Access-Control-Allow-Origin *
       respond `{"m.server": "matrix.example.com:443"}`
   }
   handle /_matrix/* {
       reverse_proxy 127.0.0.1:8008
   }
   ```
3. **可选**：若选 PostgreSQL，需先在 1Panel 应用商店部署一个 Postgres（见下）。

## 安装步骤

1. 1Panel 应用商店 → 本地 → 找到 **Dendrite** → 安装
2. 关键表单：
   - **Server Name**：填你的 Matrix 域名（例 `matrix.example.com`），**必须**与反代配置一致
   - **Database URL**：默认 `file:dendrite.db`（SQLite，单机自用足够）
     - 切到 PostgreSQL：先在 1Panel 安装一个 Postgres 实例，连接串形如：
       `postgres://user:pass@1Panel-postgresql-xxxx:5432/dendrite?sslmode=disable`
   - **Registration Shared Secret**：留空 = 禁止公开注册（推荐）。
     - 如需管理员创建账号，填一个强随机串（`openssl rand -hex 32`），然后用
       `POST /_synapse/admin/v1/register` 或 Element 客户端「高级设置 → 自定义服务器」
       配合 shared secret 注册。
3. 启动后访问 `https://matrix.example.com/_matrix/client/versions` 应返回 JSON 200

## 注册账号（管理员侧）

如果你设置了 `REGISTRATION_SHARED_SECRET`：

```bash
curl -X POST 'https://matrix.example.com/_synapse/admin/v1/register' \
  -H 'Content-Type: application/json' \
  -d '{
    "auth": { "type": "m.login.passwordless_register", "secret": "你的shared secret" },
    "username": "alice",
    "password": "强密码"
  }'
```

> Element 桌面端 / 移动端的「自定义服务器」流程会自动调用此接口。

## 首次启动发生了什么

`scripts/init.sh` 在首次启动时自动：

1. `generate-keys -private-key /etc/dendrite/matrix_key.pem` — 生成 Ed25519 签名密钥（**不要丢，否则历史消息签名会失效**）
2. `generate-config -dir /etc/dendrite -db <DATABASE_URL> -server <SERVER_NAME>` — 生成完整 `dendrite.yaml`
3. 根据 `REGISTRATION_SHARED_SECRET` 是否填写，决定 `registration_disabled` 与 `registration_shared_secret`
4. `exec /usr/bin/dendrite` 启动

之后重启容器不会再次生成（已存在则跳过），你的手动修改会被保留。

## 高级配置

完整 `dendrite.yaml` 暴露在 `${DATA_PATH}/dendrite.yaml`，可手动编辑后重启容器。常用项：

```yaml
global:
  server_name: matrix.example.com
  private_key: /etc/dendrite/matrix_key.pem
  well_known_server_name: example.com          # 可选：well-known 委派给根域名
  well_known_client_name: example.com
client_api:
  rate_limiting:
    enabled: true
federation_api:
  disable_tls_validation: false                 # 仅当对接自签证书联邦时改 true
media_api:
  base_path: /etc/dendrite/media
  max_file_size_bytes: 104857600                # 100MB
```

详细字段说明见官方文档 [Configuration](https://element-hq.github.io/dendrite/installation/configuration)。

## 联邦（Federation）

要让其他 homeserver 与你联邦，必须满足：

- 公网可解析的 `matrix.example.com` 域名
- TLS 证书可信（Let's Encrypt 即可）
- `_matrix/_matrix.federation/v1/version` 在 443 端口可被访问
- `/.well-known/matrix/server` 返回 `{"m.server": "matrix.example.com:443"}`

Caddy 配置见上文。

## 性能与容量

| 项 | 单机 SQLite | Postgres |
|----|------------|----------|
| 联邦房间数 | 几百以下 | 数千 |
| 并发用户 | 数十 | 数百 |
| 写入并发 | 极弱（SQLite 全局锁） | 强（行级锁） |
| 推荐场景 | 自用 / 家庭 / 社区 | 团队 / 公网服务 |

> 上游推荐所有生产环境使用 Postgres（见官方 [Planning 文档](https://element-hq.github.io/dendrite/installation/planning)）。

## 常见问题

**Q：日志在哪？**
`${DATA_PATH}/log/` 下按日期滚动。如需 stdout，请编辑 `dendrite.yaml` 把 `logging` 改为 `type: stdout`。

**Q：换域名 / 换数据库？**
改 `dendrite.yaml` 顶部的 `server_name` / `global.database` 段即可。**不要重命名 matrix_key.pem**（联邦签名失效）。

**Q：升级到新版？**
`git pull` 本仓，1Panel 同步后会显示新版本（v0.15.x、v0.16.x…）。升级前先备份 `matrix_key.pem`。

**Q：postgres 连接串的 `sslmode=disable`？**
1Panel 内网容器间通信默认不需要 TLS。生产请改 `verify-full` 并加证书。

## 镜像升级

`detect-updates.mjs` 每周一 cron 会拉取 GHCR `element-hq/dendrite-monolith` 的最新 tag，发现新版本会开 `auto-update/<date>` PR 同步到本仓的 v0.15.x 目录。

## 文件结构

```
dendrite/
├── data.yml              # 根元数据（key, name, type=tool, i18n description）
├── logo.png              # Matrix logo
├── README.md             # 本文件
└── v0.15.2/              # 版本目录（名称 = 1Panel UI 版本参数）
    ├── data.yml          # formFields（端口、域名、DB、注册密钥、时区）
    ├── docker-compose.yml
    ├── data/             # 持久化（.gitkeep，运行时由 init.sh 填入）
    └── scripts/
        └── init.sh       # 首次启动生成 key + config
```
