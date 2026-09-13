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
5. **默认 Homeserver** 字段填入 Matrix homeserver 地址（默认 `https://matrix.org`，可改为自建如 `https://matrix.example.com`）
6. 提交安装 → 1Panel 会在启动容器前自动执行 `scripts/init.sh`，从 cinny 镜像导出默认 `config.json` 并把 `default_hs` 字段值替换为你填的 homeserver

部署完成后访问 `http://<1Panel 主机 IP>:<HTTP 端口>` 即可打开 Cinny 登录页（默认显示你配置的 homeserver）。

## 配置

### 默认 homeserver

镜像内置的 `config.json` 默认登录页展示 `https://matrix.org`。Cinny 的 `default_hs` 在 build 阶段写入 dist/config.json，官方镜像不读环境变量，所以需要通过 bind mount + init.sh 注入：

- compose 把 `./data/config.json` 挂到容器内 `/app/config.json:ro`
- `scripts/init.sh`（在 1Panel 宿主机跑）首次安装时从 cinny 镜像导出默认 `config.json` 到 host `./data/config.json`，再用 `jq` / `sed` 把 `default_hs` 字段值替换为你在 1Panel 表单填的 **默认 Homeserver**
- 容器内 nginx 的 `rewrite ^/config.json$ /config.json` 把请求映射到 `/app/config.json`，前端 fetch 即可读到新值

**修改默认 homeserver**：

| 场景 | 步骤 |
| --- | --- |
| 首次安装 | 在 1Panel 表单 **默认 Homeserver** 字段填入新地址 → 提交 |
| 已部署，想换 homeserver | 编辑 `<install_path>/cinny/v4.12.6/data/config.json`，把 `default_hs` 改成新地址 → 在 1Panel UI 重启 cinny 容器（1Panel 升级/参数更新时不重跑 init.sh，appspec.md 明示） |
| 想彻底清空 | 删除 `<install_path>/cinny/v4.12.6/data/config.json` + 卸载重装（init.sh 会重跑） |

### 其他高级配置

`config.json` 还有 `features` / `explore` / `brand` / `permalinkPrefix` 等字段可调。结构参考 [上游 config.json](https://github.com/cinnyapp/cinny/blob/dev/config.json)。在 host 端 `./data/config.json` 直接编辑保存即可（容器内是只读 bind mount，修改必须改 host 端）。

## 数据持久化

| 容器内路径 | 主机侧路径 | 用途 |
| --- | --- | --- |
| `/app/config.json` | `./data/config.json` | 前端运行时配置（由 init.sh 从镜像提取后注入 default_hs） |

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

**Q: 修改默认 homeserver 后没生效？**
A: 三种排查：(1) 浏览器强制刷新（Ctrl+Shift+R / Cmd+Shift+R）清掉 `config.json` 缓存；(2) 确认 host 端 `./data/config.json` 的 `default_hs` 字段值已改；(3) 1Panel UI 重启 cinny 容器（修改 host 端文件后 bind mount 会自动重新挂载）。

**Q: init.sh 没跑或没生成 config.json？**
A: 检查 1Panel 版本是否 ≥ v2.2.5（支持 init 钩子）。也可手动跑：在 1Panel 宿主机执行 `bash /opt/1panel/apps/local/cinny/cinny/v4.12.6/scripts/init.sh`。

## 许可

- 应用代码 AGPL-3.0（Cinny 上游）
- 本仓库 1Panel 应用定义仅供个人自托管使用
