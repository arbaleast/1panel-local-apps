# LosslessCut 无损视频/音频剪辑

基于 [outlyernet/losslesscut](https://github.com/outlyer-net/docker-losslesscut) 容器的浏览器内无损视频/音频剪辑工具，基于 FFmpeg **直接流复制**（不重新编码），处理 1 小时 1080p 视频通常 < 10 秒。

## 重要：LosslessCut **没有原生 web 版**

LosslessCut 本身就是 **Electron 桌面应用**（mifi/lossless-cut 是 `electron-builder` 打包的桌面程序），容器化的本质是 **Xvfb + x11vnc + noVNC** —— 浏览器只是在远程操控一个跑在容器里的桌面程序，**不是网页版**。所以：

- ❌ **不能**像普通 web 应用那样：上传文件、拖时间轴、点击按钮直接处理
- ✅ **实际行为**：浏览器打开 5800 → 看到的是**整个 Electron 桌面窗口**（Xvfb 虚拟显示的截屏），你在浏览器里**点击/拖拽/按键**都在远程操控那个 Electron 进程
- 网络流量：鼠标坐标 + 键盘事件 + Electron 窗口画面（H.264 编码）= **轻量级远程桌面**
- **视频数据本身不经过网络**：FFmpeg 跑在容器内本地，直接读 `${MEDIA_PATH}` 挂进来的文件

这就是你直觉里"noVNC ≠ 原生 web"的核心原因——**它本质上就是远程桌面**，只是 VNC 协议被包到 WebSocket 里让浏览器能看。

## 访问（两个通道都是远程桌面）

| 通道 | 端口 | 用途 | 体验 |
|---|---|---|---|
| **Web UI (noVNC)** ← 推荐 | 5800 | 浏览器直接打开 `http://<host>:5800`，HTML5 Canvas 渲染，鼠标 / 键盘 / 剪贴板全支持 | 远程桌面（Web 协议版） |
| VNC 直连（可选） | 5900 | RealVNC / TigerVNC / Remmina 等原生 VNC 客户端 | 远程桌面（原生 VNC 协议） |

两个通道显示的**都是同一个 Electron 桌面程序**。noVNC 多的 WebSocket 封装增加 5-10ms 延迟、CPU 多 1-2%，对 LosslessCut（"几秒剪一刀"的轻交互）几乎无感。**绝大多数情况浏览器就够了**。

## 真·原生 web 体验：LosslessCut 的 HTTP API（仅供自动化）

上游 CLI 模式启动时 `losslesscut --http-api` 会在 `localhost:8080` 暴露一个 Express HTTP API：

- `POST /api/action/:action` — 触发一个键盘动作（"open file"、"export"、"goToTimecodeDirect" 等）
- `POST /api/await-event/:eventName` — 长轮询等待事件（"export-complete" 等）

⚠️ **这不是"网页版 UI"**，是给脚本 / CI / 自动化触发用的——你**不能用它**在浏览器里拖时间轴。自动化批量处理场景才用得上。

**outlyernet 容器** 默认启动的是 GUI 模式（带 noVNC），**没有** `--http-api` flag。要跑 HTTP API 自动化，得另开一个 `--http-api` 模式的容器并挂同一份 `/storage` —— 当前 1Panel 应用没暴露这个模式，需要自定义 compose。

## 上游
- 应用: [mifi/lossless-cut](https://github.com/mifi/lossless-cut) (LosslessCut 3.64.0)
- 容器镜像: [outlyernet/losslesscut](https://hub.docker.com/r/outlyernet/losslesscut) (基础镜像 [jlesage/docker-baseimage-gui](https://github.com/jlesage/docker-baseimage-gui), Debian + s6-overlay)
- 镜像 tag: `3.64.0-v1` (2024-11-09 发布)

## 用途
- 无损剪裁视频/音频（基于关键帧，FFmpeg `-c copy`）
- 提取片段、合并多段、重新混流 (remux) 到不同容器
- 提取单帧快照、提取所有音轨/字幕轨
- 视频元数据查看/编辑、章节标记、旋转方向元数据
- **手动**批量处理：一次导入多个文件，逐个切好后一起导出
- **脚本**批量处理：上游 `losslesscut --http-api` + `POST /api/action/*`（**outlyernet 镜像默认未启用此模式**，需要自定义 compose 才能跑）

## 工作原理
- LosslessCut 本身是 Electron 桌面应用，封装进容器后通过 noVNC（HTML5 VNC 客户端）将 GUI 暴露在浏览器中
- 容器内运行：Xvfb（虚拟显示）+ x11vnc + noVNC + Electron LosslessCut + 内置 FFmpeg
- 进程由 s6-overlay 监督（基础镜像约定），不要在 compose 中加 `init: true`（会与 s6-overlay 抢占 PID 1）

## 安装配置

### 必填字段
- **Web UI 端口 (PANEL_APP_PORT_HTTP)**: 容器内 noVNC 监听 5800，建议保持默认
- **时区 (TZ)**: 容器内时区，文件时间戳会用到
- **运行用户 UID/GID**: 默认 1000/1000，与宿主机 media 目录属主一致可避免权限问题

### 媒体库路径 (MEDIA_PATH)
- 宿主机绝对路径（如 `/data/media/videos`），挂载到容器 `/storage`
- LosslessCut 内置文件浏览器可访问 `/storage` 看到挂入的视频
- 留空时 `/storage` 为空，仍可通过 Web UI「File → Open」拖入单个文件处理
- **建议填**：`/data/media` 或某个具体分类目录

### HTTPS (SECURE_CONNECTION)
- 默认 `false`（HTTP 访问）
- 设为 `true` 时启用 HTTPS，证书默认自签（首次访问需浏览器信任）
- 也可把自签证书放入 `./data/config/certs/` 目录使用自己的证书

### 中文字体 (FONT_PATH 宿主机挂载)
- 1Panel 表单字段 `FONT_PATH`（默认 `/usr/share/fonts/truetype/wqy`），**该路径是宿主机绝对路径**，会 bind-mount 到容器内同路径。挂上后 init 阶段由 `./scripts/00-host-fonts.sh` 跑 `fc-cache -fv` 注册到 fontconfig 缓存。
- 留空 = 不挂载 = 容器内 `/usr/share/fonts/truetype/wqy` 不存在。LosslessCut 仍能起（英文 UI 不受影响），只是 noVNC 顶栏 / 系统弹窗里的中文字符会显示为方框。
- 容器内 `jlesage ENABLE_CJK_FONT` **强制为 0**（compose 硬编码，不可由用户表单改）— 绕开 jlesage 10-cjk-font.sh 走 `apt-get install fonts-wqy-zenhei` 拉 `deb.debian.org` 的链路。`deb.debian.org` 在国内服务器上经常被 TCP 阻断 / DNS 污染，会触发 s6 init 失败 → restart: always 进入"启动→秒退"循环。

**典型填法**：

| 场景 | 1Panel 表单 `FONT_PATH` |
|---|---|
| 宿主机 Debian/Ubuntu 已 `apt install fonts-wqy-zenhei` | `/usr/share/fonts/truetype/wqy`（默认） |
| 宿主机装了 `fonts-noto-cjk` / `fonts-arphic-uming` 等其它 CJK 包 | `/usr/share/fonts/opentype/noto`（视实际路径） |
| 自己下载 `.ttc`/`.otf` 到某目录 | `/data/fonts`（任意绝对路径） |
| 只需要英文 UI | 留空 |

### VNC 密码 (VNC_PASSWORD)
- 留空 = 无密码直连 VNC（容器内网暴露，生产环境建议填）
- **注意**：VNC 协议限制 8 字符以内，超出自动截断
- 启用 HTTPS 后 VNC 也走 SSL/TLS，避免明文传输

## 文件持久化

```
./data/config/                  # 容器内 /config
├── app-config/                 # LosslessCut 用户配置（首选项、快捷键）
├── certs/                      # VNC/HTTPS 证书
│   ├── vnc-server.pem          # VNC SSL
│   ├── web-privkey.pem         # Web 私钥
│   └── web-fullchain.pem       # Web 完整证书链
└── ...
```

## GPU 加速
LosslessCut 的核心是**无损流复制**（不重编码），理论上 GPU 加速对剪裁本身无收益。**仅在以下场景需要**：
- 「Smart Cut」（关键帧精修）实验性功能需要重新编码时
- 提取帧快照

LosslessCut 容器本身基于 CPU（Electron + ffmpeg cpu 版），本应用未配置 GPU 透传，如需实验 Smart Cut 的硬件加速可参考 upstream Dockerfile 自行派生。

## 验证容器健康

```bash
# 查看 s6 服务是否正常
docker logs <container_name>

# 确认 noVNC 端口在监听
docker exec <container_name> ss -ltn | grep 5800

# 进入容器调试
docker exec -it <container_name> bash
```

## 升级
上游 outlyer-net 使用 semver tag（`3.62.0-v1`、`3.63.0-v2`、`3.64.0-v1`），LosslessCut 3.x 主版本内向前兼容。在 1Panel 重新部署时改 `<app>/<version>/docker-compose.yml` 中的 `image` tag 并复制出新版本目录。

## 状态

## 运行用户 UID / GID

安装参数 `UID` / `GID` 通过 compose 的 `user:` 指定容器内进程身份，默认 `99` / `100`。

⚠️ **首次部署前必须把数据目录属主改到同一 UID / GID**，否则容器无权写入、启动即失败：

```bash
# 以应用实际安装目录为准（1Panel → 应用 → losslesscut → 详情 → 路径）
sudo chown -R 99:100 <应用安装目录>/${MEDIA_PATH}
```

需要 chown 的目录（相对于应用安装目录）：`${MEDIA_PATH}`、`./data/config`、`./scripts/00-host-fonts.sh`

另外这些宿主机绝对路径也会被挂载进去，只需保证 uid 99 **可读**（需要写入时再单独 chown）：

- `/usr/share/fonts/truetype/wqy`

- 想以 root 运行：把 `UID` / `GID` 都填 `0`
- 升级到新版本目录后要**重新 chown 一次**（新目录下的 `data` 为空、属主是 root）
- 容器内所有新文件都以该 UID / GID 创建，宿主机上看到属主是 99:100 属正常现象
