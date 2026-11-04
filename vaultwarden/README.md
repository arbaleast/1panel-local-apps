# Vaultwarden 自托管密码管理器

[Vaultwarden](https://github.com/dani-garcia/vaultwarden) 是一个用 Rust 重写的 **Bitwarden 兼容**密码管理器服务端。官方 Bitwarden 服务端并不开源，Vaultwarden 提供了可自托管的等价实现：Web 保险库、浏览器扩展、桌面端与移动端客户端均可接入，支持多用户、组织与群组、附件、Send 与两步验证。所有数据保存在本机 SQLite 数据库中，密钥不出本机。

- **GitHub**: <https://github.com/dani-garcia/vaultwarden>
- **上游文档（Wiki）**: <https://github.com/dani-garcia/vaultwarden/wiki>
- **上游镜像**: `vaultwarden/server:1.37.5`（Docker Hub，多架构 `linux/amd64` + `linux/arm64` + `linux/arm/v7`）
- **License**: AGPL-3.0
- **目录结构**: `1.37.5/` 版本目录（与镜像 `:1.37.5` 标签对齐）

> ⚠️ **浏览器端必须走 HTTPS**：Web 保险库依赖浏览器的 **Web Crypto API**，它只在「安全上下文」里可用（HTTPS，或 `http://localhost`）。上游 README 明确要求启用 HTTPS 并配合反向代理。桌面端 / 移动端客户端不受此限制，可用明文 HTTP 直连。
>
> ⚠️ **WebSocket 走同一端口**：实时通知（`/notifications/hub`）与 Web 保险库、API 共用同一个端口，反向代理必须放行 `Upgrade` / `Connection` 头。

## 功能要点

- 端到端加密的密码保险库：条目、文件夹、收藏、回收站、导入导出
- 多用户账号 + 组织 / 群组（共享保险库）
- 两步验证（WebAuthn / TOTP / U2F / Duo / 邮件验证码等）
- 附件（每条条目）、Send（限时分享文件）
- 密码强度提示、密码历史、紧急访问、账号恢复
- 官方 Bitwarden 客户端全部可用：浏览器扩展、桌面端（Windows/macOS/Linux）、移动端（Android/iOS）
- 数据自持：单机 SQLite，无需外部数据库
- WebSocket 实时同步（默认开启）

## 目录结构

```
vaultwarden/
├── data.yml                       # 根元数据（跨版本共享）
├── logo.png                       # 应用图标
├── README.md                      # 本说明
└── 1.37.5/                        # 当前版本（与镜像 :1.37.5 标签对齐）
    ├── data.yml                   # 版本元数据 + formFields
    ├── docker-compose.yml
    └── data/                      # 持久化占位（.gitkeep）
```

## 安装

1. 1Panel → 应用商店 → 本地应用 → 选择 `vaultwarden`
2. 选择版本 `1.37.5`
3. 主机侧 HTTP 端口默认 `48522`（容器内 `8080`）
4. **访问地址（DOMAIN）** 填实际访问地址，**必须带协议**：
   - 局域网直访：`http://192.168.98.246:48522`
   - 反向代理：`https://vault.example.com`
   - ⚠️ 留空或写成 `vault.example.com`（不带协议）会让上游直接退出，日志报 `DOMAIN variable needs to contain the protocol`
5. **允许注册** 保持 `true`，先注册自己的账号；注册完成后回到 1Panel 把该参数改成 `false` 并重新部署
6. **管理后台口令（ADMIN_TOKEN）** 建议填一个长随机串（`openssl rand -base64 32`）；留空则 `/admin` 管理后台被禁用
7. 提交安装
8. 浏览器访问 `http://<1Panel 主机 IP>:48522` 注册账号（正式使用建议再套一层 HTTPS 反代）

> 💡 **极简安装原则**：本应用仅在 1Panel 表单暴露与本机部署强相关的字段（端口 / 访问地址 / 是否开放注册 / 管理口令 / 日志级别 / 时区 / 运行身份）。SMTP 邮件、SSO/OIDC、附件配额等高级项**不在表单里**，可在启动后用管理后台（`/admin`）或直接编辑 `./data/config.json` 配置。

### ⚠️ 首次部署前必须 chown 数据目录

安装参数 `UID` / `GID` 通过 compose 的 `user:` 指定容器内进程身份，默认 `99` / `100`。官方镜像没有 PUID/PGID 支持（Dockerfile 无 `USER` 指令、`start.sh` 也不做 chown 降权），所以**宿主机挂载目录必须先改属主**，否则容器无权写入、启动即失败：

```bash
# 以应用实际安装目录为准（1Panel → 应用 → vaultwarden → 详情 → 路径）
sudo chown -R 99:100 <应用安装目录>/data
```

- 想以 root 运行：把 `UID` / `GID` 都填 `0`
- 升级到新版本目录后要**重新 chown 一次**（新目录下的 `data` 为空、属主是 root）
- 容器内所有新文件都以该 UID / GID 创建，宿主机上看到属主是 99:100 属正常现象

## 配置

### 表单字段

| 字段 | 默认值（兼浅色提示） | 必填 | 说明 |
|------|---------------------|------|------|
| HTTP 端口 | `48522` | 是 | 主机侧端口，映射到容器内 `8080` |
| 容器内端口 | `8080` | 是 | Rocket 监听端口（非特权端口，配合非 root 身份） |
| 访问地址 | `http://localhost` | 是 | 必须带 `http://` / `https://`；影响 CORS 源、邮件链接、子路径挂载 |
| 允许注册 | `true` | 是 | `true` / `false`；注册完自己的账号后建议改 `false` |
| 管理后台口令 | _空_ | 否 | `/admin` 的访问口令；留空 = 禁用管理后台 |
| 日志级别 | `info` | 是 | `error` / `warn` / `info` / `debug` / `trace` |
| 时区 | `Asia/Shanghai` | 否 | 影响日志时间戳与邮件发送时间 |
| 绑定 IP | `0.0.0.0` | 是 | 反向代理场景保持 `0.0.0.0` |

### 容器内可用环境变量（本表单未暴露的部分）

| 变量 | 说明 |
|------|------|
| `INVITATIONS_ALLOWED` | 是否允许邀请他人注册（上游 1.37 默认 `true`） |
| `ORG_CREATION_ALLOWED` | 是否允许用户自建组织（上游默认 `false`） |
| `SHOW_PASSWORD_HINT` | 是否在登录页显示密码提示（上游默认 `false`） |
| `DISABLE_ADMIN_TOKEN` | 设为 `true` 可彻底关闭 `/admin`（**危险**：管理后台无口令） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_FROM` | 邮件发送（发邀请 / 验证邮件） |
| `DATABASE_URL` | 改用 PostgreSQL / MySQL（默认 SQLite，`db.sqlite3`） |

> 这些变量请通过 `/admin` 管理后台或编辑 `./data/config.json` 配置，不要写进 1Panel 表单（避免明文凭据进入 `docker-compose.yml` 与 `.env`）。

## 数据持久化

| 容器内路径 | 主机侧路径 | 用途 |
|------------|------------|------|
| `/data` | `./data` | `db.sqlite3`（主库）、`config.json`（运行配置）、`rsa_key.pem` / `rsa_key.pub.pem`（加密密钥对）、`attachments/`、`sends/`、`icon_cache/` |

挂载 `./data` 后，**所有保险库数据都在主机侧**，容器重建 / 升级 / 迁移到新主机都不会丢失。

> 🔐 **备份务必带上 `rsa_key.pem` / `rsa_key.pub.pem`**：这两个密钥对用于解密条目，丢了即使有数据库备份也解不开。删除它们会让服务端重新生成，旧数据将无法解密。

## 反向代理要点

1. **必须 HTTPS**：Web 保险库依赖 Web Crypto API，非安全上下文（明文 HTTP 的非 localhost 地址）下浏览器无法使用
2. **必须放行 WebSocket**：`/notifications/hub` 需要 `Upgrade: websocket` 与 `Connection: Upgrade`
3. **DOMAIN 要与公开地址一致**：反代域名与 `DOMAIN` 不一致时，CORS 源匹配会失败（客户端 / 扩展跨域调用被拒）
4. **反代超时**：附件上传上限 525 MB，代理的 `client_max_body_size` / 超时要相应调大

Nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:48522;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket（实时通知）
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

## 镜像更新

本应用使用硬编码 tag（`vaultwarden/server:1.37.5`），由仓库的自动更新工作流检测 DockerHub 新版本并开 PR。手动更新：

```bash
docker pull vaultwarden/server:1.37.5
# 在 1Panel UI 重新部署应用（或：应用商店 → 本地应用 → vaultwarden → 重新部署）
```

上游同时发布 `-alpine` 变体（仅 amd64 / arm64），本应用使用默认 Debian 系镜像。

## 升级与迁移

- **同主机升级**：1Panel UI 重新部署即可。`./data` 是 bind mount，容器重建后数据保留。
- **跨主机迁移**：把 `vaultwarden/1.37.5/data/` 整个目录（含 `rsa_key.pem`）拷到新主机对应路径，再 `chown -R 99:100` 后部署即可。

## 常见问题

| 问题 | 解答 |
|------|------|
| 容器起来就退出，日志报 `DOMAIN variable needs to contain the protocol` | 「访问地址」没填或没带 `http://` / `https://` |
| 容器起来就退出，日志报 `Permission denied` | 数据目录属主不对，执行 `sudo chown -R 99:100 <应用安装目录>/data` |
| 浏览器打开是空白页 / 提示加密相关报错 | 浏览器端需要 HTTPS（安全上下文），用反向代理套一层 TLS |
| 客户端能连上但实时同步不生效 | 反向代理没放行 WebSocket（`Upgrade` / `Connection` 头） |
| 忘记密码 / 忘记管理后台口令 | 密码**不可找回**（端到端加密）；管理后台口令就是 `ADMIN_TOKEN`，可在 `docker-compose.yml` 或 `./data/config.json` 里查回 |
| 想加新用户但注册已关闭 | 临时把「允许注册」改回 `true`，或用管理后台 `/admin` 发邀请 |
| 升级后条目打不开 | 恢复旧的 `rsa_key.pem` / `rsa_key.pub.pem` |

## 安全建议

- Web 保险库只在 **HTTPS** 下使用；明文 HTTP 只适合内网直连或经 VPN 访问
- 关闭公开注册（`SIGNUPS_ALLOWED=false`），改用邀请 / 管理后台添加用户
- `ADMIN_TOKEN` 用长随机串（`openssl rand -base64 32`）；上游支持 Argon2 PHC 哈希形式（`vaultwarden hash` 生成），可在管理后台里填哈希值而非明文
- 主密码是唯一的「根信任」，务必用长且唯一的口令并妥善保管
- 定期备份 `./data`（尤其 `rsa_key.pem`），并把备份加密存放
- 不要提交 `./data/`、`.env` 或任何口令到 Git

## License

AGPL-3.0（上游项目许可证）

## 运行用户 UID / GID

安装参数 `UID` / `GID` 通过 compose 的 `user:` 指定容器内进程身份，默认 `99` / `100`。

⚠️ **首次部署前必须把数据目录属主改到同一 UID / GID**，否则容器无权写入、启动即失败：

```bash
# 以应用实际安装目录为准（1Panel → 应用 → vaultwarden → 详情 → 路径）
sudo chown -R 99:100 <应用安装目录>/data
```

需要 chown 的目录（相对于应用安装目录）：`./data`

- 想以 root 运行：把 `UID` / `GID` 都填 `0`
- 升级到新版本目录后要**重新 chown 一次**（新目录下的 `data` 为空、属主是 root）
- 容器内所有新文件都以该 UID / GID 创建，宿主机上看到属主是 99:100 属正常现象
- 官方镜像没有 PUID / PGID 环境变量支持，**不要**在 compose 里改写成 `PUID` / `PGID`
