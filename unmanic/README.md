# Unmanic 媒体库自动转码

[Unmanic](https://unmanic.app) 是一个轻量级、插件驱动的媒体库自动转码调度器。
监控媒体库目录，把不符合预设格式的文件丢进 FFmpeg 转码队列。
Web UI 配置 worker / library / plugin，无需手动调度。

## 镜像

`josh5/unmanic:0.4.1`（2026-08-14 上游 release）。
DockerHub 实际发布 `latest` + staging + 0.2.4 ~ 0.4.1 等版本化 tag，本应用固定到 `0.4.1`。

## 访问

- Web UI: `http://<host>:<PANEL_APP_PORT_HTTP>/`，默认端口 `8888`

## 用途

- 媒体库自动转码（FFmpeg 后端, 插件驱动流水线）
- 文件移动 / 改名 / 自定义命令（按时间戳 / 文件大小 / 扩展名）
- 多 worker 并行处理 + inotify 实时监控 + 定时扫描
- NVENC/NVDEC 硬件加速（NVIDIA 显卡, 包括 Pascal 架构如 P620）

## GPU 加速（NVIDIA Pascal/P620 适配）

本应用支持 NVIDIA 硬件转码（NVENC/NVDEC）。
**NVIDIA P620** 属于 Pascal 架构（Compute Capability 6.1, GP107GL 核心, 4× Mini-DP 1.4）,
NVENC 自 Kepler 时代起 Pascal 已支持 H.264/H.265 硬件编码, P620 配 4× NVENC 单元
适合多 worker 并发硬件转码。

### 前置要求

1. 宿主机已安装 NVIDIA 驱动（Pascal 最低 **R495**, 推荐 470.x/535.x LTS 分支）
2. 宿主机已装 [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)，
   并在 `/etc/docker/daemon.json` 配置 `"default-runtime": "nvidia"` 或在使用时手动指定
3. 在 1Panel UI 将 **NVIDIA_ENABLE** 切到 `true`，并把 **NVIDIA_VISIBLE_DEVICES** 填成
   `all`（默认）/ 具体 GPU 编号 / GPU UUID

### NVIDIA_ENABLE 主开关

| 值 | 行为 |
|---|---|
| `false`（默认） | 禁用 NVIDIA GPU，容器可在无 GPU 宿主机直接启动 |
| `true` | 启用 NVIDIA 硬件加速（需宿主机 NVIDIA 驱动 + Container Toolkit） |

### NVIDIA_VISIBLE_DEVICES

| NVIDIA_ENABLE | NVIDIA_VISIBLE_DEVICES | 效果 |
|---|---|---|
| `false` | 任意值 | 仅 CPU，GPU 不参与转码 |
| `true` | `all`（默认） | 使用全部 GPU |
| `true` | `0` / `GPU-xxx-...` | 使用指定编号 / UUID 的 GPU |

### NVIDIA_DRIVER_CAPABILITIES

`compute,video,utility`（默认）：

- `compute`: 暴露 CUDA runtime + `libcuda.so`
- **`video`: 暴露 NVDEC + NVENC（FFmpeg `h264_nvenc` / `hevc_nvenc` 关键）**
- `utility`: 暴露 `nvidia-smi` / `nvidia-cuda-mps-control` 等工具

不要省略 `video`，否则 FFmpeg 看不到 NVENC 编码器。

### NVIDIA_PATCH_VERSION

可选；用于老驱动兼容。
- 留空：使用 NVIDIA 容器自带的 `libnvidia-container-tools` 默认版本（**推荐**）
- 填具体版本号（如 `535.183.06`）：当宿主机驱动 < 535 且镜像默认 libnvidia 不兼容时手动指定

> ⚠️ **P620 Pascal 4K H.264 B 帧 8 限制**：
> Pascal 架构的 NVENC 编码 H.264 时 B 帧最大参考数被 NVIDIA 限制为 8，
> 在 4K 高码率场景下可能限制编码质量。
> 解决方案：在宿主机跑 [github.com/keylase/nvidia-patch](https://github.com/keylase/nvidia-patch)，
> 它会 patch 容器内 `libnvidia-encode.so` 解除限制。
> 1Panel 不直接支持（需宿主机 root），请按该仓库 README 操作。
> 本参数**不是 nvidia-patch 注入**——它只是 NVIDIA 容器 libnvidia 库的 patch 版本选择器。

### 设备权限

compose 中已默认配置 `device_cgroup_rules: ['c 195:* rw']`，授予容器访问 NVIDIA 字符设备
（主设备号 195，即 `/dev/nvidia*`）的 cgroup 权限。配合 NVIDIA Container Toolkit，
容器内即可正常访问 GPU 设备节点。

### 验证 GPU 是否可用

```bash
# 确认设备节点存在
docker exec <container_name> ls /dev/nvidia*

# 确认 nvidia-smi 可执行
docker exec <container_name> nvidia-smi

# 确认 FFmpeg 看到 nvenc 编码器
docker exec <container_name> ffmpeg -hide_banner -encoders | grep nvenc
```

应能看到 `h264_nvenc` / `hevc_nvenc` 等条目。

### 在 Unmanic Web UI 启用 NVENC

1. Web UI → Settings → Plugins → "Install Plugin From Repo"
2. 搜索 `transcode`，安装 "**Transcode Video Files**" 插件
3. 打开 Transcode Video Files 的 Settings，把 Video Encoder 切到 `h264_nvenc`（或 `hevc_nvenc`）
4. Workers 页面调整 worker 数；P620 推荐 2-4 worker（每 worker 占 1 个 NVENC 上下文）

## 媒体库挂载

本应用提供 4 个独立库挂载点（与 unraid 社区模板一致）：

| formField | 容器内路径 | 推荐填法 |
|---|---|---|
| LIBRARY_MOVIES | `/library/movies` | 宿主机电影库绝对路径 |
| LIBRARY_TV | `/library/tv` | 宿主机电视剧库绝对路径 |
| LIBRARY_MUSIC | `/library/music` | 宿主机音乐库绝对路径 |
| LIBRARY_PICTURES | `/library/pictures` | 宿主机图片库绝对路径 |

> **必填项 = 0**：4 个库**全部留空**也允许。Unmanic 启动后可在 Web UI 内手动添加 Library
> 路径（路径必须是容器内可访问的绝对路径，如 `/${HOST_PATH_BINDPATH}/xxx`）。
> 但生产环境推荐提前 bind mount，否则 Web UI 加 Library 也看不到宿主目录。
>
> **相对路径**（如 `./data/movies`）在本应用**不被推荐**：
> Unmanic 进程需要直接读写这些目录，相对路径要靠 1Panel 自动解析，
> 跨平台/跨主机迁移时容易出现权限错位。生产环境请用宿主机**绝对路径**。

## 缓存

`CACHE_PATH`（默认 `./data/cache`）是 Unmanic 处理中转码任务的临时工作区。
**务必放在高速盘**（NVMe SSD / tmpfs）。
**规划公式**：
- 假设单文件平均 10 GB、3 个 worker 同时工作
- 所需缓存空间 ≈ `10 GB × 2 × 3 = 60 GB`（每 worker 最多同时保留输入 + 输出两份）
- 缓存满 = 转码任务直接 fail

### 用 tmpfs 当缓存（推荐）

如果宿主机内存充足，把缓存放到 tmpfs：

```bash
# 创建 32G tmpfs
mount -t tmpfs -o size=32G tmpfs /mnt/unmanic-cache
```

然后 1Panel UI 把 CACHE_PATH 填 `/mnt/unmanic-cache`。

> ⚠️ **注意**：tmpfs 内容**重启即失**。Unmanic 重启不会丢进度（DB 在 CONFIG_PATH），
> 但容器崩了 tmpfs 里没写完的转码文件就清掉了。建议 **NVMe SSD + 充足空间**。

## 与本仓 Tdarr 的关系

- **Unmanic**: 单一 FFmpeg 后端 + 插件驱动，更轻量，配置简单，NVENC/H.264/H.265 硬件转码直接走
- **Tdarr**: 分布式 Server + Node 架构，可选外部 HandBrakeCLI + FFmpeg，调度复杂但更灵活

简单场景（个人 NAS + 单 GPU）推荐 Unmanic；需要分布式 / 复杂调度选 Tdarr。

## 状态

- [x] 单容器部署（Unmanic Server + Worker 内置）
- [x] NVIDIA NVENC/NVDEC 加速（Pascal/P620 兼容）
- [x] 4 库独立挂载 + 缓存 + 配置三目录 bind mount
- [x] PUID/PGID/TZ/UMASK 标准化
- [ ] AMD VAAPI / Intel QSV（如需可改 `device: /dev/dri` + 删 NVIDIA_* 环境变量）
