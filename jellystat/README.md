# Jellystat

免费的 Jellyfin 开源统计应用（Tautulli 替代品）。

## 功能特性

- **会话监控与日志**：实时监控 Jellyfin 用户观看会话
- **媒体库统计**：查看各媒体库的使用情况和统计数据
- **用户统计**：按用户统计观看时长、频率等内容
- **播放历史**：完整记录所有播放历史
- **用户概览与活动**：了解用户活跃度和偏好
- **数据备份与恢复**：支持配置和数据的备份与恢复
- **自动同步媒体库**：自动同步 Jellyfin 媒体库项目
- **Jellyfin 统计插件集成**：支持 Jellyfin 原生统计插件数据导入

## 快速开始

### 前提条件

- Jellyfin 服务器（已安装并运行）
- PostgreSQL 数据库（Jellystat 使用 PostgreSQL 存储数据）

### 部署说明

1. 在 1Panel 应用商店搜索 "Jellystat" 并安装
2. 配置 PostgreSQL 数据库连接信息
3. 设置 JWT 密钥（建议 16 位以上随机字符串）
4. 设置时区
5. 点击安装

### 必需配置

| 参数 | 说明 |
|------|------|
| JWT Secret Key | JWT 加密密钥，建议 16 位以上 |
| PostgreSQL Host | PostgreSQL 数据库地址 |
| PostgreSQL Port | PostgreSQL 端口，默认 5432 |
| PostgreSQL Username | 数据库用户名 |
| PostgreSQL Password | 数据库密码 |
| PostgreSQL Database | 数据库名称，默认 jfstat |
| Timezone | 服务器时区 |

### 可选配置

| 参数 | 说明 | 默认值 |
|------|------|--------|
| PostgreSQL SSL | 启用 SSL 连接 | false |
| Use Emby API | 使用 Emby 而非 Jellyfin | false |
| Reject Self-Signed Certs | 拒绝自签名证书 | true |
| Min Playback Duration | 最小播放时长（秒），过滤短播放 | 1 |

## 数据持久化

应用数据通过 Docker volume 持久化存储，包括：

- 用户配置数据
- 统计历史数据
- 播放记录

## 支持与反馈

- [GitHub Issues](https://github.com/CyferShepard/Jellystat/issues)
- [Discord 社区](https://discord.gg/9SMBj2RyEe)

## 注意事项

- Jellystat 需要连接 Jellyfin 服务器获取数据
- 首次启动后通过 Web UI 完成初始化配置
- 建议定期备份 PostgreSQL 数据库
- 项目正在重构中，后续版本将有重大架构更新

## 许可证

MIT License
