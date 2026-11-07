# Immich 照片视频管理

Google Photos 自托管替代品，ML 人脸/物体识别。

## 访问
- Web: https://immich.arbaleast.top
- iOS/Android App: 同 URL，扫码添加服务器

## 用户
- admin@test.com / 见 .env IMMICH_ADMIN_PASSWORD
- guest@immich / 见 .env (只读浏览)
- sysadmin@immich / 见 .env (系统管理员)

## 用户隔离
- admin 和 guest 互相不可见
- sysadmin 是第三方管理员

## 数据
- 上传目录: /mnt/user/media/photos/immich/upload
- 应用数据: /mnt/user/appdata/immich/
- 缩略图 / 备份: 同 appdata 目录

## 依赖
- PostgreSQL (immich 专用库)
- Redis (无密码)

## 运行用户 UID / GID

安装参数 `UID` / `GID` 通过 compose 的 `user:` 指定容器内进程身份，默认 `99` / `100`。

⚠️ **首次部署前必须把数据目录属主改到同一 UID / GID**，否则容器无权写入、启动即失败：

```bash
# 以应用实际安装目录为准（1Panel → 应用 → immich → 详情 → 路径）
sudo chown -R 99:100 <应用安装目录>/data
```

需要 chown 的目录（相对于应用安装目录）：`./data/model-cache`

另外这些宿主机绝对路径也会被挂载进去，只需保证 uid 99 **可读**（需要写入时再单独 chown）：

- `/mnt/nfs/media/photos/immich/upload`

- 想以 root 运行：把 `UID` / `GID` 都填 `0`
- 升级到新版本目录后要**重新 chown 一次**（新目录下的 `data` 为空、属主是 root）
- 容器内所有新文件都以该 UID / GID 创建，宿主机上看到属主是 99:100 属正常现象

## NVIDIA GPU 硬件加速（可选）

GPU 能力拆成两块，**各自独立开关**：

| 能力 | 容器 | 依赖 | 本应用默认 |
|---|---|---|---|
| 视频硬件转码（NVENC 编码 / NVDEC 解码） | `immich-server` | 宿主机 NVIDIA 驱动 + Container Toolkit | 关闭（注释块） |
| 机器学习推理（CUDA） | `immich-machine-learning` | 同上 + `-cuda` 版 ML 镜像 | 关闭（CPU 版镜像） |

> **默认安装路径完全不变**：compose 里的 NVIDIA 设备声明是**注释块**，没装 NVIDIA 驱动的
> 纯 CPU 机器直接点安装即可，不会因为 `driver: nvidia` 找不到设备驱动而起不来。

### 一、宿主机前置条件（Debian 13）

**1. NVIDIA 专有驱动**

- 上游 Immich 对 CUDA 机器学习的官方要求是**驱动 ≥ 545**（需支持 CUDA 12.3）。
- ⚠️ Pascal（Quadro P620 属于这一代）**只被 CUDA 12.x 支持**：CUDA 13 起 NVIDIA 官方移除了
  Maxwell / Pascal / Volta 架构的支持。若装上过新的驱动分支后 CUDA 调用报
  `no kernel image is available for execution on the device`，把驱动回退到仍支持 Pascal 的分支
  （具体分支以 NVIDIA 官方 driver release notes 为准）。
- 验证：

  ```bash
  nvidia-smi
  # 应能看到 Quadro P620 / GP107 / Compute Capability 6.1
  ```

**2. NVIDIA Container Toolkit**（把宿主机 `/dev/nvidia*` 与驱动库注入容器）

Debian 13 上按 NVIDIA 官方仓库安装（`nvidia-container-toolkit` 包），然后：

