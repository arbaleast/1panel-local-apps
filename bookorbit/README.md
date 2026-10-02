# BookOrbit

[neon](https://github.com/neonsolstice) 开发的开源自托管数字阅读平台，统一管理你的 **电子书 / 有声书 / 漫画 / PDF**，内置浏览器阅读器、iPhone / Apple Watch 原生 App、Kobo / KOReader / BookOrbit 三方阅读进度与高亮双向同步、14 个元数据源、多用户隔离 + OIDC/SSO、Send-to-Kindle、OPDS、统计与 50+ 成就。

- **GitHub**: <https://github.com/bookorbit/bookorbit>
- **官网 / 文档**: <https://bookorbit.app>
- **安装指南**: <https://bookorbit.app/installation>
- **Docker 镜像**: `ghcr.io/bookorbit/bookorbit`（多架构 `linux/amd64` + `linux/arm64`）
- **当前版本目录**: `3.2.0/`（与上游 [GitHub release tag v3.2.0](https://github.com/bookorbit/bookorbit/releases/tag/v3.2.0) 对齐；镜像 tag 不带 `v` 前缀）
- **License**: AGPL-3.0

## 功能要点

### 阅读体验与同步

- **内置浏览器阅读器**：EPUB / KEPUB / MOBI / AZW3 / AZW / FB2 / PDF / CBZ / CBR / CB7 / M4B / M4A / MP3 / OPUS / OGG / FLAC，**无需任何额外插件**
- **iPhone / Apple Watch 原生 App**：离线下载、播放、Apple Watch 独立播放与进度回收；需 BookOrbit v3.0.0+ / iOS 26+ / watchOS 26+
- **Kobo + KOReader + BookOrbit 三方同步**：阅读进度、批注 / 高亮在三个端之间双向流动
- **批注 / 高亮合并**：Web reader + KOReader + Kobo 的高亮聚合成可检索中心，支持按颜色 / 风格 / 来源筛选，可导出为 Markdown / CSV / JSON
- **Hardcover / Readwise / StoryGraph 自动同步**：状态、进度、阅读日期、评分按可配置触发器推送至高亮到 Hardcover / StoryGraph / Readwise
- **统计、目标、成就**：每日阅读时长、热力图、连击、库健康度、年度目标、月度挑战、5 大类 50+ 成就；Reading DNA 基于真实会话历史为你的阅读风格画像

### 库管理

- **多库**：每个库独立文件夹、自定义扫描规则、格式优先级
- **14 个元数据源**：Google Books / Open Library / Amazon / Goodreads / Kobo / Hardcover / Audible / Audnexus / Libro.fm / iTunes + ComicVine（漫画）/ RanobeDB（轻小说）/ Aladin（韩文）/ Lubimyczytac（波兰文）；封面另从 iTunes / DuckDuckGo / AudiobookCovers 拉取
- **Smart Scopes & Collections**：规则化的动态筛选器与策划列表

### 平台与分发

- **多用户 + SSO**：细粒度权限 + 隔离的阅读数据；原生支持 Authentik / Keycloak / Authelia 的 OIDC
- **多语言界面**：[Crowdin](https://crowdin.com/project/bookorbit) 社区翻译
- **内容分发**：OPDS 目录、Send-to-Kindle（邮件）、浏览器拖拽上传
- **Book Dock 自动入库**：把文件丢入指定目录，BookOrbit 自动识别格式、抓元数据、审阅、入库

## 目录结构

```
bookorbit/
├── data.yml                 # 根元数据（跨版本共享）
├── logo.png                 # 应用图标（取自 bookorbit.app 官方 mark）
├── README.md                # 本说明
└── 3.2.0/                   # 当前版本（与上游 GitHub release tag v3.2.0 对齐，镜像 tag 为 3.2.0）
    ├── data.yml             # 版本元数据 + formFields
    ├── docker-compose.yml
    └── data/                # 持久化占位（.gitkeep）
        ├── books/           # ← 首次启动前由用户填充电子书 / 漫画 / 有声书 / PDF
        ├── app/             # ← 应用配置 / 缓存 / 上传
        └── postgres/        # ← PostgreSQL 18 + pgvector 数据
```

## 安装

> ⚠️ **强制要求（上游 README 明确标注）**：NAS / 网络存储配置 **不受支持**。`./data/books`、`./data/app`、`./data/postgres` 都必须是本地文件系统（ext4 / btrfs / xfs 等），不要放在 SMB / CIFS / NFS / FUSE / 云挂载 / 分布式文件系统上，否则扫描、移动、重命名、文件通知、权限、缓存与一致性可能行为异常。详见上游 README 的「Unsupported Storage Configurations」段。

1. 1Panel → 应用商店 → 本地应用 → 选择 **BookOrbit**
2. 选择版本 `3.2.0`
3. **必填参数（首次部署前必须修改）**：
   - `POSTGRES_PASSWORD`：PostgreSQL 密码，建议 `openssl rand -hex 24`
   - `JWT_SECRET`：JWT 签名密钥，建议 `openssl rand -hex 32`
   - `SETUP_BOOTSTRAP_TOKEN`：首次安装一次性引导 Token，建议 `openssl rand -hex 16`
   - `APP_URL`：外部访问 URL，例如 `http://your-server-ip:48300`（反向代理后改为 `https://books.example.com`）
4. 主机侧 HTTP 端口默认 `48300`（容器内 `3000`）
5. PostgreSQL 端口默认 `48332`（容器内 `5432`；仅用于外部管理）
6. **挂载目录属主**：若宿主机 `./data/books` 不属于 `1000:1000`（NAS 套件常见），在主机侧执行：
   ```bash
   chown -R 1000:1000 bookorbit/3.2.0/data/books
   ```
   否则首次扫描会因 `EACCES` 找不到书
7. 把你的书（EPUB / PDF / CBZ / M4B …）放入 `bookorbit/3.2.0/data/books/`
8. 提交安装
9. 等 ~30s，浏览器访问 `http://<1Panel 主机 IP>:48300`，使用上面设置的 `SETUP_BOOTSTRAP_TOKEN` 完成管理员账号创建

## 配置

### 表单字段

| 字段 | 默认值 | 必填 | 说明 |
|------|--------|------|------|
| 应用镜像 | `ghcr.io/bookorbit/bookorbit` | 是 | GHCR 官方多架构镜像 |
| 应用版本 | `3.2.0` | 是 | 上游 GitHub release tag（如未来要跟随上游 `v3.2.1` release，先确认 GHCR 是否真的推了 `3.2.1` tag） |
| HTTP 端口 | `48300` | 是 | 主机侧端口（容器内固定 `3000`） |
| PostgreSQL 端口 | `48332` | 是 | 主机侧端口（容器内固定 `5432`） |
| PostgreSQL 用户名 | `bookorbit` | 是 | 同时供 PostgreSQL 与 BookOrbit app 使用 |
| PostgreSQL 密码 | （空） | 是 | **首次部署前必须修改**；建议 `openssl rand -hex 24` |
| PostgreSQL 数据库名 | `bookorbit` | 是 | 与用户名同名即可 |
| JWT Secret | （空） | 是 | **首次部署前必须修改**；建议 `openssl rand -hex 32` |
| Setup Bootstrap Token | （空） | 是 | **首次部署前必须修改**；首次登录时使用，建议 `openssl rand -hex 16` |
| 外部访问 URL | `http://your-server-ip:48300` | 是 | 公网部署务必改为反代域名（如 `https://books.example.com`），影响 Kobo 端点回调与邮件链接 |
| Process UID | `1000` | 否 | 与宿主机 `./data/books` 属主一致，NAS 用户常需调整 |
| Process GID | `1000` | 否 | 同上 |
| Node.js 堆内存 (MB) | `auto` | 否 | 250K+ 书的库建议显式设 `4096` 或 `8192` 防 OOM；`auto` = 容器自适应 |
| 时区 | `Asia/Shanghai` | 否 | 容器时区 |

### 高级配置（手动）

`docker-compose.yml` 只覆盖了上游 docker-compose 模板的必需 / 常用字段。如需开启以下功能，请直接编辑主机侧 `bookorbit/3.2.0/docker-compose.yml` 的 `app.environment`：

- `EMAIL_ENCRYPTION_KEY`：存储 SMTP 凭据加密密钥（启用 SMTP 时强烈建议设置）
- `MIGRATION_ENCRYPTION_KEY`：存储迁移源凭据加密密钥
- `BOOK_REQUEST_ENCRYPTION_KEY`：启用下载客户端 / 索引器凭据前必填
- `DISABLE_LOCAL_AUTH=true`：配置 OIDC 后可禁用本地密码登录（至少 1 个管理员绑定 OIDC 后再开）
- `OIDC_ALLOW_LOCAL_ISSUERS=true`：允许 OIDC 解析内网地址（**仅受信自托管网络**）
- `BOOK_DOCK_PATH=/data/book-dock`：自定义 Book Dock 文件夹
- `LIBRARY_BROWSE_ROOT=/books`：库创建时只允许选择 `/books` 下子目录
- `LOG_LEVEL=debug`：日志详细度
- `BOOKORBIT_FIX_PERMISSIONS=false`：禁止容器自动修复 `/data` 属主（如平台外部已管理）
- `CLIENT_URL=https://app.example.com`：前端与后端不同域名时设置 CORS

### 启用 Kokoro TTS（可选）

BookOrbit v2.10+ 支持 Kokoro FastAPI TTS。上游提供 opt-in `tts` profile，启用方式：

```yaml
# 在 bookorbit/3.2.0/docker-compose.yml 中追加（仅参考，未启用）：
# services:
#   kokoro:
#     container_name: ${CONTAINER_NAME}-kokoro
#     image: ghcr.io/remsky/kokoro-fastapi-cpu:v0.8.0
#     profiles: ["tts"]
#     ...
# app.environment 中追加：
#   KOKORO_API_BASE_URL: http://kokoro:8880/v1
```

详细见上游 [Kokoro Text-to-Speech](https://bookorbit.app/text-to-speech/)。

## 升级

### 跟随上游 release（跨版本升级）

1. 新建 `bookorbit/<new-version>/` 目录
2. 把 `3.2.0/` 下的 `docker-compose.yml` 与 `data.yml` 复制到新目录
3. 在新 `data.yml` 中把 `APP_VERSION` 默认值同步改成新版本号（如 `3.3.0`）
4. 由 1Panel 计划任务拉取最新仓库 → 用户在 1Panel UI 选择新版本重新部署

> 由于 `./data/app`、`./data/books`、`./data/postgres` 均为相对路径 bind mount，跨版本升级数据不会丢失；上游 BookOrbit 在启动时自动跑数据库迁移。

### 容器内升级（不重建容器）

上游暂不提供容器内一键升级（与 Grimmory 不同）；跨版本升级均通过 1Panel 重建新版本容器完成。

## 反向代理

如需在 80/443 公网入口后挂 BookOrbit：

- **Nginx / OpenResty**：
  ```nginx
  server {
    server_name books.example.com;
    listen 443 ssl http2;
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    client_max_body_size 0;   # 上传大文件 / 漫画 / 有声书

    location / {
      proxy_pass http://127.0.0.1:48300;
      proxy_set_header Host              $host;
      proxy_set_header X-Real-IP         $remote_addr;
      proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_read_timeout 3600s;
    }
  }
  ```
- **Caddy**：`books.example.com { reverse_proxy localhost:48300 }`
- **Cloudflare Tunnel / FRP**：直接透传到 48300 即可

**反代后必须**：
1. 把 1Panel 表单中的 `APP_URL` 改为 `https://books.example.com`（否则 Kobo 端点回调与邮件链接会指向 LAN IP）
2. 重启容器让 `APP_URL` 生效

## 故障排查

- **首次启动后浏览器一直转圈 / 503**：等 `start_period: 60s`，再访问；上游 Node 服务首次启动要跑数据库迁移 + 准备 `.env`，耗时较长
- **扫描完成但找不到书**：
  1. 检查 `PUID`/`PGID` 是否与 `./data/books` 属主一致（`ls -ldn ./data/books`）
  2. 不一致就 `chown -R <uid>:<gid> ./data/books`
- **登录页提示「Invalid setup token」**：1Panel 表单中 `SETUP_BOOTSTRAP_TOKEN` 被 trim（含空格/换行），重新填一次
- **`POSTGRES_PASSWORD is required` / `JWT_SECRET is required` / `SETUP_BOOTSTRAP_TOKEN is required`**：compose 强校验未读到值，重新填表单调起
- **POSTGRES 健康检查失败 / 数据目录残留**：v2.2.0 起上游将 bundled PostgreSQL 从 `pg16` 升级到 `pg18`；从老版本跨版本升级会报 `database files are incompatible with server`，详见上游 [Moving from PostgreSQL 16 to 18](https://bookorbit.app/installation/#updating)
- **`EACCES` / `permission denied`**：见上文「挂载目录属主」
- **iOS / Apple Watch App 连不上自托管服务器**：检查反代后 `APP_URL` 是否已更新为公网域名，且 iOS 设备能访问该域名（HTTPS + 受信证书）

## 参考

- [上游 BookOrbit README](https://github.com/bookorbit/bookorbit/blob/main/README.md)
- [上游 BookOrbit 安装指南](https://bookorbit.app/installation)
- [iOS / Apple Watch App](https://apps.apple.com/us/app/bookorbit-the-official-app/id6811807346)（v3.0.0+ / iOS 26+ / watchOS 26+）
- [KOReader 插件](https://bookorbit.app/koreader-plugin)
- [演示站](https://demo.bookorbit.app)（无需账号，含公版书样本库；部分管理功能受限）
