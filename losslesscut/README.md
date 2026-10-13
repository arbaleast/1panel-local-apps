# LosslessCut 无损视频/音频剪辑

基于 [outlyernet/losslesscut](https://github.com/outlyer-net/docker-losslesscut) 容器的浏览器内无损视频/音频剪辑工具，基于 FFmpeg **直接流复制**（不重新编码），处理 1 小时 1080p 视频通常 < 10 秒。

## 访问
- Web UI (noVNC): http://192.168.98.246:5800
- VNC 直连 (可选): `192.168.98.246:5900` (RealVNC / TigerVNC / 内置 noVNC 桥)

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

### 中文字体 (ENABLE_CJK_FONT)
- **默认 `false`（已禁用）** — 容器不会去下载字体包
- ⚠️ **为什么会默认关**：jlesage baseimage-gui 启动时若 `ENABLE_CJK_FONT=1`，会执行 `apt-get install fonts-wqy-zenhei` 从 `deb.debian.org` 下载文泉驿正黑字体包。在国内/防火墙/网络受限服务器上 `deb.debian.org` 经常连不上（DNS 被污染 / TCP 阻断 / HTTPS 中间证书问题），导致 s6 init 脚本退出非 0 → 服务启动失败 → `restart: always` 把容器拉入**启动→秒退→再启动**的死亡循环。
- **如何开启**：先确认宿主机到 `deb.debian.org` 443 端口畅通（`curl -v https://deb.debian.org/`），再在 1Panel 表单把 `ENABLE_CJK_FONT` 切到 `true`。
- **LosslessCut UI 没中文字体的影响**：英文界面照常使用（LosslessCut 默认就是英文 UI），仅 Web noVNC 顶栏的窗口标题 / 错误信息 / 系统弹窗里的中文字符会显示为方框。剪辑功能不受影响。
- **彻底解决方案（推荐）**：派生一个自定义镜像，预先 `apt-get install fonts-wqy-zenhei && apt-get clean` 后 commit，避免每次启动重新下载。

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
