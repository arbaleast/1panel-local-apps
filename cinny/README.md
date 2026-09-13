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
5. 提交安装

部署完成后访问 `http://<1Panel 主机 IP>:<HTTP 端口>` 即可打开 Cinny 登录页。

## 配置

### 默认 homeserver

镜像内置的 `config.json` 默认登录页展示 `https://matrix.org`。如需改为自建 homeserver（如 `https://matrix.example.com`），有几种方案：

**方案 A：使用 1Panel 反代重写 `/config.json`（推荐，无需改镜像）**

如果你在 1Panel 站点已经接入了 OpenResty / Traefik 反代，在代理层拦截 `/config.json` 返回自定义 JSON 即可，结构参考 [上游 config.json](https://github.com/cinnyapp/cinny/blob/dev/config.json)：

```json
{
  "default_hs": "https://matrix.example.com",
  "features": {},
  "explore": {
    "spaces": ["!roomid:matrix.example.com"],
    "homeservers": ["https://matrix.example.com"]
  },
  "brand": "Cinny",
  "permalinkPrefix": "https://matrix.to"
}
```

**方案 B：在浏览器登录页手动指定 homeserver**

打开 Cinny → 在登录页"其他 homeserver"输入框手动输入 `https://matrix.example.com` → 登录。Cinny 会把用户上次输入的 homeserver 缓存在浏览器 `localStorage` 中。

**方案 C：fork 仓库自行 rebuild 镜像**

修改 `config.json` 后 `docker build` 自定义镜像，把 formField `IMAGE` 设为你的私有仓库地址。

> 早期方案是"挂载自定义 config.json"（mount `./data/config.json` 到容器 `/app/config.json`），但 1Panel compose schema 不允许 volumes 块为空，且每次挂载空 config.json 会覆盖镜像内默认文件，行为不直观。本仓库改用以上更友好的方案。

## 数据持久化

| 容器内路径 | 主机侧路径 | 用途 |
| --- | --- | --- |
| `/app/.local-share` | `./data` | 容器内一个不影响业务的占位路径（镜像内不存在），让 1Panel schema 校验通过 |

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

**Q: 默认 config.json 改了不生效？**
A: 前端 fetch `/config.json` 是按 URL 缓存的，强制刷新（Ctrl+Shift+R / Cmd+Shift+R）即可。

## 许可

- 应用代码 AGPL-3.0（Cinny 上游）
- 本仓库 1Panel 应用定义仅供个人自托管使用
