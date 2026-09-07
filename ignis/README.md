# Ignis

[Ignis](https://github.com/Nystik-gh/ignis) 是一个由社区开发的自托管互操作工具，让你在 **浏览器中直接使用 Obsidian** 笔记应用，免去远程桌面的开销与延迟。它在容器内启动 Obsidian 的 Electron 应用（基于 `node:22-slim` + [`obsidian-headless`](https://github.com/vrtmrz/obsidian-headless)），并通过 Web 端暴露，兼容 Obsidian 桌面端大部分 API 与插件生态。

许可证：**AGPL-3.0**（依据 EU Software Directive 第 6 条，互操作实现，不含 Obsidian 源码）。

## 特性

- **零远程桌面**：浏览器即客户端，无 VNC / RDP / X11 转发开销
- **Obsidian 兼容**：原生支持 .md 笔记、.obsidian 配置、Community Plugins 主题与样式、Canvas、Excalidraw 等
- **多架构镜像**：`nobbe/ignis:0.8.10` 同时提供 amd64 与 arm64
- **首次启动自动下载 Obsidian**：通过 [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases) 拉取指定版本的 `.asar.gz`，并通过 `@electron/asar` 注入
- **离线安装**：支持 `OBSIDIAN_PACKAGE` 指向本地 `.deb` / `.asar.gz` / `.asar` 文件，适配无外网环境

## ⚠️ 重要安全提示

> **Ignis 本身不内置鉴权**。任何能访问到该实例的人都能读、写、删除整个 vault。

部署后请**务必**通过以下方式对外暴露：

1. **反向代理**（1Panel 自带的 OpenResty / Nginx / Caddy / Traefik 均可）+ **HTTPS**（Let's Encrypt 等）
2. 在反向代理层或中间件（Authelia、Authentik、oauth2-proxy 等）开启 **Basic Auth / OIDC** 等鉴权
3. 防火墙仅放行反向代理端口，**不要**将容器 8080 端口直接暴露到公网

## 快速开始

部署完成后，浏览器访问 `http://<服务器IP>:<端口>` 即可（默认端口 8080）。首次启动会从 GitHub 下载 Obsidian 资源，需要 1-2 分钟，请耐心等待 healthcheck 通过。

## 部署参数

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `PANEL_APP_PORT_HTTP` | 是 | `8080` | 宿主机 HTTP 端口（映射到容器 8080） |
| `TZ` | 是 | `Asia/Shanghai` | 容器时区 |
| `PUID` | 是 | `1000` | 容器进程用户 UID，建议与挂载目录属主一致 |
| `PGID` | 是 | `1000` | 容器进程用户 GID，建议与挂载目录属主一致 |
| `OBSIDIAN_VERSION` | 是 | `1.12.7` | 首次启动下载的 Obsidian 客户端版本（需对应 obsidianmd/obsidian-releases 的 release tag） |
| `OBSIDIAN_PACKAGE` | 否 | 空 | 离线安装包路径（.deb / .asar.gz / .asar），留空则自动从 GitHub 下载 |
| `WRITE_COALESCE_MS` | 是 | `1000` | 写盘去抖窗口（毫秒），NFS/SMB 等慢盘可适当增大 |

## 数据持久化

| 容器路径 | 宿主机路径 | 用途 |
|----------|------------|------|
| `/vaults` | `./data/vaults` | Obsidian vault（.md 笔记、.obsidian 配置、Canvas、附件） |
| `/app/data` | `./data/runtime` | 运行时数据（插件状态、同步状态、auth token） |
| `/app/obsidian-app` | `./data/obsidian-app` | 首次启动下载的 Obsidian 资源（持久化避免重复下载） |

> 备份建议：定期备份 `data/vaults` 与 `data/runtime` 两个目录。

## 常见问题

- **健康检查一直 `starting` / 端口访问 502**：首次启动需要从 GitHub 下载 Obsidian 客户端，请等待 1-2 分钟；同时确认容器能访问 `github.com` / `objects.githubusercontent.com`。
- **写入权限报错 `EACCES`**：调整 `PUID` / `PGID` 与宿主机挂载目录的属主一致（`chown -R 1000:1000 ./data`）。
- **想升级 Obsidian 客户端版本**：修改 `OBSIDIAN_VERSION` 为目标版本，重新部署即可；entrypoint 会检测 `/app/obsidian-app/.obsidian-version` 与 `OBSIDIAN_VERSION` 不一致时自动重装。
- **跨版本更新**：`crossVersionUpdate: false`，本版本目录不通过 1Panel UI 自动滚动到 `0.8.10` 之外的新版本；如需升级需手动修改 compose 中的 `image` tag 与版本目录名。

## 官方地址

- 仓库：<https://github.com/Nystik-gh/ignis>
- 文档：<https://ignis.thiefling.com/docs/>
- 演示实例：<https://ignis-demo.thiefling.com>
- Docker 镜像：<https://hub.docker.com/r/nobbe/ignis>