```bash
# 注册 nvidia 运行时 / 设备驱动（老版本 docker 用 --runtime=docker，新版本用 --runtime=cdi）
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

**3. 基础验证**（不依赖 1Panel，纯 Docker 层面）

```bash
docker run --rm --gpus all ubuntu:22.04 nvidia-smi
```

能打印出显卡信息即说明宿主机侧已就绪；**这一步不通过就不要继续装应用**。

### 二、在 1Panel 里开启 GPU

1. **视频转码（NVENC）**
   - 安装时在 1Panel 应用安装面板勾选 **「编辑 Compose 文件」**（部分版本文案为「高级选项 → 编辑 Compose」）。
   - 在打开的 compose 编辑器里，找到 `immich-server` 服务，把 `deploy.resources` 下这段注释取消：

     ```yaml
     reservations:
         devices:
             - driver: nvidia
               count: 1
               capabilities:
                 - gpu
                 - compute
                 - video
     ```

   - 提交安装；也可以**安装完成后**编辑 `<应用安装目录>/v3.0.3/docker-compose.yml`、取消同样这段注释，再在 1Panel 里重建容器。

2. **机器学习（CUDA，可选）**
   - 安装表单里把 **「机器学习镜像 Tag」** 从 `v3.0.3` 改成同版本号的 `-cuda` 变体
     （即 `v3.0.3-cuda`；CUDA 版仅发布 amd64 架构）。
   - 在 compose 里找到 `immich-machine-learning` 服务，取消注释：

     ```yaml
     deploy:
         resources:
             reservations:
                 devices:
                     - driver: nvidia
                       count: 1
                       capabilities:
                         - gpu
     ```

   - 其余配置（模型缓存目录 `MODEL_CACHE_PATH`、CPU 版完全一致）无需改动。

3. **Web 端必做设置（不做则硬件转码不生效）**
   - 容器起来后登录 Immich 网页端 → **管理（Administration）→ 设置 → 视频转码设置** →
     把 **硬件加速（Hardware Acceleration）** 选成 **NVENC** 并**保存**。上游默认是 `disabled`。
   - 想端到端加速（解码也走 GPU），再打开同页的 **硬件解码（Hardware Decoding）**。
     注意：上游默认**只有编码走硬件**，解码与色调映射仍占用 CPU。

### 三、验证方法

```bash
# 1) 容器是否拿到了 GPU
docker exec -it <immich-server容器名> nvidia-smi

# 2) ffmpeg 是否带 NVENC 编码器（immich-server 镜像内）
docker exec -it <immich-server容器名> ffmpeg -hide_banner -encoders | grep nvenc

# 3) 机器学习容器是否加载了 CUDAExecutionProvider
docker logs <容器名>-ml 2>&1 | grep -i "Available ORT providers"
#    期望看到含 CUDAExecutionProvider；只有 CPUExecutionProvider 说明回退到 CPU 了
#    触发一次智能搜索 / 人脸识别任务，日志里才会真正走 CUDA

