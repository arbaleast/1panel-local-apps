# LinguaFlow

> 自托管 AI 文档翻译与审校平台（AGPL-3.0）。
> 上游仓库：<https://github.com/MeowSalty/LinguaFlow>
> 官方文档：<https://meowsalty.github.io/LinguaFlow/zh/guide/installation.html>

## 简介

LinguaFlow 是 MeowSalty 开发的开源自托管 AI 文档翻译与审校平台，支持项目管理、术语表（glossary）管理、
翻译审校流程与多格式文档处理。大模型后端（OpenAI / Anthropic / OpenAI 兼容网关等）在 Web 界面里的
「配置中心」按需配置，不进 1Panel 安装表单。

官方镜像默认运行**服务器模式**（`linguaflow serve`，容器内监听 `0.0.0.0:8080`）：多用户、账号体系、
内置嵌入式 Web UI，数据落在本地 SQLite（默认驱动）。

## 许可证

**AGPL-3.0-or-later**。商业分发受上游许可证约束，1Panel 应用商店分发时需注意保留版权与源代码可获得性。

## ⚠️ 部署前必读

服务器模式启动前**必须**提供三项输入，缺一即拒绝启动：

| 输入 | 来源 | 说明 |
|------|------|------|
| JWT 签名密钥 | `scripts/init.sh` 自动生成 | ≥32 字节随机值（十六进制），存于 `./data/secrets/jwt-secret` |
| 凭据加密密钥 | `scripts/init.sh` 自动生成 | 32 字节随机值的 Base64，存于 `./data/secrets/credentials-master-key` |
| 初始管理员 | 1Panel 安装参数 | 「管理员用户名」+「管理员密码」，**管理员密码必填** |

要点：

- **前两项密钥只生成一次**（已存在则绝不覆盖），随 `./data` 持久化。**凭据加密密钥是数据库里所有 AI 密钥的
  解密钥匙**：一旦更换或丢失，已保存的 AI 密钥将无法解密，数据库备份也必须与该密钥一起保存。
- 三项都以 `*_FILE` 形式注入容器（上游原生支持），值只落在宿主机文件里，不出现在容器环境变量中。
- **管理员密码是唯一需要你填的敏感项**：在 1Panel 部署参数页的「管理员密码」里填一个强密码即可。
- 上游对**旧数据目录不兼容**：v0.14 及更早版本创建的数据目录会被拒绝启动；v0.15.0 的数据目录升级到本版本
  需要上游提供的离线迁移工具（不在 Release 产物与 Docker 镜像内）。**新装无此问题**。

## 快速开始

1. 在 1Panel 应用商店搜索 **LinguaFlow** 并安装。
2. 部署参数页填写：
   - **HTTP 端口**：宿主机端口，默认 `8080`（容器内固定 `8080`）
   - **管理员用户名**：默认 `admin`
   - **管理员密码**：必填，自行设置一个强密码
   - **开放注册**：默认 `false`（多用户实例可开启；也可登录后在管理端设置页调整）
   - **日志级别**：默认 `info`
   - **运行用户 UID / GID**：默认 `99` / `100`（见下文「运行用户 UID / GID」）
3. 等待 1-2 分钟：`scripts/init.sh` 会先生成两份密钥文件，再由 1Panel 拉起容器。
4. 访问 `http://<宿主机IP>:<HTTP端口>`，用上面设置的管理员账号登录。
5. 登录后进入「配置中心」添加大模型后端（API Key 写在应用内，不进 1Panel 表单），再创建项目开始翻译。

## 服务端口

| 端口 | 用途 | 暴露策略 |
|------|------|----------|
| 8080 | LinguaFlow Web UI + API（容器内固定） | 对外（`${PANEL_APP_PORT_HTTP}` 映射到宿主机端口） |

> 容器只监听一个端口；反向代理（1Panel 网站 → 反向代理）指向宿主机端口即可。
> 官方文档提示：**通过明文 HTTP + 局域网 IP / 域名访问时，浏览器会禁用文件上传与「复制到剪贴板」**
> （非安全上下文限制）。生产建议经反向代理上 HTTPS。

