# Super Productivity

高级待办事项应用，支持时间盒（Timeboxing）与时间追踪。

## 功能特性

- **任务管理**：使用子任务、项目和标签组织任务，支持颜色标记
- **时间盒与追踪**：番茄钟（倒计时）、Flowtime（流量模式）、倒计时专注会话
- **健康习惯**：休息提醒、反拖延工具、专注模式
- **数据追踪**：个人数据统计，了解工作习惯
- **平台集成**：支持从日历、Jira、Trello、GitHub、GitLab、Gitea、OpenProject、Linear、ClickUp、Redmine、Nextcloud Deck 和 Azure DevOps 导入任务
- **数据同步**：通过 SuperSync（端到端加密自托管同步服务）、Dropbox 或 WebDAV 同步数据
- **隐私优先**：不收集任何数据，无需注册账号，数据存储位置由你决定

## 快速开始

### 1Panel 安装

1. 在 1Panel 应用商店中找到 **Super Productivity**
2. 选择版本 `v19.1.0`
3. 填写配置参数（见下方参数说明）
4. 点击安装

### 配置参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| HTTP 端口 | 主机侧访问端口 | `48080` |
| 容器内端口 | nginx 监听端口（一般不需修改） | `80` |
| 时区 | 影响日志时间戳 | `UTC` |
| WebDAV 地址 | 留空则不启用 WebDAV 同步 | （空） |
| WebDAV 用户名 | WebDAV 认证用户名 | （空） |
| WebDAV 路径 | WebDAV 同步文件夹路径 | （空） |
| 同步间隔（分钟） | 自动同步间隔 | （空） |
| 启用压缩 | WebDAV 同步时压缩数据 | `false` |
| 启用加密 | WebDAV 同步时端到端加密 | `false` |

### WebDAV 同步配置

填写 **WebDAV 地址**、**用户名**、**路径**三项即可启用 WebDAV 同步。

> **注意**：配置 WebDAV 同步后，首次启动应用后需在应用的「设置 → 同步」中确认同步方向和细节。

### 访问

安装完成后，通过 `http://<你的服务器IP>:<HTTP端口>` 访问应用。

## 数据说明

本应用为纯前端单页应用（SPA），核心数据（任务、项目、设置等）存储在浏览器端的 **localStorage / IndexedDB** 中。

通过 WebDAV 同步配置，数据可同步至用户自建的 WebDAV 服务器（如 Nextcloud、群晖等），实现多设备共享。

如需完全离线使用，不配置 WebDAV 即可。

## 安全建议

- 默认情况下无需密码即可访问 Web UI
- 暴露至公网时，**强烈建议**通过反向代理（HTTPS） + 认证插件（Authelia、oauth2-proxy 等）保护访问
- WebDAV 传输建议配合 HTTPS 使用

## 官方资源

- 官网：https://super-productivity.com
- Web 应用：https://app.super-productivity.com
- GitHub：https://github.com/super-productivity/super-productivity
- 社区讨论：https://github.com/super-productivity/super-productivity/discussions
