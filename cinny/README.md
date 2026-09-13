# Cinny Matrix 客户端

Cinny 是一款**简洁优雅的 Matrix 聊天客户端**，强调易用性与视觉清爽，内置端到端加密（E2EE）、Spaces、话题（Threads）、消息搜索与富媒体支持，可对接任意 Matrix homeserver（matrix.org、Element Cloud、自建 Synapse / Dendrite 等）。

- **GitHub**: <https://github.com/cinnyapp/cinny>
- **官网**: <https://cinny.in>
- **License**: AGPL-3.0
- **上游镜像**: `ghcr.io/cinnyapp/cinny`（GHCR，双架构 amd64 + arm64）

## 功能要点

- 端到端加密（E2EE）：基于 Matrix 的 Olm/Megolm 实现
- 房间、Spaces、私信、话题
- 消息搜索、表情回复、已读回执、附件
- 主题切换、深色模式、多语言（含简繁中文）
- 渐进式 Web 应用（PWA），可"添加到主屏幕"

## 目录结构

本仓库按 1Panel 应用规范组织：

```
cinny/
├── data.yml               # 根元数据（跨版本共享）
├── logo.png               # 应用图标
├── README.md              # 本说明
└── v4.12.6/               # 当前版本
    ├── data.yml           # 版本元数据 + formFields
    ├── docker-compose.yml
    └── data/              # 持久化占位（.gitkeep），可选挂载 config.json
```

## 安装

1. 1Panel → 应用商店 → 本地应用 → 选择 `cinny`
2. 选择版本 `v4.12.6`
3. 主机侧 HTTP 端口默认 `40080`（容器内固定 `80`），按需修改
4. 镜像默认 `ghcr.io/cinnyapp/cinny:v4.12.6`（双架构）
5. **默认 Homeserver 域名** 字段填入你的 Matrix homeserver 域名（默认 `matrix.org`，可改为自建如 `matrix.example.com`）—— **注意：只填域名，不含 `https://`**
6. 提交安装 → 1Panel 会在启动容器前自动执行 `scripts/init.sh`，从 cinny 镜像导出默认 `config.json`，把你填的域名插入到 `homeserverList` 数组开头，并把 `defaultHomeserver` 改为 `0`

部署完成后访问 `http://<1Panel 主机 IP>:<HTTP 端口>` 即可打开 Cinny 登录页（"Homeserver" 字段会预填你配置的域名）。

## 配置

### 默认 homeserver

镜像内置的 `config.json` 默认登录页是 `matrix.org`，`homeserverList` 包含 `converser.eu` / `matrix.org` / `mozilla.org` / `unredacted.org` / `xmr.se` 几个预置 homeserver。Cinny 官方镜像**不接受运行时环境变量**——`homeserverList` 数组在 build 阶段就写死到 dist/config.json 里了。

要让"默认 homeserver"在登录页预选为你自己的域名，流程是：

- compose 把 host `./data/config.json` 挂到容器内 `/app/config.json:ro`
- `scripts/init.sh`（在 1Panel 宿主机跑）首次安装时：
  1. 用 `docker run` 临时起 cinny 镜像，把镜像内 `/app/config.json` 拷到 host `./data/config.json`
  2. 用 `jq`（优先）或 `sed`（兜底）把你填的 **默认 Homeserver 域名** 插入到 `homeserverList[0]`（若已存在则去重后移到首位）
  3. 把 `defaultHomeserver` 字段值改为 `0`（指向新的首位）
- 容器内 nginx 的 `rewrite ^/config.json$ /config.json` 把请求映射到 `/app/config.json`，前端 fetch 即可读到新值

**修改默认 homeserver**：

| 场景 | 步骤 |
| --- | --- |
| 首次安装 | 在 1Panel 表单 **默认 Homeserver 域名** 字段填入新域名（不含 `https://`）→ 提交 |
| 已部署，想换 homeserver | 编辑 `<install_path>/cinny/v4.12.6/data/config.json`：把 `homeserverList[0]` 改成新域名 + `defaultHomeserver` 改为 `0` → 在 1Panel UI 重启 cinny 容器（1Panel 升级/参数更新时不重跑 init.sh，appspec.md 明示） |
| 想彻底清空 | 删除 `<install_path>/cinny/v4.12.6/data/config.json` + 卸载重装（init.sh 会重跑） |

### 其他高级配置

