# Aria2

完善的 aria2 Docker 镜像，支持 AriaNg WebUI、aria2b 吸血客户端屏蔽、回收站、任务自动转移等功能。

## 两个版本说明

### a2b-latest（推荐）

集成 [aria2b](https://github.com/SuperNG6/aria2b) 可屏蔽迅雷、qq旋风、影音先锋、百度网盘等吸血客户端。适合公网 BT 下载用户。

需要开启 `NET_ADMIN` 能力并挂载 `/lib/modules`。

### latest（标准版）

标准 aria2，仅包含核心下载功能。适合不需要吸血客户端屏蔽的用户。

## 主要特性

- 内置 [AriaNg](https://github.com/SuperNG6/AriaNg) 增强版 WebUI，任务列表可直接展开文件清单
- BT/磁力任务可按文件大小筛选下载内容
- 可选 aria2b 屏蔽吸血客户端（a2b 版本）
- 回收站、文件自动转移、按扩展名/关键词/正则过滤
- 磁力链接自动保存种子并重命名
- 重复任务自动检测
- 自动更新 tracker
- 支持 PUID/PGID 权限控制

## 部署说明

### 关键配置

| 参数 | 说明 |
|------|------|
| `SECRET` | RPC 密钥，**请务必修改为随机字符串**，默认值 `yourtoken` 为公开密钥 |
| `PUID` / `PGID` | 运行用户 UID/GID，通过 `id <username>` 获取 |
| `A2B` | 是否启用 aria2b 屏蔽（仅 a2b 版本） |

### a2b 版本特殊要求

a2b 版本需要以下额外配置：

1. **能力添加**：`cap_add: - NET_ADMIN`
2. **内核模块挂载**：`/lib/modules:/lib/modules:ro`

### 附加功能配置

回收站、移动任务、文件过滤等附加功能通过 `/config/setting.conf` 配置，修改即时生效，无需重启容器。详细说明请参考上游 [README](https://github.com/SuperNG6/docker-aria2)。

### 端口说明

- **6800**：RPC 连接端口（WebUI 连接用）
- **8080**：WebUI 端口（内置 AriaNg）
- **32516**：BT/TCP 监听端口
- **32516/udp**：DHT/UDP 监听端口

### 安全提醒

1. **务必修改 `SECRET`**：默认值 `yourtoken` 为公开 token，公网部署若不修改将面临安全风险
2. **BT 端口**：部分网络 6881 等端口已被封禁，可通过 `BTPORT` 环境变量修改
3. **aria2b**：会使用 iptables/ipset 修改防火墙规则，需要 `NET_ADMIN` 能力

## 文档

- 上游文档：https://superng6.github.io/docker-aria2
- Docker Hub：https://hub.docker.com/r/superng6/aria2
- GitHub：https://github.com/SuperNG6/docker-aria2