# 4) 观察 GPU 占用（可选）
watch -n 1 nvidia-smi
```

### 四、Quadro P620（Pascal / 2GB 显存）专项说明

**编解码能力**

- 支持 H.264 / HEVC(H.265) 硬件编解码；**不支持 AV1**（Pascal 世代没有 AV1 硬件编解码单元）。
- GP107 只有 **1 个 NVENC + 1 个 NVDEC** 引擎，硬件并发会话数有限（消费级 Pascal 驱动通常限制在
  2–3 路，具体上限以 `nvidia-smi` 输出与实机压测为准）→ Immich 端**并发转码数建议设为 1**。
- 上游说明：默认只有编码走 GPU，解码与色调映射仍在 CPU 上；开启「硬件解码」可进一步降 CPU。

**精度与架构**

- Pascal GP107 **没有 Tensor Core**，FP16 吞吐与 FP32 同速（不像 Turing/Ampere 有 2× FP16），
  跑 CLIP / 人脸识别这类模型时 GPU 收益远低于新架构。
- ⚠️ **实测提醒**：本应用表单里的 `ML_MODEL_PRECISION`（写入 `MACHINE_LEARNING_MODEL_PRECISION`）
  在上游 v3.0.3 里**已经不被读取**——上游只对 OpenVINO / ROCm 提供
  `MACHINE_LEARNING_OPENVINO_PRECISION` / `MACHINE_LEARNING_ROCM_PRECISION`，
  CUDA（ONNX Runtime）路径没有精度开关。该表单项保留只为向后兼容，**调它不会改变精度**。

**2GB 显存防 OOM 指南**

1. Immich 网页端 → 管理 → 设置 → 视频转码设置：**并发转码数设为 1**。
2. 安装表单 **「ML Worker 进程数」保持 1**（每个 worker 会各占一份模型显存）。
3. 安装表单 **「模型空闲卸载时间（秒）」** 保持默认 `300`（= 上游默认 5 分钟空闲卸载），
   显存紧张时可调到 `60`；填 `0` 表示**禁用**自动卸载（不推荐）。
4. **推荐方案（最稳）**：`GPU 只做 NVENC 转码 + CPU 跑机器学习`，即
   - 机器学习镜像 Tag 保持 `v3.0.3`（CPU 版），**不**给 ML 容器取消 GPU 注释；
   - 只给 `immich-server` 取消 NVIDIA 设备注释，用于 NVENC；
   - 机器学习模型缓存目录放在磁盘（`MODEL_CACHE_PATH`），别放显存。

> `-cuda` 版 ML 镜像本身是支持 Pascal 的：上游 v3.0.3 的 ML Dockerfile 把 cuDNN 固定在
> `9.10.2`（注释原文：*Pascal support was dropped in 9.11*），即刻意停在还支持 Pascal 的版本。
> 即便如此，Pascal 跑 ONNX Runtime（该镜像内 `onnxruntime-gpu` 实锁 1.26.0）的实际加速比仍明显弱于新架构，
> 且 2GB 显存同时承担 NVENC 会话与 ML 模型很容易 OOM —— **P620 上优先用上面的混合方案**。

### 五、排错

| 现象 | 原因 / 处理 |
|---|---|
| `could not select device driver "nvidia"` | 宿主机没装/没配 Container Toolkit，或 Docker 没重启；先跑 `docker run --rm --gpus all ubuntu:22.04 nvidia-smi` 自检 |
| `nvidia-container-cli: requirement error` | 驱动与 Container Toolkit 版本不匹配，重装匹配的 toolkit 并 `systemctl restart docker` |
| 转码日志仍走 CPU | 网页端「视频转码设置 → 硬件加速」没选 NVENC 或没保存 |
| ML 日志只有 `CPUExecutionProvider` | 镜像 Tag 没改成 `-cuda` 变体，或 ML 容器没取消 GPU 注释，或驱动版本过新不支持 Pascal |
| `no kernel image is available for execution on the device` | 驱动/CUDA 版本过新（CUDA 13 起移除 Pascal 支持），回退驱动 |
| 容器内 `nvidia-smi` 正常但 Immich 报错 | 检查 `UID`/`GID` 对应的宿主机目录属主（见上文 UID / GID 章节） |

> **非 root 运行说明**：`immich-server` 以 `UID:GID`（默认 99:100）运行。NVIDIA 驱动创建的
> `/dev/nvidia*` 设备节点默认是 `0666` 权限，非 root 进程可直接打开，因此一般**无需**额外
> `group_add`；若你的宿主机把设备节点收紧成 `0660 root:video`，在 compose 的 `immich-server`
> 里补一行 `group_add: ["video"]` 即可。

### 六、版本升级注意

- 机器学习镜像在 compose 里写成 `${ML_IMAGE}:${ML_IMAGE_TAG}`（镜像仓库 + tag 分离），
  所以升级到新版本目录时**两个镜像会一起升**（server 与 ML 必须同版本）。
- 但如果你在表单里把 `ML_IMAGE_TAG` 改成了 `-cuda` 变体（如 `v3.0.3-cuda`），升级后 `.env` 里仍是旧 tag，
  **需要手动同步**成新版本的 `-cuda` tag（与 `immich-server` 的版本号保持一致，
  例如服务器升到 `v3.3.6` 就填 `v3.3.6-cuda`），否则 server 与 ML 版本不一致。
