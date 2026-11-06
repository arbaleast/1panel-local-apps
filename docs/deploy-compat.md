# 部署兼容性校验与隔离冒烟测试

> 职责（唯一）：**部署兼容性**（装得上 / 起得来 / 挂载写得了 / 架构不虚报 / 硬件配置不打架）的
> 规则体系、豁免机制、隔离冒烟测试与 CI 三级门禁。
> compose 硬规则见 [compose-conventions.md](compose-conventions.md)；data.yml 字段见 [data-yml-schema.md](data-yml-schema.md)；
> 自动化链路见 [automation.md](automation.md)。

## 1. 与既有 SSOT 校验体系的关系（**不另起第二套校验器**）

部署兼容性规则**注册进** `lib/consistency.mjs` 的 `RULES` 表，实现放在 `lib/deploy-compat.mjs`，
由既有的 `bin/lint-apps.mjs` 编排。因此：

- 豁免仍用**同一份** `.github/lint-exemptions.yml`（`RULE_IDS` 由 `RULES` 派生 → 新规则自动可豁免）；
- finding 形状、输出前缀（`ERROR` / `WARN` / `UNVERIF`）、`--json` schema 与既有规则**完全一致**；
- 镜像引用解析走 `lib/image-ref.mjs`（唯一解析器），变量型镜像走 `lib/compose.mjs#resolveImageTemplate`，
  registry 请求走 `lib/registry.mjs#fetchManifest`（复用既有重试 / 限流 / 认证）。

## 2. 严重等级与三态语义

| 级别 | 含义 | lint 输出 | CI 行为 |
|---|---|---|---|
| **P0 / P1** | 必须通过 | `ERROR   ` | exit 1 → **阻塞 PR 合并** |
| **P2** | 警告提示 | `WARN    ` | `::warning::` 注解 + Summary，**不阻塞** |
| **P3** | **未验证** | `UNVERIF ` | `::notice::` 注解 + Summary，**不阻塞** |

> **P3（UNVERIFIED）的严格定义**：**「没查到」绝不等于「查过且通过」**。
> 网络不可达 / 私有源 / 限流 / 本地构建镜像 / 缺硬件 → 一律 UNVERIFIED，并在消息里写明**为什么没验**。
> P3 产出**不参与**死亡豁免条目判定（否则离线扫描会把网络类豁免误判成死条目）。

## 3. 规则全表

### 阶段 2 · Compose 静态验证与模拟渲染
| ruleId | 级别 | 判定 |
|---|---|---|
| `compose.render` | P0 | 1Panel 变量上下文下渲染失败（`${VAR:?msg}` 强制缺失 / 插值后不可序列化）；有 compose CLI 时叠加真实 `docker compose config` |
| `port.format` | P1 | 端口串须为 `C` / `H:C` / `IP:H:C`，端口号 1–65535，协议仅 tcp/udp/sctp |
| `volume.format` | P1 | target 须绝对路径；mode 取值合法；具名卷须在顶层 `volumes` 声明 |
| `compose.dep-missing` | P1 | `depends_on` / `links` / `volumes_from` 目标必须存在 |
| `compose.network-conflict` | P1 | 同服务同时设 `network_mode` 与 `networks` |
| `compose.deprecated-key` | P2 | 顶层 `version:`、服务级 `links:` |
| `compose.host-network-ports` | P2 | host 网络 + `ports`（host 模式下 ports 被忽略） |

### 阶段 3 · CPU 多架构核验
| ruleId | 级别 | 判定 |
|---|---|---|
| `arch.overdeclared` | P1 | 声明了镜像**实际未发布**的架构 |
| `arch.bucket-conflict` | P1 | 多服务镜像架构**交集为空**（木桶效应） |
| `arch.versiondir-mismatch` | P1 | 版本目录后缀蕴含的架构未被该版本镜像发布 |
| `arch.underdeclared` | P2 | 镜像发布了但应用未声明 |
| `arch.unverified` | P3 | manifest 查不到 → 显式 UNVERIFIED + 写明原因 |

