# 1Panel Local Apps

自建 1Panel 本地应用仓库，持续维护和自动化更新。

## 应用列表

| 应用 | 说明 | 当前版本 |
|------|------|----------|
| jellyfin | 媒体服务器 | 12.0-rc3 |
| immich | 照片管理 | 3.0.3 |
| moviepilot | 影视自动化 | latest |
| qbittorrent | 下载工具 | latest |
| anirss | 动漫 RSS | latest |
| handbrake | 视频转码 | latest |
| hindsight | AI 记忆系统 | 0.8.4 |
| pgvector | 向量数据库 | latest |
| qdrant | 向量搜索引擎 | latest |
| searxng | 隐私搜索引擎 | latest |
| syncthing | 文件同步 | latest |
| traefik | 反向代理 | latest |
| firecrawl | 网页爬虫 | latest |

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/YOUR_USERNAME/1panel-local-apps.git
cd 1panel-local-apps
```

### 2. 同步到 1Panel

```bash
# 同步所有应用
./scripts/sync-to-1panel.sh

# 只同步指定应用
./scripts/sync-to-1panel.sh jellyfin immich
```

### 3. 检查镜像更新

```bash
./scripts/check-updates.sh
```

## 目录结构

```
├── apps/
│   ├── jellyfin/
│   │   ├── data.yml              # 根元数据
│   │   ├── logo.png              # 应用图标
│   │   ├── README.md
│   │   └── 12.0-rc3/             # 版本目录
│   │       ├── data.yml          # 版本配置 + 表单字段
│   │       └── docker-compose.yml
│   ├── immich/
│   │   └── ...
│   └── ...
├── scripts/
│   ├── sync-to-1panel.sh         # 同步脚本
│   └── check-updates.sh          # 更新检查
└── .github/workflows/
    └── check-updates.yml         # GitHub Actions 自动检查
```

## 自动化更新

### GitHub Actions (推荐)

仓库配置了每周一自动检查所有应用的 Docker 镜像更新。发现新版本时会自动创建 Issue。

启用方法：
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

1. 在 `apps/` 下创建应用目录
2. 添加 `data.yml`、`logo.png`、`README.md`
3. 创建版本目录（如 `latest/` 或 `1.0.0/`）
4. 在版本目录中添加 `data.yml` 和 `docker-compose.yml`
5. 运行 `./scripts/sync-to-1panel.sh <app-name>` 同步

## 更新应用版本

1. 修改 `apps/<app>/<version>/docker-compose.yml` 中的 `image` 标签
2. 提交并推送
3. 运行 `./scripts/sync-to-1panel.sh <app-name>` 同步
4. 在 1Panel UI 中重新部署应用

## 注意事项

- **镜像拉取**: 国内服务器建议配置 Docker 镜像加速器
- **变量引用**: compose 文件中使用 `${IMAGE}` 等变量，通过 `data.yml` 配置默认值
- **数据持久化**: 应用数据目录使用 `./data/...` 相对路径
- **网络**: 所有应用默认使用 `1panel-network` 外部网络

## License

MIT
