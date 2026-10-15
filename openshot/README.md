# OpenShot 开源视频剪辑

linuxserver.io 官方镜像的 OpenShot，通过 Selkies WebRTC 在浏览器中直接使用完整桌面版，无需安装本地客户端。

> **仅 amd64**：上游 `linuxserver/openshot` 只发布 `linux/amd64` 单架构 tag（`jenkins-vars.yml` 中 `MULTIARCH: 'false'`），1Panel 部署前请确认宿主为 x86_64。

## 访问

- Web UI: `http://<宿主机IP>:<PANEL_APP_PORT_HTTP>`（默认 3000）
- HTTPS: `https://<宿主机IP>:<PANEL_APP_PORT_HTTPS>`（默认 3001）

> **建议走 HTTPS**：Selkies 的 WebCodecs 硬件解码在多数浏览器上仅在 HTTPS（或 `localhost`）下可用。想在浏览器里对 NVENC 硬解预览省 CPU，把 3001 端口配成 1Panel 网站的 HTTPS 反代入口。

## 版本

| 版本目录 | 上游 OpenShot | linuxserver 完整 tag |
|---|---|---|
| `4.0.1` | 4.0.1 | `4.0.1dfsg21848202609280435ubuntu26.04.1-ls92` |
| `4.0.0` | 4.0.0 | `4.0.0dfsg21825202608312127ubuntu26.04.1-ls89` |

> compose 中使用短 tag（`4.0.1` / `4.0.0`）。它与 `latest`、对应完整 tag 指向同一 digest，但能被本仓 `detect-updates` 的纯 semver 匹配识别（4.1.0 发布后自动开 PR 新增版本目录）；若直接写完整 tag，每次基线重建（`-lsNNN`）都会误报一次「更新」。

> **查 tag 时 Docker Hub API 在部分网络下不可达**：可改用 GHCR 镜像（内容一致）核对：
>
> ```bash
> TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:linuxserver/openshot:pull" | jq -r .token)
> curl -s -H "Authorization: Bearer $TOKEN" \
>   "https://ghcr.io/v2/linuxserver/openshot/tags/list?n=1000" | jq -r '.tags[]' | sort -V
> ```

## 安装参数

1Panel 部署时需要填写的表单字段（16 项）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `PANEL_APP_PORT_HTTP` | `3000` | 宿主机 HTTP 端口 → 容器 3000（上游标注「仅供反向代理」） |
| `PANEL_APP_PORT_HTTPS` | `3001` | 宿主机 HTTPS 端口 → 容器 3001 |
| `TIME_ZONE` | `Asia/Shanghai` | 时区 |
| `PUID` | `99` | 容器内运行 UID，需与 `/storage` 宿主机目录属主一致 |
| `PGID` | `100` | 容器内运行 GID，同上 |
| `UMASK_SET` | `002` | 新建文件权限掩码 |
| `LC_ALL` | `C.UTF-8` | 容器语言环境 |
| **`MEDIA_PATH`** | *(空)* | **媒体目录挂载**：宿主机绝对路径（如 `/data/media/videos`），容器内固定挂到 `/storage` |
| `TITLE` | `OpenShot` | 浏览器页面标题 |
| `CUSTOM_USER` | `admin` | Basic Auth 用户名 |
| `PASSWORD` | 随机 | Basic Auth 密码，留空 = 不启用认证 |
| `DASHBOARD` | `selkies-dashboard` | Selkies 侧边栏样式 |
| `NVIDIA_ENABLE` | `true` | NVIDIA GPU 总开关 |
| `NVIDIA_VISIBLE_DEVICES` | `all` | 可见 GPU（`all` / `GPU-xxx` / `0`） |
| `NVIDIA_DRIVER_CAPABILITIES` | `compute,video,graphics,utility` | GPU 能力，**必须保留 `video`（NVENC）与 `graphics`（GPU 预览）** |
| `PIXELFLUX_WAYLAND` | `false` | 渲染模式，`false` = X11/Xvfb（推荐） |

## 媒体目录挂载

`MEDIA_PATH` 是本应用保留的媒体目录挂载变量：

- 在 1Panel 表单填**宿主机绝对路径**（例：`/data/media/videos`），容器内固定出现在 `/storage`
- OpenShot 的「导入文件 / 保存工程」对话框可直接浏览 `/storage` 下的素材与工程
- **留空**也能部署：容器内 `/storage` 为空目录，此时可用 Selkies 侧边栏文件管理器上传素材，或在 1Panel「容器 → 存储」里追加挂载（无需改 compose）
- `PUID` / `PGID` 需与该宿主机目录的属主一致，否则 OpenShot 写不了工程文件与导出成片：