### 阶段 4 · GPU / 硬件加速
| ruleId | 级别 | 判定 |
|---|---|---|
| `gpu.unconditional` | P1 | **非 GPU 专属**应用的默认 compose 硬编码 GPU 硬信号（`runtime: nvidia` / `deploy.devices` / `/dev/dri`）→ CPU 默认部署直接起不来 |
| `gpu.documented` | P1 | 含 GPU 信号但 README 未写明 nvidia 驱动 / Container Toolkit 前置条件 |
| `gpu.gated-default-on` | P2 | 硬信号变量化但 formField 默认值使其**实际默认开启** |
| `gpu.device-group-doc` | P2 | 用 `/dev/dri` 但 README 未说明 `render` / `video` 组权限 |
| `gpu.variant-dir` | P3 | GPU 专属变体目录 → 需 GPU 硬件环境实机验证 |
| `hw.devices-missing` | P2 | 映射了宿主机可能不存在的设备（`/dev/net/tun` / `/dev/kfd` / `/dev/nvidia*`） |

**GPU 专属应用白名单**（唯一允许的应用级白名单）：`llamacpp`、`infinity`、`qdrant`、`photoprism`。
其余应用（媒体服务器 / 视频处理 / 转码调度等）**默认部署必须是纯 CPU 可用**。

### 阶段 5 · 运行身份与持久化
| ruleId | 级别 | 判定 |
|---|---|---|
| `identity.user-unsupported` | P1 | compose 写死非 root `user:` 而镜像默认 root → 挂载目录属主不匹配 |
| `identity.puid-unsupported` | P2 | 声明 PUID/PGID 但**镜像 imageConfig 里没有**（依据实测元数据，不猜家族名） |
| `identity.readme-drift` | P2 | README **正向**提到 PUID/PGID 而 compose 没有（否定语境「镜像不支持 PUID/PGID」不算漂移） |
| `volume.mounted-sensitive` | P2 | rw 挂载覆盖容器内 `/etc` `/proc` `/sys` `/usr` **本身**（子路径属应用自有配置目录，合法） |
| `volume.mount-target` | P2 | 疑似宿主 / 容器路径写反（启发式，只提示不下结论） |
| `default.path-leak` | P1 | formField 默认值泄漏开发者本机绝对路径 |
| `parse.bom` | P2 | 文件带 UTF-8 BOM → 行号定位偏移 |

### 阶段 6 · 网络与依赖就绪
| ruleId | 级别 | 判定 |
|---|---|---|
| `dep.external-undeclared` | P1 | compose 把**字面量**外部 DB/Redis 端点写死且无 formField 可配 |
| `dep.external-missing` | P2 | 外部依赖在表单文案里没有任何说明 |
| `dep.ready-condition` | P2 | `depends_on` 的目标服务**没有 healthcheck** → 依赖未就绪可能启动失败 |

### 高权限（沿用既有 ruleId `runtime.high-privilege`，不新建）
覆盖面扩展到 `pid: host`、`ipc: host`、**削弱沙箱的** `security_opt`、根目录 / 敏感目录 rw 挂载、docker.sock 挂载；
`privileged: true` **且** `network_mode: host` 叠加时**升级为 P0**。
`security_opt: no-new-privileges:true` 属**加固**，不算高权限。

## 4. 端口作用域口径（**严禁误判**）

冲突键是 **（宿主机端口, 协议）**：

- 两个服务监听**同一容器端口**、映射到**不同宿主机端口** → **合法，不报**；
- 两个服务映射到**同一宿主机端口**、不同容器端口、同协议 → **ERROR**；
- `network_mode: host` 下的端口由应用自身占用，不参与宿主机端口冲突判定。

## 5. 豁免写法

与既有豁免**同一份文件** `.github/lint-exemptions.yml`：

```yaml
exemptions:
  - app: <应用目录名>
    ruleId: <上表中的 ruleId>
    version: <可选，缺省=该应用全部版本>
    value: <可选，须与 finding.actual 完全一致>
    reason: <必填非空，须有实证依据>
```

