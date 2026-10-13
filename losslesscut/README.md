# LosslessCut 无损视频/音频剪辑

基于 [outlyernet/losslesscut](https://github.com/outlyer-net/docker-losslesscut) 容器的浏览器内无损视频/音频剪辑工具，基于 FFmpeg **直接流复制**（不重新编码），处理 1 小时 1080p 视频通常 < 10 秒。

## 访问（默认 Web UI，**不需要 VNC 客户端**）

应用基于 jlesage/docker-baseimage-gui，**同时**提供两种 GUI 通道：

| 通道 | 端口 | 用途 | 性能 |
|---|---|---|---|
| **Web UI (noVNC)** ← 推荐 | 5800 | 浏览器直接打开 http://&lt;host&gt;:5800，HTML5 Canvas 渲染，键盘 / 鼠标 / 剪贴板全支持 | VNC over WebSocket，CPU 开销 1-3% |
| VNC 直连（可选） | 5900 | RealVNC / TigerVNC / Remmina 等原生 VNC 客户端 | RFB 协议，省 WebSocket 封装 |

**默认走 Web**。jlesage noVNC 用 H.264 / JPEG / WebP 编码，比早期 noVNC 的纯 RAW 帧快很多，浏览器剪片 1080p 时 CPU 占用在 1-3%，**不比本地 Electron 慢多少**。1 小时 1080p 视频几秒切完，是 LosslessCut 后端 FFmpeg `-c copy` 流复制在干活，**网络传输只负责鼠标键盘和画面**，不传视频数据本身。

**何时才需要 VNC 客户端**：只在 noVNC 浏览器兼容性有问题时（极少数旧浏览器 / 移动端）。**绝大多数情况**浏览器就够了。

## 上游
- 应用: [mifi/lossless-cut](https://github.com/mifi/lossless-cut) (LosslessCut 3.64.0)
- 容器镜像: [outlyernet/losslesscut](https://hub.docker.com/r/outlyernet/losslesscut) (基础镜像 [jlesage/docker-baseimage-gui](https://github.com/jlesage/docker-baseimage-gui), Debian + s6-overlay)
- 镜像 tag: `3.64.0-v1` (2024-11-09 发布)

## 用途
- 无损剪裁视频/音频（基于关键帧，FFmpeg `-c copy`）
- 提取片段、合并多段、重新混流 (remux) 到不同容器
- 提取单帧快照、提取所有音轨/字幕轨
- 视频元数据查看/编辑、章节标记、旋转方向元数据
- 批量处理（手动，不支持 CLI 调度）

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
