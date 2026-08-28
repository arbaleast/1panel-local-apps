# 御坂网络弹幕服务 (Misaka Danmu Server)

自托管弹幕（Danmaku）聚合与管理服务，兼容弹弹play API 规范。

通过刮削主流视频网站弹幕，为个人媒体库提供统一、私有的弹幕API，自带现代化 Web 管理界面。

## 功能特性

- 兼容弹弹play API 规范，可作为 Plex / Jellyfin / Emby 等媒体服务器的弹幕后端
- 支持 MySQL 与 PostgreSQL 数据库
- 支持多架构镜像（amd64 / arm64）
- 内置 Web 管理界面，支持元数据源配置、弹幕源管理
- 支持通过 Docker socket 进行一键重启和更新

## 部署前置条件

应用需要外置数据库，**部署前请在 1Panel 中提前创建好 MySQL 或 PostgreSQL**：

- MySQL 默认端口 3306，或 PostgreSQL 默认端口 5432
- 创建数据库（如 `danmuapi`）
- 创建用户并授权访问该数据库

## 配置说明

| 字段 | 说明 |
|---|---|
| HTTP 端口 | Web UI 与 API 端口，默认 7768 |
| 数据库类型 | `mysql` 或 `postgresql` |
| 数据库地址/端口/名称/用户/密码 | 填入 1Panel 中创建的数据库信息 |
| JWT 密钥 | 用于 API 签名的密钥，**强烈建议设置一串随机字符串** |
| 管理员账号 | Web UI 登录用户名，默认 `admin` |
| 用户 ID / 组 ID | 进程运行身份，默认 1000 |

## 访问

部署完成后，访问 `http://<服务器IP>:<HTTP端口>` 进入 Web 管理界面。

## 数据持久化

应用配置与数据保存在 `./data/config` 目录，包含：
- 配置文件
- 日志
- Web UI 上传的离线资源包

## 官方文档

- 文档站点：https://docs.misaka10876.top/
- GitHub：https://github.com/l429609201/misaka_danmu_server

## 许可

AGPL-3.0