`config.json` 还有 `featuredCommunities` / `hashRouter` / `allowCustomHomeservers` 等字段可调。结构参考 [上游 config.json](https://github.com/cinnyapp/cinny/blob/dev/config.json)。在 host 端 `./data/config.json` 直接编辑保存即可（容器内是只读 bind mount，修改必须改 host 端）。

## 数据持久化

| 容器内路径 | 主机侧路径 | 用途 |
| --- | --- | --- |
| `/app/config.json` | `./data/config.json` | 前端运行时配置（homeserverList / defaultHomeserver / allowCustomHomeservers 等）。由 init.sh 从镜像提取后注入用户填的默认 homeserver |

Cinny 是纯静态前端 SPA，**无服务端状态、无数据库、无用户数据落盘**。所有房间、消息、密钥均存储在你登录的 Matrix homeserver 上，本容器只负责提供 HTML/JS 静态资源。

## 镜像更新

上游使用 GitHub Actions 在每次 release tag 时自动构建 `ghcr.io/cinnyapp/cinny:<tag>`。本应用使用变量型镜像（`${IMAGE}:${APP_VERSION}`），不在 1Panel 自动更新守护范围；如需升级：

1. 1Panel → 本地应用 → Cinny → 升级
2. 选择新版本目录（如 `v4.12.7`，需先在仓库中补出对应版本目录）

镜像源 `ghcr.io/cinnyapp/cinny` 也可通过修改 `IMAGE` formField 切到 DockerHub 同步的 `cinnyapp/cinny` 镜像（内容一致）。

## 常见问题

**Q: 升级后旧登录态丢失？**
A: 不会。登录态加密保存在浏览器 localStorage / IndexedDB，镜像升级不影响。如清理浏览器数据或换设备则需重新登录。

**Q: 容器能访问哪些外网？**
A: 仅浏览器到容器的 80 端口；容器本身无对外网络依赖（除你登录的 homeserver）。

**Q: 与 Synapse / Dendrite homeserver 配套？**
A: 完全可以。本仓库另有 `dendrite` 应用可一起部署。

**Q: 怎么注册账号？有默认账号密码吗？**
A: **Cinny 本身只是 Matrix 客户端，不提供注册/账号管理功能——它只是一个聊天界面**。账号是注册在你登录的 Matrix homeserver 上的，跟 Cinny 容器无关。本容器没有"默认账号密码"，登录页要求你输入已经存在的 Matrix 账号。

按使用场景分三种：

| 场景 | 怎么注册 |
| --- | --- |
| 用 `matrix.org` 公共 homeserver（最省事） | 登录页 Homeserver 选 `matrix.org` → 点"Create account" → 填用户名 / 密码 / 同意条款 → 完成。账号存在 `matrix.org` 公共服务器上 |
| 用本仓库的 `dendrite` 自建 homeserver | 先在本仓库装 `dendrite` 应用并启动 → 登录页 Homeserver 填你的 dendrite 域名（不带 `https://`）→ 如果你配了 `REGISTRATION_SHARED_SECRET`（首次安装 1Panel 表单），用 `register-admin` 或 Element 调用 `/_synapse/admin/v1/register` 走 token 注册；否则登录页通常有"Register"链接直接注册（取决于 dendrite 配的 `registration_disabled`） |
| 用其他自建 homeserver | 在 homeserver 管理界面 / 文档里找注册入口。Cinny 只负责登录已存在的账号 |

登录页输入框说明：
- `Homeserver` — 你的 Matrix 服务器域名（必填）
- `Username` — 完整 Matrix ID（例 `@yourname:matrix.org`）或仅用户名（例 `yourname`，Cinny 会按 Homeserver 自动补全）
- `Password` — 你的 Matrix 账号密码

**Q: 修改默认 homeserver 后没生效？**
A: 三种排查：(1) 浏览器强制刷新（Ctrl+Shift+R / Cmd+Shift+R）清掉 `config.json` 缓存；(2) 确认 host 端 `./data/config.json` 的 `homeserverList[0]` 字段值已改为你想用的域名（不是 `defaultHs` 字段——Cinny v4.12.6 用 `homeserverList` 数组 + `defaultHomeserver` 数组下标）；(3) 1Panel UI 重启 cinny 容器（修改 host 端文件后 bind mount 会自动重新挂载）。

**Q: init.sh 没跑或没生成 config.json？**
A: 检查 1Panel 版本是否 ≥ v2.2.5（支持 init 钩子）。也可手动跑：在 1Panel 宿主机执行 `bash /opt/1panel/apps/local/cinny/cinny/v4.12.6/scripts/init.sh`。

## 许可

- 应用代码 AGPL-3.0（Cinny 上游）
- 本仓库 1Panel 应用定义仅供个人自托管使用
