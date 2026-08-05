# HandBrake 视频转码

linuxserver.io 包装的 HandBrake 容器。

## 访问
- Web UI: http://192.168.98.246:3040

## 用途
- 浏览器内视频转码
- CPU/GPU 编码支持

## GPU 加速

本容器支持 NVIDIA GPU 硬件加速（NVENC/NVDEC），可大幅提升视频转码速度。

### 前置要求

1. 宿主机已安装 NVIDIA 驱动程序
2. 宿主机已安装 [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) 并配置 docker daemon（推荐在 `/etc/docker/daemon.json` 中添加 `"default-runtime": "nvidia"`，或在使用 GPU 时手动指定 `runtime: nvidia`）
3. 在 1Panel UI 将 **NVIDIA_ENABLE** 切换为 `true`，并将 **NVIDIA_VISIBLE_DEVICES** 设为 `all`（默认）或具体 GPU 编号

### NVIDIA_ENABLE 开关

| 值 | 行为 |
|---|---|
| `false`（默认） | 禁用 NVIDIA GPU，容器可在任意宿主机启动 |
| `true` | 启用 NVIDIA GPU 硬件加速（需宿主机有 NVIDIA GPU + 已安装 Container Toolkit） |

### NVIDIA_VISIBLE_DEVICES 与 NVIDIA_ENABLE 的关系

| NVIDIA_ENABLE | NVIDIA_VISIBLE_DEVICES | 效果 |
|---|---|---|
| `false` | 任意值 | 仅使用 CPU，GPU 不参与转码 |
| `true` | `all`（默认） | 使用全部 GPU |
| `true` | `0` 或 `0,1` | 使用指定编号的 GPU |
| `true` | `''`（留空） | 仅使用 CPU（与 NVIDIA_ENABLE=false 等效） |

> **NVIDIA_ENABLE 作为主开关**：只有 `NVIDIA_ENABLE=true` 时，GPU 才会参与转码。`NVIDIA_VISIBLE_DEVICES` 仅在 `NVIDIA_ENABLE=true` 时生效。

### 设备权限

compose 中已默认配置 `device_cgroup_rules: ['c 195:* rw']`，授予容器访问 NVIDIA 字符设备（主设备号 195，即 `/dev/nvidia*`）的 cgroup 权限。配合 NVIDIA Container Toolkit，容器内即可正常访问 GPU 设备节点。

### 验证 GPU 是否可用

```bash
# 确认设备节点存在
docker exec <container_name> ls /dev/nvidia*

# 确认 nvidia-smi 可执行
docker exec <container_name> nvidia-smi
```

### 使用硬件编码

在 HandBrake Web UI 中转码时，选择编码器：
- **H.265 (NVEnc)** - NVIDIA HEVC 硬件编码
- **H.264 (NVEnc)** - NVIDIA H.264 硬件编码

## 状态
