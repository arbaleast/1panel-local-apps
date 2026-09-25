# Grimmory

[Grimmory](https://github.com/grimmory-tools/grimmory) 是一个**自托管的数字图书馆**，用来统一管理你的电子书、漫画和音频书。它在容器内运行 Spring Boot + React 服务，内置浏览器阅读器、多用户隔离、KOReader / OPDS 设备同步，以及 BookDrop 文件夹自动入库。

镜像来源：[`ghcr.io/grimmory-tools/grimmory`](https://github.com/grimmory-tools/grimmory/pkgs/container/grimmory)（多架构，semver tag 例如 `v3.5.0`，加 `nightly` 与 `latest`）。
上游部署模板：[`deploy/compose/docker-compose.yml`](https://github.com/grimmory-tools/grimmory/blob/develop/deploy/compose/docker-compose.yml)。
文档：[grimmory.org/docs](https://grimmory.org/docs)。

许可证：**AGPL-3.0**。

## 特性

- **多格式支持**：EPUB、MOBI、AZW、AZW3、FB2、PDF、CBZ / CBR / CB7、M4B / M4A / MP3 / OPUS
- **智能书架**：基于规则的书架（custom + dynamic）、标签、全文搜索
- **元数据可编辑**：从 Google Books / Open Library / Amazon 拉取并手动修正
- **多用户隔离**：每个用户独立书架、阅读进度与权限（支持本地 + OIDC 认证）
- **设备同步**：KOReader 进度同步、OPDS 目录下载、原生应用通过 WebDAV
- **BookDrop 自动入库**：把文件丢入 `bookdrop/` 文件夹，Grimmory 自动识别格式、抓取元数据并入队审核
- **内置浏览器阅读器**：PDF / EPUB / CBZ 浏览器内渲染，支持批注、高亮、阅读进度跟踪
- **一键分享**：向 Kindle、邮箱或其他用户直接发送某本书
- **两种存储模式**：
  - `LOCAL`（默认）：完整支持 UI 上的文件操作（删除 / 移动 / 重命名）
  - `NETWORK`：当 `data/books` 挂载在 NFS / SMB 时，禁用写类文件操作，避免对共享存储造成破坏性更改

## 快速开始

1. 在 1Panel 应用商店中搜索 **grimmory**，选择 `3.5.0` 版本，点击安装。
2. 部署参数中**必改**：
   - `DB_PASSWORD`（MariaDB grimmory 用户密码）
   - `MYSQL_ROOT_PASSWORD`（MariaDB root 密码）
3. 保持 `APP_USER_ID` / `APP_GROUP_ID`（默认 `1000`）与宿主机挂载目录属主一致：
   ```bash
   chown -R 1000:1000 grimmory/3.5.0/data
   ```
4. 部署完成后浏览器访问 `http://<服务器IP>:<端口>`，首次启动需创建管理员账号。
5. 启动后可通过 `http://<服务器IP>:<端口>/api/v1/healthcheck` 检查健康状态。

## 部署参数

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `PANEL_APP_PORT_HTTP` | 是 | `6060` | 宿主机 HTTP 端口（映射到容器 6060） |
| `TZ` | 是 | `Asia/Shanghai` | 容器时区 |
| `APP_USER_ID` | 是 | `1000` | 容器进程用户 UID，与宿主机挂载目录属主一致 |
| `APP_GROUP_ID` | 是 | `1000` | 容器进程用户 GID，与宿主机挂载目录属主一致 |
| `PANEL_DB_PORT` | 是 | `3306` | MariaDB 宿主机端口（仅供外部管理，grimmory 内部通过 `mariadb:3306` 访问） |
| `DB_PASSWORD` | 是 | `ChangeMe_Grimmory_2025!` | MariaDB grimmory 用户密码（首次部署前必须修改） |
| `MYSQL_ROOT_PASSWORD` | 是 | `ChangeMe_MariaDBRoot_2025!` | MariaDB root 密码（首次部署前必须修改） |
| `API_DOCS_ENABLED` | 是 | `true` | 暴露 `/api/openapi.json` 与 `/api/docs` |
| `SWAGGER_ENABLED` | 是 | `true` | 在 `/api/docs` 页面附带 Swagger UI 调试界面 |
| `FORCE_DISABLE_OIDC` | 是 | `false` | 强制关闭 OIDC 登录（上游反代已提供 SSO 时启用） |
| `DISK_TYPE` | 是 | `LOCAL` | `LOCAL`（默认）或 `NETWORK`（NFS/SMB 挂载时禁用写类文件操作） |

## 数据持久化

| 容器路径 | 宿主机路径 | 用途 |
|----------|------------|------|
| `/app/data` | `./data/grimmory` | 应用运行时数据（数据库迁移缓存、用户头像、临时文件） |
| `/books` | `./data/books` | 书架数据（EPUB / PDF / CBZ / 音频等） |
| `/bookdrop` | `./data/bookdrop` | BookDrop 监控目录（丢入此目录的文件会被自动识别 + 入库） |
| `/config` | `./data/mariadb` | MariaDB 数据库文件（linuxserver 镜像约定路径） |

> 备份建议：定期备份 `data/books`（书架内容）、`data/grimmory`（运行时元数据）、`data/mariadb`（数据库）三个目录。

## BookDrop 用法

BookDrop 是 Grimmory 的「丢入即入库」机制：

1. 把电子书 / 漫画 / 有声书文件（EPUB / PDF / CBZ / M4B 等）直接复制到 `data/bookdrop/`。
2. Grimmory 后台扫描器定期检测新文件，提取元数据并加入待审队列。
3. 在 Web UI 的「BookDrop」页面预览、调整元数据，确认后即可加入正式书架。

> BookDrop 不会自动从 `data/bookdrop/` 移动文件，确认入库后文件仍保留在原位置。

## 存储模式切换

如果你的 `data/books` 实际挂载在 NFS / SMB 上：

- 启动前设置 `DISK_TYPE=NETWORK`，UI 上的删除 / 移动 / 重命名按钮会被禁用，避免对共享存储造成破坏性更改。
- 阅读、查询、元数据抓取、KOReader 同步等所有只读 / 元数据操作不受影响。

## 常见问题

- **健康检查一直 `starting` / 端口 502**：首次启动会初始化数据库 schema 与管理员账号，请等待 1-2 分钟；若长时间未恢复，检查 MariaDB 容器日志（`grimmory-...-mariadb` 容器名），确认 `DB_PASSWORD` / `MYSQL_ROOT_PASSWORD` 已修改。
- **写入权限报错 `EACCES`**：调整 `APP_USER_ID` / `APP_GROUP_ID` 与宿主机挂载目录属主一致（`chown -R 1000:1000 ./data`）。
- **数据库连接失败**：先确认 `DB_PASSWORD` 在两个地方（`grimmory` 服务的 `DATABASE_PASSWORD` 与 `mariadb` 服务的 `MYSQL_PASSWORD`）**完全一致**。如果已部署过旧密码版本，建议清空 `data/mariadb` 后重新部署。
- **NFS / SMB 上传后无法删除**：切到 `DISK_TYPE=NETWORK`。
- **跨版本升级**：`crossVersionUpdate: true`，1Panel UI 会自动滚动到上游最新稳定版；如需固定版本，部署后修改 compose 中的 `image` tag 与版本目录名。

## 官方地址

- 仓库：<https://github.com/grimmory-tools/grimmory>
- 文档：<https://grimmory.org/docs>
- 镜像：<https://github.com/grimmory-tools/grimmory/pkgs/container/grimmory>
- 演示：<https://grimmory.org>（如已开放）
