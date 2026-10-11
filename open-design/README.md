# Open Design

> **Apache-2.0** 开源设计工具，定位为 [Claude Design](https://www.anthropic.com/news/claude-design) 的替代品。
> 容器内跑 daemon + Next.js 静态 Web UI，单一 Alpine 镜像（`ghcr.io/nexu-io/od`）监听 7456 端口。
> 由 agent CLI 驱动（Claude Code / Codex / DeepSeek Harness / Cursor / OpenCode 等 25+ 兼容，BYOK），覆盖原型、Landing Page、Dashboard、PPT、图片、视频，可导出 HTML / PDF / PPTX / MP4。

- 项目主页：<https://open-design.ai>
- 上游仓库：<https://github.com/nexu-io/open-design>
- 上游部署文档：<https://github.com/nexu-io/open-design/blob/main/deploy/README.md>
- 1Panel 端口：默认 `7456`（容器内固定，Web UI 与 API 同端口）

---

## 安装

1. 在 1Panel 应用商店找到 **Open Design**，选择版本 `0.24.1`；
2. **必填 `OD_API_TOKEN`**：在主机上运行 `openssl rand -hex 32`，把 64 字符的 hex 串填入表单；
3. Web UI 端口默认 `7456`（容器内固定；如冲突请改 1Panel 端口字段，**不要**改容器内端口）；
4. 镜像默认 `ghcr.io/nexu-io/od:0.24.1`，可手动切换到其它 tag；
5. 其它字段保持默认即可，时区按需调整；
6. 部署完成后在 1Panel 应用详情页点击「访问」打开 Web UI。

### 首次访问

浏览器打开 `http://<1panel-host>:<port>/` 时，daemon 会弹出 HTTP Basic 认证框：

- **用户名**：`open-design`（上游硬编码）
- **密码**：你在表单里填入的 `OD_API_TOKEN` 值

这是 **by design** 的：上游把 open-design 定位为「桌面 app 配套 daemon」，web UI 是同进程的副产物，HTTP Basic 框是为了防止 localhost 之外裸暴露。

> 如果你把 daemon 放在 1Panel 反代后面被外网访问，**强烈建议**在 1Panel 反代侧启用 HTTPS + 访问控制；上游明文写道：*“The shared API token is single-tenant authentication, not user-level access control.”*

---

## 配置参考

| 字段 | 默认 | 说明 |
|---|---|---|
| `IMAGE` | `ghcr.io/nexu-io/od:0.24.1` | Docker 镜像，可切到任意已发布 tag 或 `@sha256:...` digest |
| `PANEL_APP_PORT_HTTP` | `7456` | 1Panel 反代端口；容器内端口固定 `7456` |
| `OD_API_TOKEN` | （必填，留空） | 浏览器 HTTP Basic 密码 / `Authorization: Bearer` 头；用 `openssl rand -hex 32` 生成 |
| `OD_DISABLE_API_AUTH` | `0` | 仅当上游有受信反向代理已做鉴权时才设为 `1`；1Panel 默认反代不做鉴权，**请保持 0** |
| `OD_ALLOWED_ORIGINS` | （留空） | CORS 白名单；留空则只允许同源（`http://<1panel-host>:<port>`）。多源用逗号分隔 |
| `TZ` | `Asia/Shanghai` | 时区 |

---

## 持久化数据

`./data/` 绑定挂载到容器内 `/app/.od`，存放 daemon 运行期数据（项目、缓存、用户态）。容器以非 root 用户 `open-design` (uid 1001) 运行；如曾用旧版以 `node` 用户 (uid 1000) 运行过 `ghcr.io/nexu-io/od` 容器并迁移到本仓，请先 chown：

```bash
sudo chown -R 1001:1001 ./data
```

---

## 与上游 `deploy/docker-compose.yml` 的差异

| 项 | 上游 base compose | 1Panel 适配 | 原因 |
|---|---|---|---|
| 端口绑定 | `127.0.0.1:${PORT}:7456` | `${HOST_IP}:${PANEL_APP_PORT_HTTP}:7456` | 1Panel 反代必须监听全接口 |
| 持久化 | named volume `open_design_data` | bind mount `./data:/app/.od` | 1Panel 拒绝顶层 volumes 块用 `${...}` 插值命名卷（AGENTS.md 强制） |
| 镜像来源 | `${OPEN_DESIGN_IMAGE:-ghcr.io/nexu-io/od:latest}` | `${IMAGE}` | 与 mihomo/handbrake/hindsight 风格一致；default 由 formField 注入 |
| 网络 | 默认 bridge | `1panel-network: external: true` | AGENTS.md 强制 |
| `OD_BIND_HOST` | `0.0.0.0`（base）/ `127.0.0.1`（Linux override） | `0.0.0.0` | 1Panel 反代必须 0.0.0.0；host 装了 agent CLI 的高级场景不在本仓覆盖范围 |
| `host agent CLI 挂载` | linux override 提供 | 不提供 | 1Panel 场景下用户主机 agent CLI 不在容器内；如需自己挂，可手工改 compose |
| `healthcheck` | 已有 | 保留 | `GET /api/health` |
| `mem_limit` | `${OPEN_DESIGN_MEM_LIMIT:-384m}` | 改用 `deploy.resources.limits.memory: ${MEMORY_LIMIT}` | 与 handbrake/hindsight 风格一致；1Panel UI「限制」面板会同步 |
| `restart: always`, `read_only: true`, `tmpfs: [/tmp]`, `security_opt: no-new-privileges`, `pids_limit: 256`, 非 root user (uid 1001) | 全部保留 | — | 上游安全模型保持完整 |

---

## 升级

1Panel 应用商店会同步上游 release。`crossVersionUpdate: true` 开启后，单版本镜像升级只需把 `IMAGE` 字段改为新 tag；如需新增版本目录到本仓，参考 `open-design/0.24.1/` 直接复制再修改 `IMAGE` default 即可。

---

## 故障排查

- **浏览器一直弹 HTTP Basic 框** → 检查 `OD_API_TOKEN` 是否与表单一致（区分大小写）。
- **跨源被拒 / `CORS` 报错** → 填 `OD_ALLOWED_ORIGINS`，多源用逗号分隔；留空仅允许同源。
- **`/api/health` 不返回 200** → 容器首次启动需 20-60s（`start_period: 20s`），稍等。
- **容器反复重启** → 多半是 `OD_API_TOKEN` 未填或端口冲突；查看 `docker logs <container>`。
- **Web UI 打开空白** → 浏览器缓存；或 daemon 启动后 `/apps/web/out` 静态资源未生成（极少见，重启容器）。
- **`Permission denied` 写 `/app/.od`** → 旧版容器用 `node` (uid 1000)，本仓用 `open-design` (uid 1001)；按上文「持久化数据」chown 修复。
