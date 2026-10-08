# Personal Todo Vault

[Personal Todo Vault](https://github.com/nerkeler/personal-todo-vault) 是一个面向个人与家庭服务器的自托管待办应用。它把待办清单、完成进度、预期完成时间、邮件提醒和 Markdown 笔记放在同一个界面里，运行数据保存为本机 SQLite 数据库和 Markdown 文件；需要异地备份时，可选配坚果云 WebDAV 目录。

- **GitHub**: <https://github.com/nerkeler/personal-todo-vault>
- **官网 / 文档**: <https://github.com/nerkeler/personal-todo-vault>
- **License**: MIT
- **上游镜像**: `nerkeler/todo-app:latest`（Docker Hub，多架构 `linux/amd64` + `linux/arm64`）
- **目录结构**: `latest/` 版本目录（与镜像 `:latest` 标签对齐）

> ⚠️ **关于 `:latest` 标签**：上游 DockerHub 仓库 `nerkeler/todo-app` 只发布 `:latest` 一个 tag（README 中说明：「上游镜像：`nerkeler/todo-app:latest`」），无任何语义化版本 tag。按 AGENTS.md 规定「仅当上游镜像完全无版本化 tag 时方可例外保留 `:latest`」，本应用使用 `latest/` 目录名与之对齐。
>
> ⚠️ **无登录鉴权**：上游 README WARNING 明确「应用目前没有登录、权限管理或多用户隔离。请只部署在本机、可信局域网、VPN，或带身份验证的 HTTPS 反向代理后面；不要直接把 8238 端口暴露到公网。」

## 功能要点

- 任务管理：分类、优先级、进度、完成状态
- 时间与视图：列表 / 日 / 月三种视图；创建时默认今天，也可精确到小时与分钟
- Markdown 笔记：每条待办关联独立 Markdown 笔记，长期任务可积累复盘资料
- 邮件提醒：单次 / 每周 / 指定次数，通过应用内「配置中心」配置 SMTP
- 异地备份：通过应用内「配置中心」配置坚果云 WebDAV；增量上传 + 双向合并
- 本地滚动备份：默认保留最近 10 份 SQLite 备份，写入采用临时文件 + fsync + 原子替换
- 加密配置：SMTP / WebDAV 凭据用 AES-256-GCM 加密落盘到 `/config/config.local.json`，密钥单独保存到 `/config/config.local.key`
- 主题：明暗主题切换 + 响应式布局（移动端长按 / 桌面端右键触发操作菜单）
- 多架构：`linux/amd64` + `linux/arm64`，Node.js 24 Bookworm Slim 基础镜像

## 目录结构

```
personal-todo-vault/
├── data.yml                       # 根元数据（跨版本共享）
├── logo.png                       # 应用图标
├── README.md                      # 本说明
└── latest/                        # 当前版本（与镜像 :latest 标签对齐）
    ├── data.yml                   # 版本元数据 + formFields
    ├── docker-compose.yml
    └── data/                      # 持久化占位（.gitkeep）
```

## 安装

1. 1Panel → 应用商店 → 本地应用 → 选择 `personal-todo-vault`
2. 选择版本 `latest`
3. 主机侧 HTTP 端口默认 `48238`（容器内默认 `8238`，一般无需改）
4. **时区** 默认 `Asia/Shanghai`（输入框内为浅色提示，可改为 `UTC` / `Europe/Berlin` 等任意 IANA 时区名）
5. **允许的 Origin** 留空即可（仅 HTTP 直访时不需要）；如果计划用 HTTPS 反向代理，填反代的公开 origin，例如 `https://todo.example.com`
6. 提交安装
7. 浏览器访问 `http://<1Panel 主机 IP>:<HTTP 端口>`

> 💡 **极简安装原则**：本应用仅在 1Panel 表单暴露 4 个字段（HTTP 端口 / 容器内端口 / 时区 / 允许的 Origin）。SMTP 邮件提醒、坚果云 WebDAV 备份等**敏感配置**通过应用内「配置中心」用 AES-256-GCM 加密保存，**不需要**在 1Panel 表单里填明文凭据。

## 配置

### 表单字段

| 字段 | 默认值（兼浅色提示） | 必填 | 说明 |
|------|---------------------|------|------|
| HTTP 端口 | `48238` | 是 | 主机侧端口，映射到容器内 `8238` |
| 容器内端口 | `8238` | 是 | 应用监听端口（一般无需改） |
| 时区 | `Asia/Shanghai` | 否 | 影响日志与提醒发送（IANA 时区名） |
| 允许的 Origin | _空_ | 否 | HTTPS 反代时填，逗号分隔多 origin；留空 = 仅 HTTP 直访 |

### 应用内「配置中心」（首次启动后访问）

打开 `http://<IP>:<端口>/` → 顶部「设置」→「配置中心」：

- **SMTP**：填写 SMTP host / port / secure / user / pass / from，收件人列表。配置后单次 / 每周 / 指定次数的提醒按规则发到收件人邮箱
- **坚果云 WebDAV**：填写 `https://dav.jianguoyun.com/dav/`、账号、应用密码、备份目录；可执行「立即备份」或「与云端同步」

凭据**不会**以明文形式落盘。`/config/config.local.json` 是密文包，`/config/config.local.key` 是本机密钥，丢失 `key` 文件后即使拿到 `json` 也不能解密。`/config/` 目录务必随主数据一起备份。

## 数据持久化

| 容器内路径 | 主机侧路径 | 用途 |
|------------|------------|------|
| `/data` | `./data` | SQLite (`todo.db`) + Markdown 笔记 (`notes/`) + 本地滚动备份 (`backups/`) |
| `/config` | `./config` | 加密配置 (`config.local.json`) + 本机密钥 (`config.local.key`) |

挂载 `./data` 与 `./config` 后，**所有用户数据都在主机侧**，容器重建/升级/迁移到新主机时不会丢失。

## 镜像更新

`:latest` 标签由作者维护。手动触发：

```bash
docker pull nerkeler/todo-app:latest
# 在 1Panel UI 重启容器（或：应用商店 → 本地应用 → personal-todo-vault → 重新部署）
```

## 升级与迁移

- **同主机升级**：1Panel UI 重新部署即可。`./data` 与 `./config` 是 bind mount，容器重建后数据保留。
- **跨主机迁移**：打包 `personal-todo-vault/latest/data/` 与 `personal-todo-vault/latest/config/` 两个目录，迁到新主机对应路径下。
- **从 WebDAV 恢复**：在新主机完成首次部署并通过应用内「配置中心」配置坚果云 WebDAV 后，使用「与云端同步」将云端快照合并到本地。
- **隔离恢复**（高级）：`TODO_CONFIG_DIR=/config npm run restore -- --output-dir /data/restored-todo`，恢复工具会拒绝覆盖已存在目录，可在切换前预演。

## 常见问题

| 问题 | 解答 |
|------|------|
| 反向代理后跨域报错 | 检查 `TODO_ALLOWED_ORIGINS` 是否填了反代的精确 HTTPS origin（**不能用 `*`**） |
| 忘记了 WebDAV 应用密码 | 在坚果云账户中心撤销旧应用密码并新建一个，再回到应用「配置中心」覆盖 |
| 升级后页面 500 | 查看容器日志 `docker logs <container>`；最常见是 `/data` 目录权限被改 |
| 想清空数据重新开始 | 停止容器 → 删除 `./data/todo.db` 与 `./data/backups/*` → 启动容器 |
| 想保留数据但清空账号 | 停止容器 → 删除 `./config/config.local.json`（保留 `config.local.key`）→ 启动容器 → 「配置中心」重新配置 |

## 安全建议

- 不要把 `8238` 直接暴露到公网（上游 README WARNING）
- 反向代理必须启用 HTTPS + 身份验证（BasicAuth / OIDC / Cloudflare Access 等任选其一）
- 不要提交 `./data/`、`./config/`、`.env` 或任何应用密码到 Git

## License

MIT
