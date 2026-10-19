# 1Panel Local Apps

自建 1Panel 本地应用仓库，持续维护和自动化更新。

## 应用列表

| 应用 | 说明 | 当前版本 |
|------|------|----------|
| anirss | 动漫 RSS | v3.2.49 |
| anythingllm | 本地化 AI 文档问答与 RAG 一体化平台 | 1.16.0 |
| aria2 | 轻量级多协议下载工具 | a2b-stable-25-08-12 |
| bookorbit | 自托管电子书 / 漫画 / 有声书 / PDF 库（KOReader / Kobo 双向同步 + 多用户 + OIDC/SSO） | 3.4.0 |
| cfnb | Cloudflare CDN 节点优选工具 | v1.0.1 |
| cfui | cloudflared WebUI 管理面板 | v0.10.5 |
| cinny | Matrix 聊天客户端 | v4.12.6 |
| dendrite | Matrix 协议新一代 homeserver | v0.15.2 |
| fastnet | FastNet 网络诊断与测速工具 | 0.7.5 |
| firecrawl | 网页爬虫 | 2.11.209 |
| gecoos | 集客 AC 无线控制器，集中管理 AP | v2.2 |
| grimmory | 自托管电子书 / 漫画 / 有声书库（多用户 + KOReader 同步 + BookDrop 入库） | 3.5.0 |
| handbrake | 视频转码 (linuxserver, 单 GUI, P620 NVENC 已验证) | 1.11.2-ls41 |
| handbrake-web | 分布式 HandBrake 转码队列 (TheNickOfTime, ⚠️ heavy dev) | latest |
| hindsight | AI 记忆系统 | 1.0.0 |
| ignis | 在浏览器中运行 Obsidian（无需远程桌面） | 0.8.17 |
| immich | 照片管理 | v3.0.3 |
| infinity | 本地 GPU Embeddings 推理服务 | cu124 |
| jellyfin | 媒体服务器 | 2026091410-arm64 |
| jellystat | 免费的 Jellyfin 开源统计应用（Tautulli 替代品）。 | 1.1.12 |
| kdenlive | 视频剪辑器 (linuxserver Selkies GUI, 媒体目录挂载 + P620 NVENC 加速) | 26.08.2-1-ls224 |
| kiwix-serve | 离线维基百科与 ZIM 内容服务器 | latest |
| linkwarden | Linkwarden 自托管书签管理器 | v2.16.3 |
| llamacpp | 高性能本地 LLM 推理引擎 | server-vulkan-v0.4.7 |
| llamaindex | LLM 数据框架 | v0.9.2 |
| llmwiki | LLM Wiki 知识库（占位应用，详见 README 风险说明） | latest |
| losslesscut | 浏览器内视频/音频无损剪辑 | 3.64.0-v1 |
| marginalia | 本地优先的私人知识库 + LLM 研究代理 | v0.3.8 |
| mediago | 媒体嗅探与下载 | 3.5.0 |
| mihomo | 代理工具 | v1.19.18 |
| mineru | OpenDataLab 开源的 PDF/文档智能解析工具 | 3.4.2 |
| misaka | 御坂网络弹幕服务 | v2.8.9 |
| moviepilot | 影视自动化 | 3.1.5 |
| music-tag-web | 音乐标签刮削与媒体库管理 Web 应用 | 2.7.7 |
| navi-homepage | 轻量级个人导航站（前端可视化编辑 + 零依赖 Node 后端） | v1.2.0 |
| newapi | AI/LLM API 聚合网关 | v1.0.0-rc.40 |
| onenav | PHP + SQLite 3 开发的开源书签 / 导航管理器 | 1.2.4 |
| open-design | Claude Design 开源替代，agent CLI 驱动 | 0.24.1 |
| openreel-video | 浏览器端开源视频剪辑工具 | v0.5.0 |
| openshot | 开源视频剪辑与动画制作 (linuxserver Selkies GUI, 媒体目录挂载 + P620 NVENC 加速, 仅 amd64) | 4.0.1 |
| optimisarr | 媒体库自动转码 (FFmpeg 验证 + 回滚, Plex/Jellyfin/Emby, 仅 amd64) | 0.2.23 |
| perplexica | AI 问答引擎（原 Perplexica） | v1.12.2 |
| personal-todo-vault | 自托管待办与 Markdown 笔记库（SQLite + 邮件提醒 + WebDAV 备份） | latest |
| pgvector | 向量数据库 | 0.8.7-pg18-trixie |
| photopea | 在线图像编辑器 | 2.2 |
| photoprism | 自托管 AI 照片管理（人脸/场景识别 + 地图 + WebDAV） | 260919 |
| qdrant | 向量搜索引擎 | v1.19.2-unprivileged |
| scrob | 自托管媒体追踪（Jellyfin / Plex / Emby 同步） | 2.25.1 |
| searxng | 隐私搜索引擎 | 2026.10.2-a5659a536 |
| silo | pgsty 维护的 S3 兼容对象存储（MinIO 活跃分支 Silo） | RELEASE.2026-08 |
| super-productivity | 高级待办事项应用，支持时间盒与时间追踪 | v19.1.0 |
| syncthing | 文件同步 | 2.1.5 |
| tdarr | Tdarr 媒体库自动转码 (Server + 内置 Node) | 3.00.00 |
| traefik | 反向代理 | v3.6.6 |
| unmanic | 媒体库自动转码 (josh5 镜像, NVIDIA Pascal/P620 NVENC 加速) | 0.4.1 |
| xunlei | cnk3x 维护的迅雷远程下载服务（群晖提取版） | beta |
| zashboard | Mihomo 面板 | latest |

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/YOUR_USERNAME/1panel-local-apps.git
cd 1panel-local-apps
```

### 2. 检查镜像更新

```bash
./scripts/check-updates.sh
```

## 目录结构

```
├── jellyfin/                     # 应用目录直接在仓库根
│   ├── data.yml                  # 根元数据 (key, name, type, description, ...)
│   ├── logo.png                  # 应用图标
│   ├── README.md
│   └── 10.11.11/                 # 版本目录 (名称 = 版本参数)
│       ├── data.yml              # 版本配置 + formFields (环境变量定义)
│       ├── docker-compose.yml
│       └── data/                 # 持久化数据目录 (.gitkeep)
├── immich/
│   └── ...
├── ...                           # 其余应用同结构
├── scripts/
│   └── check-updates.sh          # 更新检查
├── .github/
│   ├── workflows/
│   │   └── auto-update.yml       # 自动检测 hardcode 类应用镜像更新
│   └── scripts/
│       └── detect-updates.mjs    # 检测与文件改写脚本
```

## 自动化更新

### GitHub Actions（自动 PR）

工作流文件：[`.github/workflows/auto-update.yml`](.github/workflows/auto-update.yml)

**触发条件：**
- 每周一 UTC 0 点（cron）
- 手动触发（Actions → auto-update → Run workflow，可选 `apps` 输入指定应用列表，逗号分隔）

**行为：**
- 扫描所有应用的根 `<app>/docker-compose.yml`
- 仅处理 hardcode 类镜像（含 `:tag` 且不含变量）；变量型（`${IMAGE}` / `${APP_VERSION}`）与 `latest` 标签跳过
- 调 Docker Hub API（ghcr.io 用 GitHub Container Registry API）查最新 tag
- 检测到新版本 → 自动开 PR，分支命名 `auto-update/<app>-<yyyy-mm-dd>`
- PR body 列出所有 service 的 `before`/`after` tag
- 同 app 同日已有 open PR → 跳过（防重复）
- PR title 含 `[skip ci]`，防合并后再次触发

**启用方法：**
1. 将仓库推送到 GitHub
2. 在 Settings → Actions → General 中启用 Actions
3. 确保 Workflow permissions 为 "Read and write permissions"

### 手动检查

```bash
# 检查所有应用
./scripts/check-updates.sh

