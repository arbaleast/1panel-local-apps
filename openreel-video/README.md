# OpenReel Video

OpenReel Video 是一款**完全运行在浏览器中的开源专业视频剪辑工具**（CapCut / Premiere 的开源替代品），所有视频与音频处理在浏览器端完成——无需上传、无需安装、无水印、MIT 许可。基于 React、TypeScript、WebCodecs 与 WebGPU 构建，提供专业级多轨时间线、调色、音频混音、关键帧动画与 4K 导出能力。

- **官网**: <https://openreel.video>
- **GitHub**: <https://github.com/Augani/openreel-video>
- **License**: MIT
- **Docker 镜像**: `docker.io/helmforge/openreel-video:v0.5.0`（[HelmForge](https://helmforge.dev) 维护的双架构 linux/amd64 + linux/arm64 镜像，从 Augani 上游 release 同步构建）

## 特性

- **100% 客户端运行**：所有视频、音频、图片素材始终保留在你的设备上，不会上传到任何服务器
- **多轨时间线剪辑**：视频、音频、文本、图形多层轨道，支持拖拽、修剪、分割、波纹删除、调速
- **专业调色**：色轮、曲线、HSL 微调、LUT 应用
- **音频混音**：波形显示、音量、淡入淡出、EQ、压缩器、自动闪避
- **关键帧动画**：位置、不透明度、特效全参数可关键帧
- **字幕 / 文本**：20+ 文本动画、支持 SRT 字幕导入
- **AI 能力**（可选）：自动静音切除、节拍同步、背景移除、AI 上采样（需自带 OpenAI / Anthropic 兼容端点 API Key）
- **导出**：MP4 (H.264/H.265)、WebM (VP8/VP9/AV1)、ProRes，最高 4K / 60fps，自定义码率与帧率
- **IndexedDB 本地自动保存**，可导入 / 导出项目文件用于备份与跨设备迁移

## 目录结构

本仓库按 1Panel 应用规范组织：

```
openreel-video/
├── data.yml               # 根元数据（跨版本共享）
├── logo.png               # 应用图标
├── README.md              # 本说明
└── v0.5.0/                # 当前版本
    ├── data.yml           # 版本元数据 + formFields
    ├── docker-compose.yml
    └── data/              # 持久化占位（.gitkeep，纯静态 SPA 不需要写入）
```

## 安装

1. 1Panel → 应用商店 → 本地应用 → 选择 `openreel-video`
2. 选择版本 `v0.5.0`
3. 主机侧 HTTP 端口默认 `48080`（容器内固定 `8080`），按需修改
4. 时区默认 `UTC`，按需改为 `Asia/Shanghai` 等
5. 提交安装 → 1Panel 拉取 `docker.io/helmforge/openreel-video:v0.5.0` 镜像并启动

部署完成后访问 `http://<1Panel 主机 IP>:<HTTP 端口>` 即可打开 OpenReel Video 编辑器（首次加载会下载 WASM / WebCodecs 资源，建议 Chrome / Edge 浏览器）。

## 浏览器需求

| 浏览器 | 最低版本 | 状态 |
| :--- | :--- | :--- |
| Chrome | 94+ | 完整支持 |
| Microsoft Edge | 94+ | 完整支持 |
| Firefox | 130+ | 完整支持 |
| Safari | 16.4+ | 完整支持 |

**硬件建议**：8GB+ 内存 + 独立 GPU（4K 编辑）+ 多核 CPU。硬件编码由 WebCodecs 加速，依赖 GPU 调度。

## 反向代理 / 网关 COOP/COEP 头

OpenReel Video 依赖 **WebCodecs / WebGPU / SharedArrayBuffer** 等浏览器能力，这些能力要求页面启用**跨源隔离**（cross-origin isolation）。**HelmForge 镜像内置了 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp` 头**，但当应用部署在反向代理 / 网关 / CDN 之后，**这些头必须被透传到客户端**，否则会出现以下问题：

- 导出时报错 `SharedArrayBuffer is not defined`
- 硬件加速不可用，仅软件编码（导出慢）
- 实时预览掉帧

如果你在 1Panel 之后接了 Traefik / Nginx Proxy Manager / Cloudflare 等网关，请确保**不要剥离**这两个响应头，或者在网关层**显式添加**：

```nginx
# /etc/nginx/conf.d/openreel.conf
add_header Cross-Origin-Opener-Policy   "same-origin"   always;
add_header Cross-Origin-Embedder-Policy "require-corp"  always;
```

## 数据持久化

OpenReel Video 是**纯静态 SPA**——所有素材与编辑工程始终留在浏览器端（IndexedDB），**不会上传到任何服务器**。本容器只负责提供 HTML / JS / CSS 静态资源，**无服务端状态、无数据库、无媒体文件落盘**。

| 容器内路径 | 主机侧路径 | 用途 |
| :--- | :--- | :--- |
| `/usr/share/nginx/html` | （无） | 静态资源（应用代码） |

> **重要**：浏览器 IndexedDB 中的工程文件可能在以下情况被清除：浏览器清缓存、隐私模式、跨设备访问。建议定期用应用的「项目导出」功能备份 `.openreel` 工程文件。

## 镜像更新

`Augani/openreel-video` 上游未发布官方 Docker 镜像，本应用使用 [HelmForge](https://helmforge.dev) 维护的同步镜像 `docker.io/helmforge/openreel-video`，每次 Augani 上游 release 后 HelmForge 会同步构建并 push：

- HelmForge 镜像源：<https://hub.docker.com/r/helmforge/openreel-video>
- 镜像与官方站点 <https://openreel.video> 代码一致（Vite 静态产物 + nginx-alpine）

本应用使用 **hardcode 镜像**（`docker.io/helmforge/openreel-video:v0.5.0` 直接写死），**进入** 1Panel 自动更新守护范围：每周一 UTC 0 点（或手动触发）`.github/workflows/auto-update.yml` 会扫描 `data.yml` 与 `docker-compose.yml` 中的镜像版本，新版本会自动开 PR；合并后下次同步仓库即可在 1Panel UI 看到新版本选项。

## 常见问题

**Q: 容器能访问哪些外网？**
A: 仅浏览器到容器的 8080 端口；容器本身无对外网络依赖。OpenReel Video 是纯客户端，**容器只提供静态资源**，所有数据流都是浏览器 ↔ 你导入的本地素材。

**Q: 能不能用 OpenAI / Claude 等 AI 功能？**
A: 可以，但需要自带 API Key。在编辑器右上角"AI Editor"面板里填入 OpenAI / Anthropic 或兼容端点的 API Key，**Key 仅保存在浏览器本地**（IndexedDB），不会上传到任何服务器。AI 是可选功能，关闭 AI 后所有其他功能完全可用。

**Q: 移动设备能用吗？**
A: OpenReel Video 当前是桌面浏览器优先，移动端 UI 还在优化中（上游 roadmap 包含 mobile optimization）。iOS Safari 16.4+ 理论上支持 WebCodecs，但触控体验不如桌面。

**Q: 视频会传到云端吗？**
A: **不会**。所有视频、音频、图片处理完全在浏览器内完成（WebCodecs 硬件解码 + Canvas/WebGPU 渲染 + Web Audio 混音 + 浏览器 File System Access API 直接写盘），容器只提供应用代码。详见上游 [README](https://github.com/Augani/openreel-video#keep-control-of-your-footage)。

**Q: 与 Kdenlive / Shotcut 等原生开源剪辑器比，OpenReel 的优劣？**
A: OpenReel 完全在浏览器里跑，安装包极小（容器只 ~23MB 静态产物）、跨平台、跨设备（同一台机器任何浏览器都能用）。劣势是依赖 WebCodecs 浏览器支持（Chrome / Edge 最稳定）、无法直接读取本地文件夹批量导入（必须逐文件拖入），4K 编辑吃内存 + GPU。

**Q: 升级到新版本后旧工程还在吗？**
A: 在。工程文件存在浏览器 IndexedDB，镜像升级不影响。如需备份用编辑器内"导出项目"功能（`.openreel` 文件）。

## 许可

- 应用代码 MIT License（[Augani/openreel-video](https://github.com/Augani/openreel-video) 上游）
- HelmForge 镜像 Apache-2.0 License
- 本仓库 1Panel 应用定义仅供个人自托管使用
