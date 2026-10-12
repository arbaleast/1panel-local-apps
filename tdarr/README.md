# Tdarr 媒体自动转码

基于 [haveagitgat/tdarr](https://github.com/HaveAGitGat/Tdarr) 的媒体库自动转码与健康检查调度系统。

本应用以**单容器**方式同时运行 Tdarr Server 与内置 Node（`internalNode=true`）。Tdarr 镜像 **内置 FFmpeg 与 HandBrakeCLI**（位置 `/usr/local/bin/HandBrakeCLI`，版本 1.7.3，由上游 [Dockerfile.base](https://github.com/HaveAGitGat/Tdarr/blob/master/docker/Dockerfile.base) 在构建时从 HandBrake 源码编译），开箱即用，无需任何外部转码后端。

## 访问

部署完成后访问 Tdarr WebUI（1Panel UI 中填写的 `WebUI 端口`，默认 `8265`）：

```
http://<host>:<WebUI 端口>
```

## 内置转码工具

| 工具 | 容器内路径 | 版本 | 备注 |
|---|---|---|---|
| FFmpeg | `/usr/bin/ffmpeg` / `/usr/local/bin/tdarr-ffmpeg` | 7.x | Tdarr_Plugin_rrs 默认调用 |
| HandBrakeCLI | `/usr/local/bin/HandBrakeCLI` | 1.7.3 | 编译自 HandBrake 上游源码 |
| mkvpropedit | `/usr/bin/mkvpropedit` | （来自 mkvtoolnix 包） | Tdarr 在 plugin 中按需调用 |
| ccextractor | `/usr/bin/ccextractor` | 3.x | 字幕提取 |

> **HandBrakeCLI 版本固定为 1.7.3**：这是 Tdarr 上游构建时定死的版本，由 `Dockerfile.base` 中 `HANDBRAKE=1.7.3` 控制。**不能通过 1Panel 表单切换版本**。如需特定版本的 HandBrakeCLI，请自行打 Tdarr 镜像 tag。
>
> **本仓库 `handbrake` 应用与此应用解耦**：`handbrake` 应用（linuxserver/handbrake 1.11.2）提供 Web UI 交互式转码，Tdarr 应用负责媒体库自动转码与健康检查。两者使用各自内置/自带的 HandBrakeCLI，互不依赖。

## 端口

| 字段 | 含义 | 默认 | 容器内端口 |
|---|---|---|---|
| `WebUI 端口` | 浏览器 WebUI 端口 | 8265 | 8265 |
| `Server 端口` | 供其它 Tdarr Node 连接 | 8266 | 8266 |

> 1Panel 同主机仅需一个 Tdarr 应用时，`Server 端口` 仍需暴露（内置 Node 与 Server 内部通信也走此端口），可保留 1Panel 默认分配或手动指定。

## 数据目录

| 字段 | 容器内挂载 | 用途 |
|---|---|---|
| `Server data path` | `/app/server` | Tdarr Server 数据库、Library 配置 |
| `Configs path` | `/app/configs` | 通用配置 |
| `Logs path` | `/app/logs` | 日志 |
| `Transcode cache path` | `/temp` | 转码缓存（中间产物） |
| `Media library path` | `/media` | 媒体库（**留空 = 不挂载**，媒体库改在 Tdarr WebUI Library → Source 中配置） |

## 常用配置

| 字段 | 含义 | 默认 |
|---|---|---|
| `PUID` / `PGID` | 容器内运行用户 UID/GID | `0` |
| `Time zone` | 时区（`TZ`） | `Asia/Shanghai` |
| `Bundled FFmpeg version` | Tdarr 内置 FFmpeg 主版本 | `7` |
| `Run built-in Node inside the same container` | 是否启用内置 Node | `true` |
| `Built-in Node name` | 内置 Node 显示名 | `tdarr-main` |
| `CPU workers` | CPU 转码并发 | `1` |
| `GPU workers` | GPU 转码并发 | `0` |
| `Enable web UI auth` | WebUI 鉴权开关 | `false` |
| `Max log size (MB)` | 日志最大体积 | `10` |
| `Plugin update cron` | 插件更新 cron | `0 6 * * *` |

## 媒体库挂载

媒体库有**两种方式**接入 Tdarr：

1. **部署时挂载**：填 `Media library path`（如 `/data/media`），Tdarr 容器内对应 `/media`。在 Tdarr WebUI Library 中添加路径 `/media`。
2. **不挂载，手动加 Library**：把字段留空，Tdarr 容器不会绑定任何媒体路径；之后在 Tdarr WebUI Library → Source 中配置 `hostPath`（**仅在该 host 路径也对 Tdarr 容器可见时有效**，通常需要再补一个 bind mount）。

> 建议使用方式 1。

## 与 `handbrake` 应用同时部署

两个应用**互相独立**：

- Tdarr 走内置 `HandBrakeCLI 1.7.3`（自动转码）
- `handbrake` 应用走 linuxserver/handbrake 1.11.2（Web UI 手动转码）

它们都加入 1Panel 默认的 `1panel-network`，但**不通过容器网络调用对方**。如果你既想要浏览器手动转码（用 `handbrake` 应用）又想要自动批量转码（用 Tdarr），两个应用同时跑即可。

## GPU 加速

Tdarr 容器继承 1Panel 的 `1panel-network`，如需 GPU 硬件加速：

1. 宿主机需安装 NVIDIA Container Toolkit
2. 编辑 [`docker-compose.yml`](2.91.01/docker-compose.yml)，给 `tdarr` 服务添加：
   ```yaml
   device_cgroup_rules:
     - 'c 195:* rw'
   runtime: nvidia
   ```
3. 在 1Panel UI `GPU workers` 字段填 >0
4. 验证：`docker exec <tdarr-container> nvidia-smi`

## 升级与回滚

Tdarr 上游 semver tag 形式为 `2.91.01`（不带 `v` 前缀），detect-updates 跟踪 GHCR 时会自动按此模式生成新版本目录。手动升级：

```bash
cd 1panel-local-apps
# 复制最新版本目录模板
cp -r tdarr/2.91.01 tdarr/2.92.01
# 编辑 2.92.01/data.yml + 2.92.01/docker-compose.yml 中 image tag
# git commit && git push
```

## 快速上手（首次使用流程）

下面以"把 h264 老片批量转成 h265/HEVC 节省 40%-50% 空间"为典型场景，走通 Tdarr 完整流程。

### 第 1 步 — 1Panel 部署

1. 1Panel UI → 应用商店 → Tdarr → 选 `2.91.01` → 填写表单：
   - `WebUI 端口` 填一个空闲端口（如 `8265`）
   - `Server 端口` 填一个空闲端口（如 `8266`）
   - `Media library path` 填宿主上的媒体根目录（如 `/data/media` 或 `/volume1/media`）
   - 其他字段保持默认即可
2. 部署完成后，浏览器访问 `http://<host>:<WebUI 端口>` 进入 Tdarr WebUI
3. 首次打开会初始化 MongoDB（Tdarr 内部数据库），等 30-60 秒

### 第 2 步 — 配置 Library（媒体库）

1. WebUI 顶栏 → **Libraries** → **+ New Library**
2. 关键字段：
   - **Name**: 起个名字，如 `movies`
   - **Source**: 选择 `Folder` → `/media`（这就是 1Panel 表单 `Media library path` 在容器内的路径）
   - **Folder watch**: 启用，新文件自动入队
   - **Cache directory**: 留空（用默认 `/temp` 转码缓存）
   - **Output directory**: 与 Source 同目录（覆盖原文件）；如想保留原件，可填另一个目录
3. **Save**

### 第 3 步 — 配置 Flow（新版）或 Plugin Stack（经典版）

Tdarr 2.x 引入新版 **Flow**（节点图），向下兼容 **Stacks**（经典插件栈）。推荐新手先用 Stacks，预设模板多。

#### 3a. 经典 Stacks（最快上手）

1. WebUI 顶栏 → **Stacks** → **+ New Stack**
2. **Stacks** 区域会出现一些**社区预设**（如 `Tdarr_Plugin_rrs_HEVC`），点开就能看到插件列表
3. 推荐选 `Tdarr_Plugin_rrs_HEVC`（H.264 → H.265 批量转码），它是社区最主流的入门预设
4. 也可以从空白 Stack 开始，依次添加社区插件：
   - `Tdarr_Plugin_rrs_FFmpegCPU` 或 `Tdarr_Plugin_rrs_HandBrake`（二选一，决定用 ffmpeg 还是 handbrake 转码）
   - `Tdarr_Plugin_rrs_FileFlow_Audio`（处理音轨）
   - `Tdarr_Plugin_rrs_FileFlow_Subtitles`（处理字幕）
5. **Save**

#### 3b. Flow（节点图，进阶）

1. WebUI 顶栏 → **Flows** → **+ New Flow**
2. 从社区导入：`Tdarr_Plugin_rrs_HEVC` 等插件都有 Flow 形式
3. 自己拖拽节点：Input → Plugin → Output

### 第 4 步 — 关联 Stack 到 Library

1. 回到 **Libraries** → 打开刚才创建的 library → **Transcode Profile / Stack / Flow** 区域
2. 选择你在第 3 步保存的 Stack 或 Flow
3. **Save**

### 第 5 步 — 启动扫描

1. **Libraries** → 点 library 旁的 **Search** / **Scan** 按钮
2. Tdarr 会扫描 `/media` 下所有视频文件，做 health check（健康检查）并把符合 Stack 条件的文件加入转码队列
3. 在 **Search** 标签可看到所有被识别的文件；点开某个文件可看 ffprobe 流详情

### 第 6 步 — 启动 Node 干活

1. WebUI 顶栏 → **Nodes**
2. 内置 Node（`Built-in Node name` 字段设置的名字，默认 `tdarr-main`）应自动出现在列表，状态 `Idle` / `Paused`
3. 点 Node 旁的 **Resume** 按钮 → 状态变 `Active`
4. Node 开始按 `CPU workers` / `GPU workers` 数量从队列拉任务

### 第 7 步 — 监控进度

- **Workers** 标签：实时显示每个 worker 在处理哪个文件、当前码率、ETA
- **Stats** 标签：累计转码数、节省空间、健康率
- **Logs** 标签：节点日志，转码失败原因在这里
- **Job Reports** 标签：每个文件转码前后的体积、码率对比

### 典型操作清单

| 想做什么 | 在 Tdarr WebUI 里怎么操作 |
|---|---|
| 全库扫描 | Libraries → 点 library → Search 按钮 |
| 立即转码某文件 | Search → 找到文件 → Transcode to → 选 Stack |
| 跳过某文件 | Search → 找到文件 → 右键 → Exempt |
| 查看转码失败原因 | Logs / Job Reports → 找对应文件 → 看 errorMessage |
| 改转码目标 | Stack 中修改 ffmpeg/handbrake 节点参数（crf、preset、codec） |
| 启用硬件加速 | `GPU workers` 字段 > 0；docker compose 加 `runtime: nvidia` |
| 让 Tdarr 只看不动 | Library → 关掉 `Transcode after scan` |

> 第一次大规模转码前，**强烈建议**先挑 1-2 个文件手动跑一遍 Stack，确认参数、输出体积、字幕处理都符合预期再放开全库。

## 故障排查

- **容器启动后 WebUI 502**：等待约 30-60 秒，Tdarr Server 首次启动会初始化数据库。
- **HandBrakeCLI 找不到**：内置版本为 `/usr/local/bin/HandBrakeCLI`，Tdarr 默认 `handbrakePath` 留空时使用镜像内置路径。验证：
  ```bash
  docker exec <tdarr-container-name> /usr/local/bin/HandBrakeCLI --version
  ```
- **Worker 找不到 Server**：默认内置 Node 与 Server 同容器，不应出现此问题。若手动拆出 Node，确保 `Built-in Node name` 与 Server 端 Nodes 列表中显示名一致。
- **PUID/PGID 权限问题**：1Panel 部署时如果挂载的宿主机目录属主与 `PUID`/`PGID` 不符，Tdarr 容器写入会失败。推荐使用 1Panel 自动注入的宿主机目录（`./data/...`），其默认属主匹配 root (`0`)。

## 链接

- [Tdarr 官方文档](https://docs.tdarr.io)
- [Tdarr 插件社区库](https://github.com/HaveAGitGat/Tdarr_Plugins)
- [本仓库 handbrake 应用](../handbrake/README.md) — 独立的 Web UI 手动转码应用