# 检查指定应用
./scripts/check-updates.sh jellyfin
```

## 添加新应用

1. 在仓库根目录创建应用目录（如 `myapp/`）
2. 添加 `data.yml`（根元数据）、`logo.png`、`README.md`
3. 创建版本目录（如 `latest/` 或 `1.0.0/`）
4. 在版本目录中添加 `data.yml`（formFields 定义）和 `docker-compose.yml`
5. 由 1Panel 计划任务同步本地应用

## 更新应用版本

1. 修改 `<app>/<version>/docker-compose.yml` 中的 `image` 标签
2. 提交并推送
3. 由 1Panel 计划任务同步本地应用
4. 在 1Panel UI 中重新部署应用

## 注意事项

- **镜像拉取**: 国内服务器建议配置 Docker 镜像加速器
- **变量引用**: compose 文件中使用 `${IMAGE}` 等变量，通过 `data.yml` 配置默认值
- **数据持久化**: 应用数据目录使用 `./data/...` 相对路径
- **网络**: 所有应用默认使用 `1panel-network` 外部网络
- **运行身份（UID / GID）**: 所有应用都提供运行身份安装参数，默认 `99` / `100`。
  - 镜像原生支持 `PUID` / `PGID` 的应用（`anirss` `aria2` `bookorbit` `handbrake` `ignis` `kdenlive` `misaka` `moviepilot` `openshot` `optimisarr` `syncthing` `tdarr` `unmanic` `xunlei`）用 `PUID` / `PGID` 环境变量，镜像会自动 chown 数据目录，**无需手工处理**。
  - 其余应用用 compose 的 `user: "${UID}:${GID}"`，**首次部署前必须** `sudo chown -R 99:100 <应用安装目录>/data`，否则容器无权写入、启动失败。
  - `pgvector` / `silo` 不提供该参数（Postgres `initdb` 需要 root 初始化 `PGDATA`）。
  - 每个应用 README 的「运行用户 UID / GID」小节有该应用的具体 chown 路径。

## License

MIT