**约束**：reason 必须写**实证依据**（引用具体 file:line 或上游约定），禁止空理由与「全局豁免」；
死亡条目（应用/版本/规则已不存在）由 lint 报 error 强制清理。

## 6. 命令

| 命令 | 用途 |
|---|---|
| `npm run lint` | 全仓静态校验（**离线、不发外部请求**）：既有 SSOT 规则 + 阶段 2/4/5/6 的静态规则 |
| `npm run lint:deploy` | 同上 **+ manifest 模式**（`--manifest`）：额外做阶段 3 架构核验（只读 registry 元数据，**不 pull 镜像层**） |
| `npm run smoke -- --app <应用名>` | 对单个应用跑一次隔离沙箱冒烟测试 |
| `npm run smoke -- --changed <baseRef>` | 对本次变更涉及的应用逐个冒烟（CI 用） |

`npm run lint` 的可选开关：`--json`（机器可读）、`--manifest`（架构核验）、`--compose-cli`（真实 `docker compose config`）。

## 7. 隔离沙箱冒烟测试（阶段 7）

### 7.1 沙箱安全隔离铁律

1. **完全隔离命名空间**：临时工作目录（`os.tmpdir()` 下的 `mkdtemp`）＋ 独立
   `COMPOSE_PROJECT_NAME`（`1panel_smoke_<app>_<ts>`）＋ 独立测试网络（**绝不**碰宿主机 `1panel-network`）。
2. **端口与数据隔离**：宿主机端口动态分配、全部绑 `127.0.0.1`；所有 bind mount 指向临时目录下的新建子目录；
   **绝不**挂载任何真实用户路径。
3. **强制清理兜底**：`try/finally` ＋ `SIGINT`/`SIGTERM` 处理 → `docker compose down -v --remove-orphans` ＋ 删临时目录；
   **清理残留即 FAILED**。

### 7.2 九步流程

`plan` → `config` → `pull` → `up` → `status`（轮询，排查 Restarting/Exited/OOMKilled）→
`health`（healthcheck 或 TCP 探活）→ `persist`（挂载目录 + Permission denied）→
`logs`（致命模式扫描）→ `cleanup`。

### 7.3 三态结果

| 状态 | 含义 |
|---|---|
| `PASSED` | 9 步全过（**已实机验证**） |
| `FAILED` | 观察到故障（起不来 / 权限报错 / 日志致命错误 / 清理残留） |
| `UNVERIFIED` | 环境不具备：无 docker CLI，或**条件跳过**（GPU 硬件 / 外部数据库 / host 网络 / 特权容器 / 真实路径挂载 / 可选设备） |

> **条件跳过不是失败**：缺硬件 / 缺外部数据库的应用会被自动归入 UNVERIFIED，
> **严禁**因当前环境缺硬件而判定应用配置非法。

## 8. CI 三级门禁

| 级别 | 检查项 | 行为 |
|---|---|---|
| **Level 1** | compose 渲染、变量闭环、端口/卷合法性、SSOT 一致性、架构声明与镜像对齐 | exit 1 → **阻塞 PR 合并** |
| **Level 2** | 特权容器、host 网络、docker socket、未说明的 GPU 配置、拉不到的 manifest、需人工确认的外部依赖 | `::warning::` + Summary，**不阻塞** |
| **Level 3** | 隔离沙箱冒烟测试、GPU 硬件验证 | `PASSED` / `FAILED` / `UNVERIFIED (Skipped due to environment)`，**不阻塞** |

工作流位置：`.github/workflows/auto-update.yml` 的 `validate` job（Level 1/2）与 `smoke` job（Level 3）。

## 9. 相关文档

- [compose-conventions.md](compose-conventions.md) — compose 硬规则、运行身份、s6-overlay 禁忌
- [data-yml-schema.md](data-yml-schema.md) — formField / rule / values 约束
- [automation.md](automation.md) — 自动更新链路与 registry 选型
- [postmortems.md](postmortems.md) — 历史事故与教训
