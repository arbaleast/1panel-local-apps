# cfui

cfui 是一个用于 **Cloudflare Tunnel (`cloudflared`)** 的 Web 控制面板。运行本地隧道进程、通过 Cloudflare API 管理 Cloudflare Tunnel 入口规则、为 DDNS 场景更新 DNS 记录、通过 WebDAV 暴露 S3 兼容存储，并提供面向 AI 客户端的 MCP 端点。

## 功能特性

- **本地 Cloudflare Tunnel 运行器**：在浏览器中管理多个 Cloudflare Tunnel 配置；粘贴 Cloudflare Tunnel token；独立启停每个隧道配置。
- **Remote Tunnel Manager**（可选）：通过 Cloudflare API 管理 Cloudflare 托管的隧道入口配置。
- **DDNS**（可选，复用 Remote Tunnel Manager 凭据）：检测公网 IPv4/IPv6，创建和更新 Cloudflare A / AAAA 记录。
- **S3 WebDAV**：将一个或多个 S3 兼容存储桶挂载为 WebDAV 端点，支持通用 S3 兼容服务和 Cloudflare R2 预设。
- **MCP 接入**（可选）：在 `/mcp` 提供 Model Context Protocol 端点。
- **本地访问保护**（可选）：通过 Features 页面启用用户名/密码登录，使用 Argon2id 加密存储。
- **Cloudflare OAuth 控制台**（可选）：以 OAuth 方式管理 Cloudflare 账户资源。
- **国际化 UI**：内置英文、中文、日文翻译。

## 安装说明

1. 在 1Panel 应用商店选择 **cfui** 并安装。
2. 默认会暴露主 Web 端口 `14333`。访问 `http://<主机IP>:<端口>` 打开控制面板。
3. **强烈建议** 在公开网络部署前，先在 `Features` → `Local access protection` 启用本地访问保护（用户名/密码登录）。
4. Cloudflare Tunnel 凭据可在 `Tunnel Configuration` 页面粘贴保存；Remote Tunnel Manager / DDNS / R2 等可选功能凭据在对应功能页面填写，也可通过环境变量预置。
5. 详细参数说明、S3 WebDAV 用法、Cloudflare API 权限要求请参考上游文档：<https://github.com/dockers-x/cfui>。

## 数据持久化

- 配置文件（SQLite 数据库）：`./data/data.db`
- 日志目录：`./logs/`

## 安全提示

- 不要将 cfui 直接暴露到公网，必须通过可信的访问控制层（反向代理 + 鉴权 / Cloudflare Access / 本地访问保护）。
- Tunnel token、Cloudflare API token、S3 密钥、WebDAV 密码均为敏感信息，请妥善保管。
- 优先使用范围受限的 Cloudflare API Token 而非全局 API Key。
- 若凭据被误传到日志、聊天、Shell 历史记录或截图中，请立即轮换。

## 常见问题

### 隧道无法启动
- 确认 Tunnel token 正确。
- 在 UI 中查看最近的日志输出。
- 身份验证/配置错误不会自动重试。

### Remote Tunnel Manager 无法加载配置
- 确认选择了正确的 Tunnel 配置。
- 确认该配置的 Account ID 与 Tunnel ID。
- 在 Remote Tunnel Manager 页面验证 API Token 权限。

### DDNS 不更新
- 先启用 Remote Tunnel Manager。
- 确认 API Token 拥有 `Zone -> DNS -> Edit` 权限。
- 确认已配置 IP 源 URL；可使用手动同步查看最近错误。

### S3 WebDAV 无法列出文件
- 检查 S3 endpoint、region、bucket name、path-style 模式、凭据。
- R2 用户请使用 R2 S3 endpoint + R2 S3 凭据（Access Key ID / Secret Access Key）。
- 使用 UI 中的 S3 / WebDAV 测试按钮进行诊断。

## 项目地址

- 源码：<https://github.com/dockers-x/cfui>
- 镜像：<https://github.com/dockers-x/cfui/pkgs/container/cfui> / <https://hub.docker.com/r/czyt/cfui>
- 许可证：MIT
