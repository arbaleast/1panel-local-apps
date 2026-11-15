# gemini-web2api

> Gemini 网页端 → OpenAI 兼容 API（MIT）。
> 上游仓库：<https://github.com/zexadev/gemini-web2api-go>
> 上游文档：<https://github.com/zexadev/gemini-web2api-go/blob/main/README.md>

## 简介

`gemini-web2api-go` 把 Gemini 网页端（`gemini.google.com`）逆向反代为 OpenAI 兼容 API。
它不是 Google 官方 API 的二次封装，所以**不需要 Google API Key，也不消耗付费配额**。

同一端口同时提供：

| 表面 | 路径 |
|------|------|
| OpenAI 兼容 | `POST /v1/chat/completions`、`GET /v1/models` |
| Gemini 原生 | `/v1beta/...`（Google SDK 可直接用） |
| MCP 工具 | 同端口（供支持 MCP 的客户端调用） |
| 媒体生成 | 图片 / 音乐 / Canvas / 视频（需挂登录态 cookie，视频还要 Pro 号） |
| 管理面板 | `http://<宿主机IP>:<端口>/admin`（token 鉴权） |

单 Go 二进制、Chrome TLS 真指纹、Cookie 池（多账号）与代理池、SQLite / MySQL / PostgreSQL，
自带中文管理面板。**默认匿名可跑**（免登录，模型档位低一档）；挂上 Google 账号 cookie 后
多出 `gemini-3.1-pro`、思考链、读图读视频、生图 / 音乐 / 画布 / 生视频等登录态能力。

## 许可证

MIT。上游仓库：`zexadev/gemini-web2api-go`。

## ⚠️ 部署前必读

1. **镜像在 GHCR**：`ghcr.io/zexadev/gemini-web2api-go:v4.28.0`。国内机器拉不动 GHCR 时，
   先给 Docker 配 GHCR 加速（1Panel「容器 → 配置 → 镜像加速」或 daemon 配置里的 `registry-mirrors`）。
2. **容器以非 root 运行**：镜像是 distroless static + `USER nonroot`，容器内进程 **uid/gid = 65532**。
   `./data` 由 `scripts/init.sh` 在启动前 chown 到 `65532:65532`；若你的 1Panel 不执行 init 脚本
   （或手工 `docker compose up`），请先执行：
   ```bash
   sudo chown -R 65532:65532 ./data
   ```
   否则启动日志会报 `unable to open database file (14)`。
3. **需要能访问 `gemini.google.com`**：本机网络不通时用面板「代理池」导入代理；代理被风控约
   2 小时后自恢复（面板「熔断冷却」控制）。
4. **单 IP 有速率墙**：实测突发 80–180 次请求后被重定向到 sorry 页。默认限流
   `并发 5 / RPM 30 / RPH 80`，要放大产能就配代理池，别把默认值当无限额度。
5. 这是**逆向实现**，Google 前端协议变化时上游会跟进发版；本应用由自动更新守护 tag，
   但升级前请看一眼上游 Release Notes。

## 快速开始

1. 在 1Panel 应用商店搜索 **Gemini Web2API** 并安装。
2. 部署参数页填写：
   - **HTTP 端口**：宿主机端口，默认 `8083`（容器内固定 `8083`）
   - **管理令牌**：面板登录 token，**必填**（8–30 位字母数字；留空等于面板不鉴权，1Panel 表单会拦截空值）
   - **时区**：默认 `Asia/Shanghai`
3. 等待容器启动，访问 `http://<宿主机IP>:<端口>/admin`，用「管理令牌」登录。
4. 面板「设置」页看 **API Key**（首次启动自动生成，可轮换）；客户端用它调 `/v1/*`。
5. 面板「Cookie 池」按需导入 Google 账号 cookie（见下文）。

## 安装参数

| 参数 | 默认 | 说明 |
|------|------|------|
| HTTP 端口 | `8083` | 宿主机映射端口；容器内固定 `8083` |
| 管理令牌 | （必填） | 面板 `/admin` 的登录 token；同时是 `ADMIN_TOKEN` 环境变量 |
| 时区 | `Asia/Shanghai` | 容器 `TZ`，影响日志与面板里的时间显示 |

