# HandBrake Web (TheNickOfTime)

> ⚠️ **这不是 `handbrake/` (linuxserver 单 GUI) 的同款应用**. 这是 [TheNickOfTime/handbrake-web](https://github.com/TheNickOfTime/handbrake-web) 的分布式 worker 队列版. 用法不同, 适用场景不同.

## 这个应用是什么

[TheNickOfTime/handbrake-web](https://github.com/TheNickOfTime/handbrake-web) 是一个**双容器**的 HandBrake 转码系统:

- **server** (`:9999`): 协调器 + Web UI. **不跑** HandBrakeCLI, 只分配任务.
- **worker**: 实际跑 HandBrakeCLI 转码的容器. **支持 NVIDIA NVENC / Intel QSV**.

**适合**: 多台机器共享一个队列 / NAS 集群转码 / 闲置机器挖潜.

**不适合**: 单机单卡自用. 这种场景用 [`handbrake/`](../handbrake) (linuxserver 主线) 更简单 (单容器 / UI 直接 / 你 P620 已经验证 NVENC 通了).

## ⚠️ 已知风险

1. **upstream 注明**: "This application is still under heavy development, use at your own risk" ([README](https://github.com/TheNickOfTime/handbrake-web) + [issue #88](https://github.com/TheNickOfTime/handbrake-web/issues/88))
2. **P620 NVENC 官方未验证**: upstream 在 issue #88 自述测试平台是 **RTX 3070 (Turing CC 7.5)**, P620 是 **Pascal CC 6.1 + 2GB GDDR5**, **未在 Pascal 2GB 显存卡上跑过**
3. **build 镜像自带 HandBrakeCLI 1.10.2** ([build.Dockerfile L16](https://github.com/TheNickOfTime/handbrake-web/blob/main/handbrake/build.Dockerfile)), 比 linuxserver 主线 1.11.2 略旧; 1.10.2 已经**支持 NVENC** (`./configure --enable-nvenc`, L109), 但功能集略少
4. **worker 镜像是 distroless** (`gcr.io/distroless/nodejs24-debian13:debug-nonroot`): 没有 bash / apt / nvidia-smi, debug 必须看 `docker logs`
5. **镜像仅 `latest` tag** ([GHCR](https://github.com/TheNickOfTime/handbrake-web/pkgs/container/handbrake-web-server)): 上游无 semver / date-based 镜像. 本仓 `handbrake-web/latest/` 目录因此使用 `latest` 版本参数 (符合 AGENTS.md "latest 例外条款")

## 部署

### 1. 1Panel UI 装好之后会启动两个容器

```
${CONTAINER_NAME}-server   (ghcr.io/thenickoftime/handbrake-web-server:latest)
${CONTAINER_NAME}-worker   (ghcr.io/thenickoftime/handbrake-web-worker:latest)
```

### 2. 浏览器访问

`http://<1Panel 主机 IP>:9999` 打开 handbrake-web Web UI.

### 3. 转码前先上传 Preset

handbrake-web **不内置**转码预设. 必须从 [HandBrake Desktop 应用](https://handbrake.fr/downloads.php) 导出 preset JSON (`.json` 文件, 从 Presets 页面右上下拉菜单选 Export), 然后在 handbrake-web Web UI 的 "Presets" 页面上传.

### 4. 添加转码任务

UI 上传视频文件 + 选择 preset + 选 worker + Start. worker 容器内 HandBrakeCLI 跑转码.

## 验证 NVIDIA 注入是否生效

worker 是 distroless 镜像, 容器内**没有** `nvidia-smi` 也没有 `bash`. 验证方式:

```bash
# 1. 看 worker 容器日志有没有 nvidia-container-cli 痕迹
docker logs <CONTAINER_NAME>-worker 2>&1 | grep -iE "nvidia|libcuda"

# 2. 看容器进程 /dev/nvidia* 是否可见
docker exec <CONTAINER_NAME>-worker ls -la /dev/nvidia* 2>&1
# 期望: 看到 nvidia0 nvidiactl nvidia-uvm

# 3. 看容器内 nvidia 相关 .so 是否被注入
docker exec <CONTAINER_NAME>-worker ls /usr/lib/x86_64-linux-gnu/libnvidia* 2>&1
# 期望: libnvidia-ml.so.1 libnvidia-cfg.so.1 libnvidia-encode.so.1 等

# 4. 让 worker 真跑一个任务, 日志里搜 NVENC
docker logs -f <CONTAINER_NAME>-worker 2>&1 | grep -iE "nvenc|qsv|vce|handbrake"
# 期望: 看到 HandBrakeCLI 选 H.265 NVEnc, 编码器行显示 "nvenc" / "h264_nvenc"
```

如果 step 2 看不到 `/dev/nvidia*`, 说明 1Panel 主机 **NVIDIA Container Toolkit 缺失或未注册**——这不是本应用问题, 1Panel 主机需要装 nvidia-container-toolkit + `nvidia-ctk runtime configure --runtime=docker` + `systemctl restart docker`. 跟 [`handbrake/`](../handbrake) 修复 `a1ed898` 同根.

## 跟 [`handbrake/`](../handbrake) 的区别

| 维度 | `handbrake/` (linuxserver) | `handbrake-web/` (TheNickOfTime) |
|---|---|---|
| 容器数 | 1 (GUI 单容器) | 2 (server + worker) |
| UI | 直接看 HandBrake 原生 GUI | 协调面板 (要上传 preset JSON) |
| NVENC 配置 | `runtime: nvidia` | `deploy.resources.reservations.devices` |
| NVENC 官方测试硬件 | 多 (linuxserver 长期支持) | RTX 3070 (1 块) |
| 上游稳定性 | linuxserver.io 成熟 | "under heavy development" |
| 持久化路径 | `./data` 单一目录 | `./data/server` + `./data/media` 两目录 |
| 端口 | 3000 + 3001 | 9999 |
| 适用场景 | 单机自用 | 多机队列 / 批量转码 |

**单卡单主机自用** 优先选 `handbrake/` (linuxserver).

## 相关链接

- 上游仓库: https://github.com/TheNickOfTime/handbrake-web
- 上游 setup guide: https://github.com/TheNickOfTime/handbrake-web/wiki/Setup-Guide
- 上游 GPU 讨论: https://github.com/TheNickOfTime/handbrake-web/issues/88
- 官方 compose 模板: https://github.com/TheNickOfTime/handbrake-web/tree/main/compose
- NVIDIA Container Toolkit: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
