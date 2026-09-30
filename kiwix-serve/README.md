# Kiwix Serve

[Kiwix](https://kiwix.org) 官方维护的离线 ZIM 内容服务器，提供维基百科、维基词典、TED 演讲、医学资料等任意 `.zim` 格式内容的 HTTP 访问。面向低带宽、离线优先的知识访问场景。

- **GitHub**: <https://github.com/kiwix/kiwix-tools>
- **官网**: <https://kiwix.org>
- **License**: GPL-3.0
- **上游镜像**: `ghcr.io/kiwix/kiwix-serve:latest`（GHCR，单架构 amd64）
- **目录结构**: `latest/` 版本目录（与镜像 `:latest` 标签对齐）

> ⚠️ **关于 `:latest` 标签**：本应用按用户要求固定使用 `ghcr.io/kiwix/kiwix-serve:latest`。上游虽然同时发布 `3.1.x` / `3.2.x` / `3.3.x` / `3.4.x` / `3.5.x` / `3.6.x` / `3.7.x` / `3.8.x` 等语义化 tag（最新 `3.8.2`），但 `latest` 始终指向最新稳定版，由 Kiwix 官方维护。如需固定到具体版本，请手动改 compose 中 `image: ghcr.io/kiwix/kiwix-serve:<version>`。

## 功能要点

- 全文检索：基于 Xapian 的文章、标题、正文全文搜索
- 资源索引：`/` 路径返回 library index 列出所有 ZIM
- 内置阅读器：HTML / 图片 / 视频 / PDF 等内容类型由 kiwix-serve 直接渲染
- 多 ZIM 联合：单实例可服务任意数量的 `.zim` 文件
- 离线优先：镜像基于 alpine:3.22 + kiwix-tools 多架构二进制，体积小
- 非 root：容器内以 UID 1001 运行

## 目录结构

```
kiwix-serve/
├── data.yml                 # 根元数据（跨版本共享）
├── logo.png                 # 应用图标
├── README.md                # 本说明
└── latest/                  # 当前版本（与镜像 :latest 标签对齐）
    ├── data.yml             # 版本元数据 + formFields
    ├── docker-compose.yml
    └── data/                # 持久化占位（.gitkeep）
        └── zim/             # 用户放置 .zim 文件的目录
```

## 安装

1. 1Panel → 应用商店 → 本地应用 → 选择 `kiwix-serve`
2. 选择版本 `latest`
3. 主机侧 HTTP 端口默认 `48080`（容器内默认 `8080`，可按需调整）
4. **ZIM 文件** 字段默认 `*.zim`（通配符，匹配容器内 `/data` 下所有 ZIM 文件）
5. **ZIM 下载地址**（可选）填入远程 `.zim` 文件 URL，留空则仅服务本地文件
6. **时区** 默认 `UTC`
7. 提交安装
8. 安装完成后，把 `.zim` 文件放到主机侧的 `./data/zim/` 目录下，然后**重启容器**让 kiwix-serve 重新扫描

部署完成后访问 `http://<1Panel 主机 IP>:<HTTP 端口>` 即可看到 library index，点击任一 ZIM 进入阅读。

## 配置

### 表单字段

| 字段 | 默认值 | 必填 | 说明 |
|------|--------|------|------|
| HTTP 端口 | `48080` | 是 | 主机侧端口，映射到容器内 `8080` |
| 容器内端口 | `8080` | 是 | kiwix-serve 监听端口（一般无需改） |
| ZIM 文件 | `*.zim` | 是 | 容器内 `/data` 下的文件路径（空格分隔多个，支持 `*.zim` 通配） |
| ZIM 下载地址 | _空_ | 否 | 启动时 wget 该 URL 到 `/data` |
| 时区 | `UTC` | 否 | 影响 start.sh 内 wget 日志等时间戳 |

### 模式一：本地 ZIM 文件

最常见用法。准备 `.zim` 文件 → 放到 `data/zim/` → 启动容器。

```bash
# 1. 把 ZIM 文件复制到持久化目录
cp ~/Downloads/wikipedia.zim /opt/1panel/apps/kiwix-serve/latest/data/zim/

# 2. 在 1Panel UI 重启 kiwix-serve 容器（首次安装会自动启动）
# 3. 浏览器访问 http://<IP>:<端口>，library index 会列出 wikipedia.zim
```

支持的 ZIM 内容（参考 [library.kiwix.org](https://library.kiwix.org/)）：Wikipedia 各国语言版、Wiktionary、Ted Talks、Wikisource、Stack Exchange、医学资料（WHO / PubMed）、IT 文档（Arch Wiki / Ubuntu Docs）、古登堡计划电子书等。ZIM 文件通常从 [Kiwix Library](https://library.kiwix.org/) 下载。

### 模式二：远程 ZIM 文件

无需手动下载，让容器在首次启动时自动 wget：

1. 1Panel UI 表单 **ZIM 下载地址** 字段填入完整 URL，例如：
   - `https://library.kiwix.org/zim/wikipedia/wikipedia_zh_all_maxi_2024-08.zim`
   - `https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_mini_2024-08.zim`
2. **ZIM 文件** 字段可填入通配符 `*.zim` 或留空（start.sh 会自动追加下载文件名）
3. 提交安装 → 容器启动 → start.sh 检测到 DOWNLOAD 变量 → wget 到 /data → 启动 kiwix-serve

> 💡 ZIM 文件通常较大（Wikipedia 全语种 mini 版 > 80GB，maxi 版更大），下载需时较长。确保主机磁盘空间充足。

### 模式三：多个 ZIM 文件

在 **ZIM 文件** 字段填入空格分隔的具体文件名：

```yaml
ZIM_FILES: wikipedia_zh_all_maxi_2024-08.zim wiktionary_zh_all_2024-08.zim
```

也可以混合通配与具体：

```yaml
ZIM_FILES: wikipedia_*.zim
```

### 修改配置

| 场景 | 步骤 |
|------|------|
| 添加新 ZIM 文件 | 复制 `.zim` 到 `./data/zim/` → 1Panel UI 重启容器 |
| 切换为远程下载 | 在 1Panel UI 修改 **ZIM 下载地址** 字段 → 提交（会触发重新创建容器） |
| 修改监听端口 | 在 1Panel UI 修改 **容器内端口** → 同时改 **HTTP 端口** 保持映射一致 |

## 数据持久化

| 容器内路径 | 主机侧路径 | 用途 |
|------------|------------|------|
| `/data` | `./data/zim` | ZIM 内容库（kiwix-serve 直接服务此目录） |

kiwix-serve 本身**无状态**（无数据库、无用户数据落盘），所有 ZIM 文件按文件名只读服务。容器重启/升级不会丢失数据。

## 镜像更新

`:latest` 标签由 Kiwix 官方维护，容器每次启动会拉取最新镜像。手动触发更新：

```bash
docker pull ghcr.io/kiwix/kiwix-serve:latest
# 1Panel UI → 应用 → kiwix-serve → 重启
```

如需固定到具体版本（如 `3.8.2`），编辑 `latest/docker-compose.yml`：

```yaml
image: ghcr.io/kiwix/kiwix-serve:3.8.2
```

## 参考

- [kiwix-serve 官方文档](https://github.com/kiwix/kiwix-tools/tree/main/docker/server)
- [kiwix-serve 启动参数](https://github.com/kiwix/kiwix-tools#command-line-options)
- [Kiwix Library（ZIM 下载）](https://library.kiwix.org/)
- [openzim 容器组织](https://github.com/openzim)
