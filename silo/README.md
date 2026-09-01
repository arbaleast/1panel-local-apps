# Silo — 1Panel 本地应用

Silo 是一款高性能、S3 兼容的对象存储系统，是 [MinIO](https://min.io) 的社区维护分支，由 [pgsty](https://github.com/pgsty) 团队主导维护，修复频繁、安全更新活跃。

- 项目官网：<https://silo.pgsty.com>
- 上游仓库：<https://github.com/pgsty/silo>
- 镜像仓库：<https://hub.docker.com/r/pgsty/silo>
- 许可证：**AGPL-3.0**

## 简介

Silo 与 MinIO 命令行、API、S3 SDK 完全兼容，可以作为 MinIO 的"drop-in replacement"。本应用以 `pgsty/silo` 官方镜像运行，提供：

- 🪣 **S3 兼容对象存储** — 所有 S3 SDK（`aws-cli` / `mc` / `boto3` / `minio-go`）开箱即用
- 🖥️ **Web Console** — 桶与对象的图形化管理界面
- 🔐 **访问控制** — 基于 `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` 的管理员账户
- 🚀 **多架构** — `linux/amd64` + `linux/arm64`
- 🔄 **活跃维护** — pgsty 团队持续合入上游 MinIO 修复，节奏快于官方

## ⚠️ 必填配置

部署前请重点确认以下三项：

| 变量 | 必填 | 说明 |
|------|------|------|
| `MINIO_ROOT_USER` | ✅ | S3 Access Key，至少 3 个字符。**生产环境务必替换默认值** |
| `MINIO_ROOT_PASSWORD` | ✅ | S3 Secret Key，至少 8 个字符。**生产环境务必替换默认值** |
| `APP_VERSION` | ✅ | 镜像 tag。默认 `RELEASE.2026-08-04T00-00-00Z`，可手动覆盖为其他 tag |

Silo 启动时会在日志里输出一条警告：

```
WARNING: Detected default credentials 'minioadmin:minioadmin', we recommend that you change these values
```

如果保留默认凭据部署到公网，等同于开放了无鉴权 S3 服务，**请务必修改**。

## 快速开始

1. 在 1Panel 应用商店找到 **Silo**（应用名 `silo`）
2. 选择版本 `RELEASE.2026-08`
3. 修改 `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`（必填，不要保留默认值）
4. 调整 `PANEL_APP_PORT_API`（默认 `9000`，S3 协议端口）
5. 调整 `PANEL_APP_PORT_CONSOLE`（默认 `9001`，Console 端口）
6. 点击部署，等待健康检查通过

部署完成后：

```bash
# 验证 S3 API 可达
curl -fsS http://<主机IP>:9000/minio/health/ready

# 用 mc 配置连接
mc alias set silo http://<主机IP>:9000 <MINIO_ROOT_USER> <MINIO_ROOT_PASSWORD>
mc mb silo/test-bucket
mc cp /etc/hosts silo/test-bucket/
```

## 服务端口

| 端口变量 | 默认 | 容器内 | 暴露方式 | 用途 |
|----------|------|--------|----------|------|
| `PANEL_APP_PORT_API` | `9000` | `9000` | `0.0.0.0` | S3 API（aws-cli / SDK / mc） |
| `PANEL_APP_PORT_CONSOLE` | `9001` | `9001` | `127.0.0.1` | Web Console UI |

**Console 故意只暴露在 127.0.0.1**，避免公网直接访问管理界面。如需从远程访问 Console，请通过 SSH 端口转发或 1Panel 反向代理。

## 持久化目录

| 宿主机路径 | 容器内路径 | 内容 |
|------------|------------|------|
| `./data` | `/data` | 所有 bucket 数据、对象文件、元数据 |

- 升级 / 重建容器时数据会保留
- 备份 `silo/RELEASE.2026-08/data/` 即等于备份全部桶
- 不要改回 named volume：1Panel 部署 schema 会拒绝顶层 `volumes:` 块使用 `${CONTAINER_NAME}-xxx` 变量插值命名（参见 `marginalia/0.3.4` commit `3d08ed4` 的修复）

## 镜像说明

应用采用 **变量型镜像**：

```yaml
image: pgsty/silo:${APP_VERSION}
```

`${APP_VERSION}` 由用户在 formField 中自行指定，默认指向 2026-08 月份已发布的具体 tag。

### 升级镜像

由于是变量型应用，**仓库的 auto-update 工作流不会自动改 `APP_VERSION` 字段**。如需升级：

1. 在 [Docker Hub tags](https://hub.docker.com/r/pgsty/silo/tags) 找到目标 tag（推荐精确到月份的 `RELEASE.YYYY-MM` 系列；也支持 `latest` 滚动跟随，但每次重启可能拉到不同版本，**不推荐生产使用**）
2. 在 1Panel → Silo → 参数编辑中，把 `APP_VERSION` 改为新 tag
3. 点击"重建应用"

> 注：本仓库的 [`scripts/check-updates.sh`](scripts/check-updates.sh) 与 [`.github/workflows/auto-update.yml`](.github/workflows/auto-update.yml) 只针对 **hardcode** 类应用（compose 中写死 `image:tag`）开 PR，变量型应用由用户掌控升级节奏。

### pgsty/silo vs minio/minio

| 维度 | `minio/minio`（官方） | `pgsty/silo`（本应用） |
|------|----------------------|-------------------------|
| 维护方 | MinIO, Inc. | pgsty 社区团队 |
| 更新节奏 | 较慢，季度级 | 频繁，合入上游 fix |
| 镜像 tag 命名 | `RELEASE.2024-...` | `RELEASE.YYYY-MM-...`（额外带月份前缀） |
| S3 API 兼容 | ✅ | ✅（完全兼容，可平替） |
| 许可证 | AGPL-3.0 | AGPL-3.0 |
| 多架构 | amd64 / arm64 | amd64 / arm64 |

**何时选 Silo**：

- 你希望快速获得上游 MinIO 的 bug fix / 安全补丁
- 你需要一个社区活跃维护的 S3 替代品，避免被商业化路线绑定

**何时选官方 MinIO**：

- 你需要 MinIO, Inc. 商业支持（SLA / LTS）
- 你依赖某个特定版本的行为契约

## 常见问题

### Q1：Console 在哪里访问？

**仅 127.0.0.1:9001**。Compose 中特意把 Console 端口绑到 loopback，避免公网直暴露管理界面。

如需从远程管理，有两种方式：

```bash
# 方式 A：SSH 端口转发
ssh -L 9001:127.0.0.1:9001 root@<主机IP>
# 浏览器访问 http://127.0.0.1:9001

# 方式 B：1Panel 反向代理
# 在 1Panel 网站 → 反向代理中新增一条，target 填 127.0.0.1:9001，
# 并配置 Basic Auth（用 MINIO_ROOT_USER/MINIO_ROOT_PASSWORD）
```

### Q2：如何创建第一个 bucket？

Silo 镜像**不包含自动建桶的 init 容器**。有两种方式：

```bash
# 方式 A：用 mc 命令行
mc alias set silo http://<主机IP>:9000 <user> <pass>
mc mb silo/my-bucket

# 方式 B：用 aws-cli
aws --endpoint-url http://<主机IP>:9000 s3 mb s3://my-bucket

# 方式 C：在 Console 界面登录后，桶 → 创建桶
```

### Q3：能否与 marginalia 共享同一个 Silo？

可以。本仓库的 [`marginalia`](../marginalia/README.md) 已经不再捆绑独立 MinIO 容器，而是在 formField 中允许用户填入外部 S3 endpoint。建议部署顺序：

1. 先部署 `silo`（本应用），在 Console 里手动建一个 bucket `marginalia`
2. 再部署 `marginalia`，把 `PANEL_APP_PORT_HTTP` 等配置填好
3. 在 marginalia 的参数页，把 MinIO 相关项指向 Silo：
   - `S3_ENDPOINT` = `http://<silo容器名>:9000`（同一 `1panel-network`，用容器名访问）
   - `S3_ACCESS_KEY` / `S3_SECRET_KEY` = Silo 的 `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`
   - `S3_BUCKET` = `marginalia`

### Q4：升级时如何避免数据丢失？

`./data` 是 bind mount 到容器内 `/data` 的，**升级 / 重建容器时数据不丢**。操作步骤：

1. 备份：`tar czf silo-backup-$(date +%F).tar.gz silo/RELEASE.2026-08/data/`
2. 在 1Panel → Silo → 参数编辑中改 `APP_VERSION` 到新 tag
3. 点击"重建应用"（不会删除 bind mount 目录）
4. 验证：`curl -fsS http://<主机IP>:9000/minio/health/ready`

如果想从 1Panel 的"重建" 切到"重置"，**会清空 data 目录**，请提前备份。

### Q5：健康检查失败怎么办？

`healthcheck` 探针是 `curl -fsS http://127.0.0.1:9000/minio/health/ready`。如果一直 unhealthy：

1. 查容器日志，看是否提示凭据长度不足：

   ```
   ERROR: MINIO_ROOT_USER must be at least 3 characters, MINIO_ROOT_PASSWORD at least 8 characters
   ```

2. 查主机端口是否冲突：

   ```bash
   ss -tlnp | grep -E ':(9000|9001) '
   ```

3. 磁盘空间：`df -h /var/lib/docker/` 或 1Panel 数据盘

### Q6：可以对外提供 S3 服务吗？

可以，但必须：

1. 替换默认 `minioadmin:minioadmin` 凭据
2. 在 reverse proxy（如 Nginx / Traefik）后挂载 S3 endpoint（`9000`）
3. 用 `MINIO_BROWSER_REDIRECT_URL`（暂未在本应用 formField 中暴露，需要时改 compose）固定回调域名
4. 在防火墙只开放 `9000/tcp`，**不要** 把 `9001` 暴露到公网

## 相关链接

- [pgsty/silo GitHub](https://github.com/pgsty/silo)
- [Silo 官方文档](https://silo.pgsty.com)
- [MinIO 文档（命令行完全兼容）](https://min.io/docs/minio/linux/index.html)
- [mc 命令行工具](https://min.io/docs/minio/linux/reference/minio-mc.html)
- [`marginalia` 应用](../marginalia/README.md) — 演示如何与本应用共享 S3 endpoint