> 其余可调项（默认模型、限流额度、重试、TLS 指纹、bl 版本、严格模型校验、多轮续接、临时对话、
> 自动删会话、流式保活、降级开关、打印请求日志等）全部在**面板「设置」页**，保存即生效，不用重启容器，
> 所以**没有**放进 1Panel 安装表单。

## 服务端口

| 端口 | 用途 | 暴露策略 |
|------|------|----------|
| 8083 | OpenAI 兼容 API + Gemini 原生 + MCP + 管理面板（容器内固定） | 对外（`${PANEL_APP_PORT_HTTP}` 映射到宿主机端口） |

1Panel 反代指向宿主机端口即可。若只想给内网其他容器用，也可以把端口映射改成 1Panel 的
`127.0.0.1` 绑定后走反代。

## 客户端接入

Base URL 填 `http://<宿主机IP>:<端口>/v1`，API Key 填面板「设置」页里的 `sk-gemini-...`：

```bash
curl http://<宿主机IP>:8083/v1/chat/completions \
  -H "Authorization: Bearer sk-gemini-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

- **newapi / one-api 建渠道**：渠道类型选 OpenAI，Base URL 填 `http://<容器名或IP>:8083`
  （同 1panel-network 内直接用容器名），密钥填面板里的 API Key，模型填 `gemini-3.6-flash` 等。
- **OpenAI SDK**：`base_url="http://<宿主IP>:8083/v1"`，`api_key="sk-gemini-..."`。

## Cookie 池（可选）

匿名即可用，但登录态才有多出来的能力：

1. 浏览器登录 <https://gemini.google.com>，F12 → Application → Cookies → `https://gemini.google.com`；
2. 复制 `SID` / `HSID` / `SSID` / `APISID` / `SAPISID` / `__Secure-1PSID` / `__Secure-1PSIDTS`；
3. 面板「Cookie 池 → 添加账号」粘贴，保存即生效，可导入多个账号。

要点：

- **Chrome 导出的 cookie 可能续不了命**（Device Bound Session Credentials 会把会话绑在设备上，
  `__Secure-1PSIDTS` 换发 401）；用 **Firefox** 导出的 cookie 可以长期续。
- 生视频（`gemini-video`）只有 Pro / 付费号可用，免费号会被内容政策拒。
- cookie 是否失效靠鉴权失败判断：连续 3 次鉴权失败才自动停用；纯文本请求即使 cookie 过期也照样 200
  （上游会当匿名处理），所以「能用」不等于「登录态还在」。

## 数据持久化

| 宿主机路径 | 容器内 | 内容 |
|------------|--------|------|
| `./data/gemini.db` | `/data/gemini.db` | SQLite：API Key、Cookie 池、代理池、全部运行时配置、请求历史 |

备份直接备份 `./data` 即可。想换 MySQL / PostgreSQL：手工在 compose 里加 `SQL_DSN` 环境变量
（`mysql://user:pass@host:3306/db` 或 `postgres://user:pass@host:5432/db?sslmode=disable`），
建表自动完成；单机用默认 SQLite 最省事。

## 常见问题

| 现象 | 处理 |
|------|------|
| 启动即退出、日志 `unable to open database file (14)` | `./data` 属主不对，见上文「部署前必读」第 2 条 |
| 拉镜像失败 / `manifest unknown` | GHCR 网络问题，配镜像加速；或确认 tag `v4.28.0` 是否存在 |
| 面板打不开 / 403 | `/admin` 需要「管理令牌」；忘了就改 1Panel 应用参数里的 `ADMIN_TOKEN` 后重启 |
| 请求 429 / 被重定向到 sorry 页 | 本机 IP 被限流，加代理池或调低 RPM/RPH |
| 想要 `gemini-3.1-pro` 但列表里没有 | 该模型要登录态：先在 Cookie 池导入账号 |
| 升级 | 1Panel 重新部署即可，数据在 `./data` 不丢 |

## 上游限制

- Function calling 是 prompt 级实现，模型不保证每次按格式返回。
- 长上下文有两堵墙：请求体约 13 万字节、附件内容约 16 万字节；挂 cookie 只能把可用长度提到约 16 万。
- token 数用 tiktoken 估算，与真实 Gemini tokenizer 有偏差。
- 深度研究（多步异步流程）未实现。
