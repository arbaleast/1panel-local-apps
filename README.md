# 1Panel Local Apps

自建 1Panel 本地应用仓库，持续维护和自动化更新。

## 应用列表

| 应用 | 说明 | 当前版本 |
|------|------|----------|
| anirss | 动漫 RSS | latest |
| anythingllm | 本地化 AI 文档问答与 RAG 一体化平台 | latest |
| fastnet | FastNet 网络诊断与测速工具 | latest |
| firecrawl | 网页爬虫 | latest |
| handbrake | 视频转码 | latest |
| hindsight | AI 记忆系统 | latest |
| immich | 照片管理 | latest |
| jellyfin | 媒体服务器 | latest |
| llamacpp | 高性能本地 LLM 推理引擎 | latest |
| llamaindex | LLM 数据框架 | latest |
| mediago | 媒体嗅探与下载 | latest |
| mihomo | 代理工具 | latest |
| moviepilot | 影视自动化 | latest |
| perplexica | AI 问答引擎（原 Perplexica） | latest |
| pgvector | 向量数据库 | latest |
| qdrant | 向量搜索引擎 | latest |
| searxng | 隐私搜索引擎 | latest |
| syncthing | 文件同步 | latest |
| traefik | 反向代理 | latest |
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

## License

MIT
