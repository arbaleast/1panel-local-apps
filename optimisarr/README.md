# Optimisarr — 1Panel 本地应用

基于 [Jellman86/optimisarr](https://github.com/Jellman86/optimisarr) 的**安全优先**自托管 FFmpeg 媒体库优化器，专为 Plex / Jellyfin / Emby 设计。

> **核心特性：在替换原文件之前会做多重验证（流保留、时长、码率、画质）**，原文件不立即删除，而是进入隔离区可回滚。

- 上游 GitHub: [Jellman86/optimisarr](https://github.com/Jellman86/optimisarr)
- 上游镜像: [ghcr.io/jellman86/optimisarr](https://github.com/Jellman86/optimisarr/pkgs/container/optimisarr)
- 许可证: **GPL-3.0**

## 访问

部署完成后访问 Web UI（1Panel 表单填写的 `Web UI 端口`，默认 `8787`）：

```
http://<主机IP>:<Web UI 端口>
```

健康检查端点：`http://<主机IP>:<Web UI 端口>/api/ready`

## 架构与版本

- **仅支持 `linux/amd64`**：上游 GHCR 镜像仅发布 `linux/amd64` 架构（基于 `mcr.microsoft.com/dotnet/aspnet:10.0` + `jellyfin-ffmpeg7`，均为 Debian amd64）。1Panel 安装时若主机为 arm64/v7 会出现镜像拉取失败。
- **首个发布版本**: `0.2.22`（与上游 GHCR tag 一致，无 `v` 前缀）。
- **停止宽限期**: `2h5m`（上游推荐值，保证长时间 FFmpeg 转码能完整结束不被中断）。

## 数据目录

| 容器内路径 | 挂载来源 | 用途 |
|---|---|---|
| `/config` | `./data/config` | 配置 + SQLite 数据库 |
| `/data` | `./data/media` | 媒体库根 + WORK/TRASH 隔离区 |

> **重要**：将你的视频文件放到 `./data/media/` 下的子目录中（如 `data/media/Movies/`、`data/media/TV/`）。Optimisarr 会扫描此根目录做转码。WORK_DIR 与 TRASH_DIR 默认位于 `/data/.optimisarr/` 下，**会随此挂载一起持久化**。
>
> 转码工作目录与隔离区**必须**与媒体库在同一父目录下，否则 Optimisarr 不能保证原子移动（atomic move）路径，会自动回退到"已验证"的较慢路径。

## 常用配置

| 字段 | 含义 | 默认 |
|---|---|---|
| `Web UI 端口` | 浏览器访问端口 | `8787` |
| `时区 (TZ)` | 容器时区 | `Asia/Shanghai` |
| `运行用户 UID (PUID)` | 容器内运行用户 UID | `1000` |
| `运行用户 GID (PGID)` | 容器内运行用户 GID | `1000` |
| `日志级别` | ASP.NET Core 日志级别 | `Information` |
| `Render 组 GID (Intel/AMD GPU)` | 宿主机 `render` 组的 GID（仅硬件加速需要） | `107`（可留空） |

> **PUID/PGID 默认 `1000` 而不是 `0`**：上游 entrypoint.sh 会用 `PUID/PGID` 自动创建 `optimisarr` 用户/组并将 `/config` 改成该用户所有。如需 root 运行改为 `0`。

## 硬件加速

Optimisarr 内置 `jellyfin-ffmpeg7`（含 Intel iHD、oneVPL 加速）和 VMAF 评估工具，可选用以下硬件加速：

- **CPU**（默认，无需任何配置）
- **Intel QSV**（Intel iGPU 如 N100 / UHD 核显）
- **VA-API**（Intel / AMD GPU）
- **NVIDIA NVENC**（需额外启用 nvidia runtime，上游 compose 中通过注释切换）

### 启用 Intel/AMD GPU 加速

1. 宿主机加载 `/dev/dri` 设备（`ls -la /dev/dri` 确认存在）
2. 确认宿主机 `render` 组的 GID：

   ```bash
   getent group render | cut -d: -f3
   # 常见值: 107 (Debian/Ubuntu), 44 (某些发行版), 109 (Fedora)
   ```

3. 编辑 `optimisarr/0.2.22/docker-compose.yml`，取消以下 3 行注释：

   ```yaml
   devices:
     - /dev/dri:/dev/dri
   group_add:
     - ${RENDER_GID}
   ```

4. 在 1Panel 应用「更新」页面把 `Render 组 GID (Intel/AMD GPU)` 填成宿主机实际的 GID（默认 107）。

### 启用 NVIDIA NVENC

NVIDIA GPU 需要在 compose 中添加 `runtime: nvidia` 并暴露 `NVIDIA_VISIBLE_DEVICES` / `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`（**必须包含 `video` 才能加载 `libnvidia-encode.so`**）。本应用默认 compose 暂未启用 NVIDIA runtime，请按上游 [`compose.nvidia.example.yml`](https://github.com/Jellman86/optimisarr/blob/main/compose.nvidia.example.yml) 修改后再部署。

## Plex / Jellyfin / Emby 集成

部署完成后，在 Optimisarr Web UI 的 **Settings → Integrations** 中填入你的媒体服务器地址与 API Key：

- **Plex**: `http://<PlexIP>:32400` + Plex Token
- **Jellyfin**: `http://<JellyfinIP>:8096` + API Key
- **Emby**: `http://<EmbyIP>:8096` + API Key

配置完成后，Optimisarr 会：

- 在 Plex/Jellyfin/Emby 正在串流时**自动暂停**对应媒体文件的处理
- 处理完成后向 Plex/Jellyfin/Emby 触发**元数据刷新**让新转码文件立即可见

## Sidecar Worker（可选）

Optimisarr 支持将视频编码分发给配对的 macOS / Windows / Linux 端侧 worker sidecar。本应用当前**仅启用 Server 主服务**；如需启用 sidecar，请按上游 [`compose.sidecar.example.yml`](https://github.com/Jellman86/optimisarr/blob/main/compose.sidecar.example.yml) 在 Server 端补充 sidecar 服务（额外占用 8788 端口）。

## 安全说明

- Optimisarr 默认**无 Web UI 鉴权**。如需在公网暴露：
  - 部署反向代理（Traefik / Caddy / Nginx）启用 HTTPS
  - 在反向代理上挂 Authelia / oauth2-proxy / Cloudflare Access
- Optimisarr 会**直接读写挂载的媒体目录**。`/data/.optimisarr/trash` 中的隔离文件会在你点击"确认替换"后被删除；建议先保留若干个版本以防误判。

## 文件

```
optimisarr/
├── data.yml              # 根元数据
├── logo.png              # 应用图标 (BrandMark.png from upstream)
├── README.md             # 本文件
└── 0.2.22/
    ├── data.yml          # 版本配置 + formFields
    ├── docker-compose.yml
    └── data/             # 持久化数据目录 (.gitkeep)
```

## 更新

Optimisarr 通过 `auto-update` 工作流每周一自动检测 GHCR 新版本（hardcode 镜像形式）。检测到新 tag 后会自动开 PR 合并。

如需手动升级：把 `optimisarr/<旧版本>/` 整个目录复制为 `optimisarr/<新版本>/`，修改 `docker-compose.yml` 中的 `image: ghcr.io/jellman86/optimisarr:<新版本>`，然后在 1Panel UI 中选择新版本重新部署。

## 运行用户 UID / GID

安装参数 `PUID` / `PGID` 指定容器内进程的用户 / 组身份，默认 `99` / `100`。

镜像的启动脚本会以 root 身份先 `chown` 自己的数据目录、再降权运行，
**不需要手工 chown 宿主机目录**。

- 改这两个值 → 容器内新建文件的属主随之改变（镜像会自动把数据目录 chown 到该 UID/GID）
- 想以 root 运行：把 `PUID` / `PGID` 都填 `0`
- 宿主机挂载的外部目录（媒体库等）不在镜像的 chown 范围内，需保证该 UID/GID 可读