## 持久化目录

| 容器路径 | 主机路径 | 用途 |
|----------|----------|------|
| `/app/data` | `./data` | 数据根目录（`LINGUAFLOW_DATA_DIR`） |
| `/app/data/linguaflow.db` | `./data/linguaflow.db` | SQLite 数据库（账号、项目、审校记录、AI 密钥密文） |
| `/app/data/cache` | `./data/cache` | 内容缓存 |
| `/app/data/tmp` | `./data/tmp` | 传输与处理工作目录 |
| `/app/data/secrets/jwt-secret` | `./data/secrets/jwt-secret` | JWT 签名密钥（0400，`init.sh` 生成） |
| `/app/data/secrets/credentials-master-key` | `./data/secrets/credentials-master-key` | 凭据加密主密钥（0400，`init.sh` 生成） |
| `/app/data/secrets/bootstrap-admin-password` | `./data/secrets/bootstrap-admin-password` | 初始管理员密码（0400，来自安装参数） |

> 备份 `./data` 时**必须连同 `secrets/` 一起备份**，否则数据库里的 AI 密钥无法解密。

## 环境变量

| 变量 | 必填 | 默认 | 用途 |
|------|------|------|------|
| `PANEL_APP_PORT_HTTP` | 是 | `8080` | 宿主机 HTTP 端口（容器内固定 8080） |
| `TZ` | 是 | `Asia/Shanghai` | 时区 |
| `LINGUAFLOW_BOOTSTRAP_ADMIN_USERNAME` | 是 | `admin` | 初始管理员用户名（仅首次初始化生效） |
| `LINGUAFLOW_BOOTSTRAP_ADMIN_PASSWORD` | **是** | — | 初始管理员密码（仅首次初始化生效；由 `init.sh` 写入密钥文件后以 `_FILE` 注入） |
| `LINGUAFLOW_BOOTSTRAP_REGISTRATION_ENABLED` | 是 | `false` | 首次初始化时是否开放注册（之后可在管理端调整） |
| `LINGUAFLOW_LOG_LEVEL` | 是 | `info` | 日志级别（`debug` / `info` / `warn` / `error`） |
| `UID` | 是 | `99` | 容器内运行用户 UID（compose `user:`） |
| `GID` | 是 | `100` | 容器内运行组 GID（compose `user:`） |

容器内固定注入（compose 硬编码，不由安装参数控制）：

| 变量 | 值 | 用途 |
|------|----|------|
| `LINGUAFLOW_DATA_DIR` | `/app/data` | 数据目录 |
| `LINGUAFLOW_HOST` | `0.0.0.0` | 监听地址（上游 server 模式默认） |
| `LINGUAFLOW_PORT` | `8080` | 监听端口（上游 server 模式默认） |
| `LINGUAFLOW_JWT_SECRET_FILE` | `/app/data/secrets/jwt-secret` | JWT 签名密钥（文件注入） |
| `LINGUAFLOW_CREDENTIALS_MASTER_KEY_FILE` | `/app/data/secrets/credentials-master-key` | 凭据加密主密钥（文件注入） |
| `LINGUAFLOW_BOOTSTRAP_ADMIN_PASSWORD_FILE` | `/app/data/secrets/bootstrap-admin-password` | 初始管理员密码（文件注入） |

## 镜像说明

| 镜像 | 用途 |
|------|------|
| `ghcr.io/meowsalty/linguaflow:0.17.0` | LinguaFlow 官方镜像（多架构：linux/amd64 + linux/arm64 + linux/arm/v7） |

> 上游同时发布 `latest` 与 `sha-*` 浮动/提交号 tag；本应用固定使用**具体版本 tag**，由本仓自动更新守护。

## 常见问题

### Q1：容器一直重启，日志提示缺少密钥或管理员？

A：服务器模式缺三项必需输入即拒绝启动。本应用由 `scripts/init.sh` 自动补齐前两项，**第三项（管理员密码）
必须你在 1Panel 部署参数页填写**。若日志仍报缺密钥，说明 `scripts/init.sh` 没有成功执行（1Panel 会在
部署日志里打印 `[linguaflow-init]` 开头的行），请检查部署日志。

