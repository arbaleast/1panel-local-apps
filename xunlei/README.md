# Xunlei 远程下载

Xunlei（迅雷）是国内主流的下载客户端，本应用使用 [cnk3x/xunlei](https://github.com/cnk3x/xunlei) 镜像——从群晖（Synology）NAS 平台提取并适配到通用 Linux / Docker 环境的**迅雷远程下载套件**。提供网页面板 + 远程控制（手机迅雷 App 扫码登录），支持 BT、磁力、HTTP/HTTPS/FTP/电驴等任务。

> **非迅雷官方项目**。仅供研究学习测试使用，迅雷账号体系与会员权益归迅雷公司所有。

- **GitHub**: <https://github.com/cnk3x/xunlei>
- **License**: MIT（包装层）/ 迅雷原生协议（运行时）
- **上游镜像**: `cnk3x/xunlei:beta`（DockerHub + GHCR 双源，双架构 `linux/amd64` + `linux/arm64`）

## 功能要点

- 网页面板：实时查看任务进度、上传/下载速度、做种状态、磁盘占用
- 协议支持：BT / magnet、HTTP / HTTPS / FTP、ed2k（电驴）、迅雷云盘网页取回
- 远程控制：用手机迅雷 App 扫码登录后，可从手机端直接推送下载链接到 1Panel 主机
- HTTP Basic Auth 可选开启（`XL_DASHBOARD_USERNAME` / `XL_DASHBOARD_PASSWORD`）
- 调试日志开关 `XL_DEBUG`，故障排查用
- 跨架构：amd64 (x86_64) + arm64 (aarch64) 一镜像双覆盖，树莓派 / N100 / Apple Silicon Mac mini NAS 等都能直接跑

## 目录结构

按 1Panel 应用规范组织：

```
xunlei/
├── data.yml               # 根元数据（跨版本共享）
├── logo.png               # 应用图标（来自 pan.xunlei.com 官方）
├── README.md              # 本说明
├── data/                  # 持久化占位（首次安装时建子目录 data/、downloads/）
└── beta/                  # 当前版本
    ├── data.yml           # 版本元数据 + formFields
    └── docker-compose.yml
```

## 安装

1. 1Panel → 应用商店 → 本地应用 → 选择 `xunlei`
2. 选择版本 `beta`（上游 cnk3x 实际仅维护 `beta` 滚动 tag）
3. 默认配置即可点击安装，必填项已预填：
   - HTTP 端口 `2345`（容器内固定监听）
   - 主机名 `1panel-xunlei`（迅雷 App 端显示的设备名）
   - 数据路径 `./data`（宿主机侧，会自动建 `data/data` + `data/downloads`）
   - UID/GID 默认为 `0`（root）；如需用普通用户请改成 1Panel 容器用户对应的 `1000:1000` 等
4. 提交安装 → 容器启动后首次会从 `https://down.sandai.net/nas/nasxunlei-DSM7-x86_64.spk` 拉取 SPK 套件并解压运行（容器内联网即可，约 50MB）
5. 等约 30 秒（healthcheck start_period），浏览器访问 `http://<1Panel 主机 IP>:2345` 打开迅雷远程下载面板

## 配置

### Web Basic Auth（可选）

默认 Web 面板无密码——因为 1Panel 端口通常只在局域网或反代后暴露。如果直接暴露公网，强烈建议在 `XL_DASHBOARD_USERNAME` 和 `XL_DASHBOARD_PASSWORD` 字段填入用户名 / 密码（任一留空 = 不开启）。填写后重启容器生效。

### UID / GID

迅雷下载到本地的文件归属默认是 `root:root`，普通账号可能读不到。建议改成 1Panel 容器用户的 UID/GID（通常是 `1000:1000`）。修改后请把 `data/downloads/` 下的旧文件 chown 到新用户：

```bash
chown -R 1000:1000 /opt/1panel/apps/local/xunlei/xunlei/beta/data/downloads/
```

### 主机名

`HOSTNAME` 字段是迅雷 App 端显示的「设备名」，可填中文（如「客厅 NAS」）。改完重启容器，App 端刷新即可看到新名字。**注意**：迅雷 App 按 hostname 区分设备，不同 1Panel 主机之间 hostname 不要重名，否则手机端会把两台设备的下载任务混在一起。

### 调试日志

遇到下载失败、SPK 拉取报错等问题时，把 `XL_DEBUG` 改为「启用」重启容器，日志会输出详细诊断信息。问题解决后改回「禁用」避免日志体积过大。

### 镜像源

- 默认 `ghcr.io/cnk3x/xunlei:beta`（GitHub Container Registry，跨国稳定）
- 国内可改为 `cnk3x/xunlei:beta`（DockerHub，海外节点拉取可能较慢）
- 阿里云镜像仓库（推荐国内）：`registry.cn-shenzhen.aliyuncs.com/cnk3x/xunlei:beta`（上游 README 提及的国内加速源）

切换镜像源后请重启容器。

## 数据持久化

| 容器内路径 | 主机侧路径 | 用途 |
| --- | --- | --- |
| `/xunlei/data` | `./data/data` | 程序数据：登录态、账号、下载进度、任务历史 |
| `/xunlei/downloads` | `./data/downloads` | 默认下载保存目录（迅雷面板里可改） |

容器重启 / 升级不会清空这些数据；卸载应用再装时只要 `data/` 目录还在，登录态与任务进度都会保留。

## 镜像更新

上游使用 GitHub Actions 在每次 push 时自动构建 `cnk3x/xunlei:beta`（GHCR 同名 tag 同步）。本应用使用变量型镜像（`${IMAGE}:${APP_VERSION}`），不在 1Panel 自动更新守护范围；如需升级：

1. 1Panel → 本地应用 → Xunlei → 升级
2. 选择 `beta` 目录（无需更换版本号，`:beta` tag 本身就是滚动最新）

如需切换到具体历史版本（如 `3.22.0-beta`），可把 `APP_VERSION` 字段填为该版本号 + 重启容器——但 cnk3x 后续修复和新功能都只推 `beta`，长期使用建议保持 `beta`。

## 常见问题

**Q: 安装后浏览器访问 2345 端口一直 502 / 拒绝连接？**
A: 三步排查：
1. 等 30 秒以上——首次启动要从 `down.sandai.net` 拉 SPK 套件（容器内联网）；host 网络环境下要确保容器能访问外网
2. 容器日志里看 `/xlp` 是否正常启动（`docker logs <container>`）；如有 SPK 拉取失败，可改 `XL_SPK` 环境变量（compose 需手动加）指向其他镜像源
3. 防火墙：1Panel 主机是否放行了 2345 端口（systemd / firewalld / ufw / iptables）

**Q: 迅雷 App 扫码登录提示「设备不存在」？**
A: 检查容器内 `hostname` 是否与 1Panel 填的 `HOSTNAME` 一致；迅雷 App 按 hostname 索引设备，1Panel 自动重命名容器时可能与预期不一致。改完 `HOSTNAME` 后**完全卸载并重新安装**应用，让容器 hostname 同步生效。

**Q: 下载到 NAS 后 SMB 共享看不到？**
A: 默认 UID/GID 是 `0`（root），SMB 共享配置可能过滤了 root 写文件。改成 NAS 普通用户的 `1000:1000`，并 chown 旧文件（见 UID/GID 段）。

**Q: 升级到新版镜像后任务历史没了？**
A: 任务历史存在 `./data/data/.drive/` 里，只要 `data/` 目录还在，升级镜像不会丢数据。如果真的丢了，**先检查 bind mount 路径是否正确**——compose 里 `${DATA_PATH}/data:/xunlei/data`，是 `${DATA_PATH}` 的子目录 `data`（不是 `${DATA_PATH}` 自身）。

**Q: 不想走 cnk3x 镜像，能用迅雷官方 Docker 镜像吗？**
A: 迅雷官方目前**没有提供**通用 Linux 的 Docker 镜像，只有群晖 / 威联通 NAS 套件和 Windows 客户端。cnk3x 是从群晖套件提取并打包的社区方案，是目前唯一能在 1Panel / Linux 上跑迅雷远程下载的途径。

**Q: 上游 `beta` tag 算不算「稳定版」？**
A: cnk3x 仓库的实际发布流程：每次 push main → GHCR Actions 构建 → 同时打 `beta`（滚动）+ 数字版本号 tag（如 `4.0.0-beta`）。**`beta` 是上游唯一持续维护的 tag**，数字版本号 tag 只在重要版本节点打（如 3.20 / 3.22 / 4.0.0），平时修复都只在 `beta` 滚动。日常使用 `beta` 即可，不要切到 `latest`（2 年没更新，是早期群晖套件内置版）。

## 许可

- 包装层（Dockerfile / entrypoint）MIT（cnk3x）
- 运行时：迅雷原生二进制，归迅雷公司所有
- 本仓库 1Panel 应用定义仅供个人自托管使用
