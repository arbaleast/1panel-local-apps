# OpenCloud

> 开源的文件管理 / 分享 / 协作平台（Apache-2.0）。不依赖任何数据库，全部状态都落在本地文件系统上。

| 项目 | 地址 |
|------|------|
| 官网 | https://opencloud.eu/ |
| 文档 | https://docs.opencloud.eu/ |
| 源码 | https://github.com/opencloud-eu/opencloud |
| 部署样例 | https://github.com/opencloud-eu/opencloud-compose |
| 镜像 | `opencloudeu/opencloud-rolling:8.1.0`（DockerHub，`linux/amd64` + `linux/arm64`） |

OpenCloud 单容器即可运行：用户目录（内置 LDAP）、身份提供者（内置 OIDC IDP）、Web 前端、文件传输与分享全部在一个进程里完成，容器内固定监听 **9200** 端口。

---

## ⚠️ 首次安装必读

安装表单里有两个字段必须配对使用，配错了会出现「能打开登录页、但一登录就跳转失败」的现象：

| 表单字段 | 含义 | 怎么填 |
|----------|------|--------|
| **外部访问地址**（`OC_URL`） | 实例的对外 URL，**同时也是内置 IDP 的 OIDC issuer** | 填你浏览器地址栏里真正输入的那个地址，协议 + 主机 + 端口都要一致。例如直连 `https://192.168.1.10:9200`，反代 `https://cloud.example.com` |
| **容器 HTTPS**（`PROXY_TLS`） | 容器自己是否终结 TLS | 直连填 `true`（容器用自签证书提供 HTTPS）；走 1Panel 反向代理回源填 `false`（容器只提供明文 HTTP） |

> `OC_URL` 与浏览器实际访问的地址不一致时，OpenCloud 的登录回调会跳到错误的域名，表现为「登录后一直转圈 / 跳回登录页」。官方文档也强调过这一点。

**首次登录**：用户名 `admin`，密码为安装时填写的「管理员密码」（默认已按 1Panel 规则生成随机值）。

---

## 安装

1Panel → **应用商店** → 搜索 `OpenCloud` → 安装，按上表填好两个字段即可。

容器启动后：

- 健康检查通过后，1Panel 应用页面会显示「运行中」
- 浏览器访问 `https://<你填的地址>`，自签证书会提示「证书不受信任」，点「高级 → 继续前往」即可
- 登录后建议立刻在 **账户设置** 里改掉管理员密码

### 方式 B：1Panel 反向代理（推荐用于公网）

1. 安装时把「容器 HTTPS」设为 `false`，「外部访问地址」填 `https://cloud.example.com`（你的域名）
2. 在 1Panel **网站 → 反向代理** 里新建反向代理，目标地址填 `http://127.0.0.1:9200`
3. 签发一张 Let’s Encrypt 证书并绑定该站点

此时浏览器访问的是 OpenResty 提供的正规证书，不再有自签警告。

> OpenResty 回源是明文 HTTP，容器侧的 `OC_INSECURE=true` 保持默认即可（它只影响容器内部服务之间的证书校验）。

---

## 安装参数说明