### Q2：忘记管理员密码了？

A：初始管理员密码只在**首次初始化**时写入数据库，之后改密码要走管理端「账号管理」，或者在容器里执行
上游提供的账号恢复命令（容器内已带好同一套环境变量与数据目录，`docker exec` 即可）：

```bash
docker exec <容器名> linguaflow admin recover --help
```

直接删掉 `./data/linguaflow.db` 会连同项目与已保存的 AI 密钥一起清空，**不推荐**。

### Q3：换了密钥 / 丢了 `./data/secrets/` 会怎样？

A：`credentials-master-key` 一旦更换或丢失，数据库里已保存的 AI 密钥**无法解密**（重新填 API Key 即可，
但历史记录里的密钥引用会失效）。这也是本应用坚持把密钥与数据库放在同一个持久化目录里的原因。

### Q4：文件上传按钮点不动 / 复制到剪贴板被禁用？

A：浏览器的「非安全上下文」限制：只有在 HTTPS 或 `localhost` 下才会放开这两个能力。用局域网 IP + 明文
HTTP 访问时会被禁用。经 1Panel 反向代理上 HTTPS 即可解除。

### Q5：能改用 PostgreSQL 吗？

A：上游支持 `LINGUAFLOW_DATABASE_DRIVER=postgres` + `LINGUAFLOW_DATABASE_DSN`，但本应用默认走 SQLite
（零依赖、单容器）。需要高并发时可自行在应用目录的 compose 中追加这两个变量并挂载对应 PG 实例；
注意 DSN 支持 `_FILE` 注入。

### Q6：升级到新版本后数据还在吗？

A：在。1Panel 的版本升级是把新版本文件**增量覆盖**到原安装目录（不覆盖已有文件），`./data` 里的数据库与
`./data/secrets/` 里的密钥都会原样保留。升级后请再确认一次 `./data` 的属主仍是运行用户：

```bash
sudo chown -R 99:100 <应用安装目录>/data
```

### Q7：为什么没有「注册账号」入口？

A：初始注册策略由 `LINGUAFLOW_BOOTSTRAP_REGISTRATION_ENABLED` 决定（默认关闭）。登录管理员账号后，
在管理端「设置」页可以随时开启注册或调整策略。

## 运行用户 UID / GID

安装参数 `UID` / `GID` 通过 compose 的 `user:` 指定容器内进程身份，默认 `99` / `100`。

⚠️ 官方镜像内置的是非 root 用户（`appuser`），本应用改用 `user:` 显式指定身份，**首次部署前必须把数据
目录属主改到同一 UID / GID**，否则容器无权写入、启动即失败：

```bash
# 以应用实际安装目录为准（1Panel → 应用 → LinguaFlow → 详情 → 路径）
sudo chown -R 99:100 <应用安装目录>/data
```

> 本应用的 `scripts/init.sh` 已在部署时自动执行这一步（1Panel 在 `docker compose up` 之前调用它），
> 上面的命令是给「手工 docker compose 部署」或「手工改过 UID / GID」时兜底用的。

- 想以 root 运行：把 `UID` / `GID` 都填 `0`。
- 升级到新版本目录后如果属主被改动，再执行一次上面的 `chown`。
- 容器内所有新文件都以该 UID / GID 创建，宿主机上看到属主是 `99:100` 属正常现象。

## 相关链接

- [上游仓库](https://github.com/MeowSalty/LinguaFlow)
- [官方安装部署文档](https://meowsalty.github.io/LinguaFlow/zh/guide/installation.html)
- [官方配置文件与环境变量](https://meowsalty.github.io/LinguaFlow/zh/guide/configuration.html)
- [官方 CLI 命令参考](https://meowsalty.github.io/LinguaFlow/zh/guide/cli.html)
- [上游 GHCR 镜像](https://github.com/MeowSalty/LinguaFlow/pkgs/container/linguaflow)