```bash
# 查宿主机目录属主，把结果填进 PUID / PGID
stat -c '%u %g' /data/media/videos
```

`./data/config` 持久化 OpenShot 工程草稿、缩略图缓存、导出预设与 Selkies 证书。

> compose 中已写死 `shm_size: 1gb`（上游对全部桌面类镜像的建议值）。OpenShot 预览多轨时共享内存不足会渲染失败，不要删掉这一行。

## GPU 加速（目标卡：NVIDIA Quadro P620）

compose 中已配置 `runtime: nvidia` + `device_cgroup_rules: ['c 195:* rw']`，容器直接获得宿主机 `/dev/nvidia*` 与 NVIDIA 用户态库。

### P620 硬件规格要点

Quadro P620 是 **Pascal（GP107GL）** 架构工作站卡：

- NVENC 硬件编码：H.264 / H.265，OpenShot 经 MLT/FFmpeg 可走 `h264_nvenc` / `hevc_nvenc`
- OpenGL 4.6 + OpenCL：OpenShot 预览窗口可走 GPU 渲染
- 显存 4GB GDDR5：适合 1080p 剪辑，4K 多轨建议配合代理剪辑

### 宿主前置要求

1. **NVIDIA 驱动** ≥ 470（Pascal 最低线）。推荐 **580 分支**——它是最后一个支持 Pascal 的长期分支
2. **NVIDIA Container Toolkit**：

   ```bash
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```

3. **内核参数** `nvidia-drm.modeset=1 nvidia_drm.fbdev=1`（GRUB / systemd-boot 均可），否则无显示输出时 DRM 不初始化
4. **无头机需插 HDMI 欺骗器（dummy plug）**，否则显卡不建立显示输出，容器内 DRM 会拿不到 render node

### 验证 GPU 可用

```bash
docker exec <容器名> nvidia-smi          # 应列出 Quadro P620
docker exec <容器名> ffmpeg -hide_banner -encoders 2>/dev/null | grep -i nvenc
# 期望看到 h264_nvenc / hevc_nvenc
```

### 在 OpenShot 里启用硬编

OpenShot 的导出设置（右上角「导出项目」→「高级」→「视频 / 编码」）：

- **编码器**从 `H.264 (x264)` 改为 `NVENC H.264`，或选 `NVENC H.265`
- **质量预设**建议先用 `High Quality`，导出速度明显快于软编且同码率画质接近
- 若下拉里没有 NVENC 项，先确认 `NVIDIA_DRIVER_CAPABILITIES` 没丢 `video`

### 渲染模式 PIXELFLUX_WAYLAND

| 值 | 行为 |
|---|---|
| `false`（默认，推荐） | X11 + Xvfb 虚拟显示，无头宿主上最稳定 |
| `true` | Smithay + Labwc 的 Wayland 路径，可开零拷贝编码，但 Pascal 驱动在合成器上偶有黑屏 |

若切到 `true` 后出现黑屏或推流断流，切回 `false` 即可。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 容器反复重启，日志刷 `s6-overlay-suexec: fatal: can only run as pid 1` | compose 被误加了 `init: true`。本镜像基于 s6-overlay，**必须去掉 `init: true`**，也不能加 `user:` / `pid:` |
| 浏览器黑屏 / 无推流 | 保持 `PIXELFLUX_WAYLAND=false`；检查 3000/3001 端口是否被宿主防火墙拦截 |
| 容器起不来，提示找不到 nvidia runtime | 宿主未装 NVIDIA Container Toolkit，或没执行 `nvidia-ctk runtime configure` |
| 1Panel 拉镜像报 `no matching manifest for linux/arm64/v8` | 上游只发布 amd64，请换 x86_64 宿主 |
| OpenShot 读不到 `/storage` 素材 | `MEDIA_PATH` 必须是宿主机绝对路径；并确认 `PUID`/`PGID` 与该目录属主一致 |
| 导出成片失败「无权限」 | 同上，`PUID`/`PGID` 不匹配导致写不进 `/storage` |
| 导出编码器下拉没有 NVENC | `NVIDIA_DRIVER_CAPABILITIES` 被改动丢了 `video`；恢复为 `compute,video,graphics,utility` |
| 预览多轨卡顿 / 渲染报错 | `shm_size` 被删或调小；恢复为 `1gb` |

## 参考

- 上游镜像: https://github.com/linuxserver/docker-openshot
- 上游文档: https://docs.linuxserver.io/images/docker-openshot/
- OpenShot 官网: https://www.openshot.org/