| 表单字段 | 环境变量 | 默认值 | 说明 |
|----------|----------|--------|------|
| HTTP 端口 | `PANEL_APP_PORT_HTTP` | `9200` | 主机端口 → 容器 9200 |
| 外部访问地址 | `OC_URL` | `https://localhost:9200` | 对外 URL / OIDC issuer，**必须改成实际访问地址** |
| 容器 HTTPS | `PROXY_TLS` | `true` | `true`=容器自签 HTTPS；`false`=明文 HTTP 供反代回源 |
| 管理员密码 | `IDM_ADMIN_PASSWORD` | 随机 | 仅在**首次** `opencloud init` 时写入配置，之后改这个值无效 |
| 运行用户 UID | `UID` | `1000` | 容器运行身份（见下文「运行身份」） |
| 运行用户 GID | `GID` | `1000` | 同上 |
| 日志级别 | `OC_LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| 时区 | `TZ` | `Asia/Shanghai` | 容器时区 |

其余行为由上游环境变量控制，未在表单暴露：内置 IDP 与内部服务一律使用自签证书，因此固定 `OC_INSECURE=true`；不创建演示用户（`IDM_CREATE_DEMO_USERS=false`）；不启用 Basic Auth 代理（`PROXY_ENABLE_BASIC_AUTH=false`）；不向官方发送更新检查（`FRONTEND_CHECK_FOR_UPDATES=true`，可在 Web UI 内关闭）。

---

## 目录与持久化

| 宿主机路径 | 容器内路径 | 内容 |
|------------|------------|------|
| `./data/config` | `/etc/opencloud` | `opencloud.yaml`（各服务密钥、管理员口令哈希、证书）—— **丢了实例身份就没了，务必备份** |
| `./data/data` | `/var/lib/opencloud` | 用户文件、搜索索引（Bleve）、队列、代理自签证书等 |

两个目录都由 `scripts/init.sh` 在 1Panel 拉起容器前创建并 `chown` 到运行身份。

---

## 运行身份

镜像内置 `USER 1000`（`opencloud-user`），且**不支持** `PUID`/`PGID` 降权，所以运行身份由 compose 的 `user: "${UID}:${GID}"` 指定，默认 `1000:1000`（与镜像内置用户一致）。

- 1Panel 安装时 `scripts/init.sh` 会自动把 `./data` 的属主改成所选的 UID/GID，无需手工处理
- 手工 `docker compose up` 部署时，请先执行：

  ```bash
  chown -R 1000:1000 ./data
  ```

- 若把 UID/GID 改成镜像内置用户以外的值，容器内 `/etc/passwd` 没有对应条目，个别服务解析用户名时会失败，建议保持 `1000:1000`

---

## 升级

1. 应用列表里点「升级」，本仓库的自动更新守护会按上游新 tag 生成新的版本目录（镜像 tag 硬编码在 `docker-compose.yml` 里，由 GitHub Actions 每周检测）。
2. 升级前建议备份整个 `./data` 目录
3. 跨大版本升级（如 7.x → 8.x）请同时查阅对应版本的 [release notes](https://github.com/opencloud-eu/opencloud/releases)，部分版本涉及搜索索引重建等迁移步骤
4. 想换到**稳定线**镜像（`opencloudeu/opencloud`，当前最新 `7.2.4`）而不是 8.x 的 rolling 线，把 `docker-compose.yml` 里的 `image:` 改掉即可

---

## 未包含的可选服务

上游 `opencloud-compose` 里还有一批可选组件，本应用**只部署核心单容器**，需要时自行在同一个 Docker 网络里补上：

| 组件 | 作用 |
|------|------|
| Collabora / EuroOffice | 在线文档编辑（WOPI） |
| Yjs | 多人实时协同编辑 |
| Tika / OpenSearch | 外部全文检索（内置为 Bleve） |
| ClamAV | 病毒扫描 |
| Keycloak | 外部 OIDC 身份提供者（默认用内置 IDP） |
| Radicale | CalDAV / CardDAV |
| MinIO / S3 | 对象存储后端 |
| PostgreSQL | 仅 Keycloak 需要 |

---

## 常见问题

**Q：登录后一直转圈 / 跳回登录页**
A：`OC_URL` 与实际访问地址不一致。改对后需要**重建实例配置**才生效（见下条）或清掉浏览器 Cookie 重试。

**Q：忘记管理员密码**
A：管理员口令只在首次 `opencloud init` 时写进 `/etc/opencloud/opencloud.yaml`。想重新指定，需要停掉容器、删除 `./data/config/opencloud.yaml`（会丢失全部密钥与实例身份）后重新启动，或在 Web UI 的账户设置里修改。

**Q：日志里出现 `config file already exists, use --force-overwrite`**
A：正常现象。compose 的启动命令是 `opencloud init || true; opencloud server`，配置已存在时 `init` 报错被忽略，随后照常启动服务。

**Q：浏览器提示证书不受信任**
A：容器用的是自签证书（`PROXY_TLS=true`）。点「高级 → 继续前往」即可；要消除警告就改走 1Panel 反向代理。

**Q：反代下新建空的文本 / Markdown 文件失败**
A：上游已知问题（opencloud#1594，部分反向代理会剥离 `Content-Length`）。OpenResty 一般不受影响；若遇到，可在反代配置里加 `proxy_request_buffering off;`。

**Q：容器起不来，日志报 `permission denied`**
A：宿主机 `./data` 目录的属主与 UID/GID 不一致。执行 `chown -R 1000:1000 ./data` 后重启。

---

## 许可

OpenCloud 采用 Apache-2.0 许可，源码与商标归 opencloud-eu / OpenCloud GmbH 所有。本仓库中的 compose 与元数据仅用于 1Panel 一键部署。
