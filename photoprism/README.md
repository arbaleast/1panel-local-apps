# PhotoPrism

自托管的 AI 照片管理应用 — Google Photos 的完全私有替代品,支持人脸识别、场景识别、地点地图、WebDAV 同步、移动端 PWA 等。

## 特性

- **AI 自动分类**:内置 TensorFlow 推理,自动识别场景、物体、质量
- **人脸识别**:自动聚类相似人脸,手动命名后即可搜索
- **地点地图**:基于 EXIF GPS 的交互式地图浏览
- **WebDAV**:支持将库挂载为系统网络盘,客户端直接编辑
- **PWA / 移动端**:自带 Web 移动端,接近原生应用体验
- **完全私有**:所有照片保留在自己的服务器上,支持外部数据库
- **多语言**:支持 50+ 界面语言

## 部署

### 前置条件(可选,使用外部 MariaDB/MySQL 时需要)

如需使用外部数据库(性能更好、支持更大库),请先在 1Panel 应用商店安装 MariaDB:
- 应用商店 → 数据库 → 搜索 "MariaDB" 或 "MySQL"
- 安装后进入详情页,记下:
  - 容器名(如 `1Panel-mariadb-ABCDEFG`)
  - 数据库名(自行创建,例如 `photoprism`)
  - 用户名(安装时自动生成)
  - 密码(安装时自动生成)

> 默认配置使用 **SQLite** 内置数据库,零外部依赖即可启动。**小于 100K 照片建议用 SQLite,性能足够**。

### 安装步骤

1. 在 1Panel 应用商店搜索 `photoprism`
2. 选择版本(默认 `260919-28c46a116`)
3. 填写必要参数:
   - **HTTP 端口**:默认 `2342`
   - **站点 URL**(`PHOTOPRISM_SITE_URL`):必填,例如 `http://192.168.1.100:2342` 或 `https://photos.your-domain.com`
   - **管理员密码**(`PHOTOPRISM_ADMIN_PASSWORD`):必填,8-72 字符
   - **时区**(`TZ`):默认 `Asia/Shanghai`
4. 如需使用外部 MySQL/MariaDB:
   - 将 `Database Driver` 切换为 `MySQL / MariaDB`
   - 填写数据库主机/端口/库名/用户名/密码
5. 点击部署

## 访问

部署完成后,浏览器访问 `http://<服务器IP>:<端口>` 即可使用。

首次进入会提示设置管理员账号(已预填 `admin`),用您填写的密码登录。

## 持久化目录

| 容器路径 | 主机路径 | 用途 |
|----------|----------|------|
| `/photoprism/originals` | `./data/photoprism/originals` | 原始照片/视频库 |
| `/photoprism/storage` | `./data/photoprism/storage` | 缩略图/缓存/SQLite 索引 |
| `/photoprism/import` | `./data/photoprism/import` | 上传/导入暂存区 |

**重要**:请将已有照片软链或复制到 `./data/photoprism/originals`,然后在 Web 端点击「索引」让 PhotoPrism 扫描入库。

## 高级配置

### 资源调优

- **小库(< 10K 照片)**:默认配置足够,2GB RAM 即可
- **中库(10K-100K)**:建议 4-8GB RAM,使用 MariaDB
- **大库(> 100K)**:建议 8GB+ RAM,使用 MariaDB,启用 MariaDB 全文索引

### 公开/隐私

- `PHOTOPRISM_PUBLIC=true`:任何人无需登录即可浏览(注意隐私)
- `PHOTOPRISM_DISABLE_REGISTRATION=true`:禁止新用户注册(推荐)
- `PHOTOPRISM_READONLY=true`:只读模式,禁止上传与索引变更
- `PHOTOPRISM_UPLOAD_NSFW=true`:启用 NSFW 检测(自动标记成人内容)

### WebDAV

PhotoPrism 自动启用 WebDAV,客户端可挂载为网络盘:
- URL: `http://<服务器IP>:<端口>/`
- 用户名/密码:与管理后台一致

支持的 WebDAV 客户端:RaiDrive(macOS/Windows)、Cyberduck、macOS Finder、Windows 文件资源管理器原生。

## 官方地址

- 官网: https://www.photoprism.app/
- GitHub: https://github.com/photoprism/photoprism
- 文档: https://docs.photoprism.app/
- Docker 镜像: https://hub.docker.com/r/photoprism/photoprism
