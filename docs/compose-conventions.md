# Docker Compose 编写规范与运行时约定

> 职责（唯一）：compose 文件硬规则、环境变量声明、容器运行身份（PUID/PGID/UID/GID）与容器运行时坑。
> schema/formField 明细见 [data-yml-schema.md](data-yml-schema.md)；目录流程见 [app-structure.md](app-structure.md)。

## 1. Compose 硬规则（红线）

- 主服务: `container_name: ${CONTAINER_NAME}`
- 所有服务: `restart: always`、`networks: [1panel-network]`、`labels: {createdBy: "Apps"}`
- `1panel-network` 必须声明为 external
- 公开端口: 使用 `PANEL_APP_PORT_*` 变量（命名按语义：`PANEL_APP_PORT_HTTP` / `HTTPS` / `API` 等）
- 持久化挂载: 优先使用 `./data/...` 相对路径
- 镜像引用: 一律 hardcode 直接写 `image: <repo>:<tag>`，由自动更新守护（见 [automation.md](automation.md)）。
  例外清单（变量型）：`silo`（RELEASE 时间戳 tag 超出版本识别能力）、
  `infinity/cu124`（`cu124` 功能型 tag 单段、无法用版本比较选型）、`xunlei`（上游仅 `beta` 浮动 tag）、
  `immich/v3.0.3`（机器学习镜像按安装表单在 CPU 版 `v3.0.3` 与 CUDA 版 `v3.0.3-cuda` 间切换，
  写成 `${ML_IMAGE}:${ML_IMAGE_TAG}`；tag 段仍是常规版本号，自动更新照常守护）。

## 2. 环境变量声明

- compose 中每个 `${...}` 变量必须在版本 `data.yml` 的 formFields 中声明（`envKey` 对应）。
- 1Panel 自动提供的变量可豁免：`${CONTAINER_NAME}`、`${HOST_IP}`、`${HOST_ADDRESS}`、
  `${PANEL_DB_PORT}`、`${CPUS}`、`${MEMORY_LIMIT}`。
- compose 环境变量名必须与上游实际读取名一致（上游读 `HINDSIGHT_CP_HOSTNAME` 而非
  `HINDSIGHT_CP_HOST`）——以 Dockerfile / 启动脚本 / `.env.example` 交叉验证。

## 3. 顶层 volumes 命名卷的 1Panel 限制

1Panel 用 Go json-schema 严格校验顶层 `volumes` 键名，**拒绝 `${...}` 插值命名卷**
（`'${CONTAINER_NAME}-xxx' not allowed`）。需要按容器名区分的持久化数据一律改用相对路径 bind mount
（如 `./data/minio:/data`），并删除顶层 `volumes:` 块。

## 4. 端口与配置生命周期

- **端口变更会影响反向代理配置**：改端口时须同步评估 1Panel 反代设置，并在 PR 描述中说明。
- `sed -i` 在 bind mount 上会失败（跨设备），需要原地改挂载文件时用 tempfile + 原地覆写 + mv 回。
  注意：换 inode 的覆写（tempfile + mv）对「新配置文件生成」是安全的，但对「容器已持有的 bind-mount 文件」
  不适用（容器持旧 inode）——配置生成要走 init.sh 的原地覆写（见 §7）。

## 5. 容器运行身份（PUID/PGID/UID/GID）

2026-11 起本仓给每个应用提供运行身份安装参数，默认 `99` / `100`（与 `kdenlive` / `openshot` /
`unmanic` 的既有口径一致）。**两套机制互斥，选错会启动失败**——先判机制，再选参数名：

| 镜像类型 | 判定依据 | 机制 | 宿主机 chown |
|---|---|---|---|
| 镜像原生支持 PUID/PGID | Dockerfile 有 `ENV PUID/PGID` 或 entrypoint 里 `chown` + `su-exec`/`gosu`/`usermod` 降权 | formField `PUID`/`PGID` + compose `environment` 透传 | **不需要**（镜像自己 chown） |
| 官方镜像（无 PUID/PGID、非 s6） | 无 `USER` 指令、无降权 entrypoint | formField `UID`/`GID` + compose `user: "${UID}:${GID}"` | **必须**手工 `chown -R 99:100 <安装目录>/data` |
| s6-overlay（linuxserver/* 等） | 日志出现 `s6-overlay-suexec` | PUID/PGID（**禁止** `user:`，见 §6） | 不需要 |
| Postgres 系（pgvector / silo） | `initdb` 需 root chown `PGDATA` | **不提供**该参数 | — |
| 官方镜像自带非 root `USER` 且内部目录由该 UID 持有（`collabora/code`） | 镜像 config 有 `User: 1001`，`/opt/cool` 属主同 UID | **不提供**该参数（沿用镜像内置身份） | — |

判定方法：`curl -sS https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<Dockerfile>` 看
`USER` / `PUID` / `PGID` / `chown` / `su-exec` / `gosu` 关键词；entrypoint 脚本
（`entrypoint.sh` / `exec.sh` / `start.sh`）里出现 `chown -R ${PUID}:${PGID}` + `exec su-exec ${PUID}:${PGID}`
即为 PUID 家族。**已知 PUID 家族**：`anirss` `aria2` `bookorbit` `handbrake` `ignis` `kdenlive`
`misaka` `moviepilot` `openshot` `optimisarr` `syncthing` `tdarr` `unmanic` `xunlei`。

用 `user:` 的应用要在 README 中写清「先 chown 再启动」，`UID`/`GID` 做成 `type: number` formField。

## 6. s6-overlay / PID 1 禁忌

- **使用 s6-overlay 的镜像不能加 `init: true`**：s6要求自身是 PID 1，`init: true` 让 tini 抢占 PID 1 →
  `s6-overlay-suexec: fatal: can only run as pid 1` → 启动失败并被 `restart: always` 反复重拉
  （photoprism 2026-10-03 复盘，见 [postmortems.md](postmortems.md#photoprism-inittrue-事故2026-10-03)）。
- 同源禁忌：不给这类镜像加 `user:`（s6 无 root 无法降权启动）或 `pid:`（直接改写 PID 1）。
- 全仓自查：`grep -rn --include="docker-compose.yml" -E "^\s*init:\s*true" .`
  （`bookorbit/3.2.0` 仍保留 `init: true`，改动前需确认镜像是否用 s6-overlay）。

## 7. init.sh 配置生成约定

- 应用只认 `config.yaml` 且上游默认配置不可信时，必须**自己生成配置**：静态二进制（Go + viper/mapstructure）
  用 **Go 字段名**（小写无下划线）匹配键，上游随镜像生成的默认 config 往往是 snake_case →
  **读不进来且被静默忽略**。差分探测法：每次只改一个键跑一遍，用启动日志可观测量（监听端口、并发数、
  订阅路径）精确判定（正则抓数字，避免时间戳假阳性）。
- `scripts/init.sh` 按 1Panel 安装参数生成配置并挂进容器：写文件**原地覆写**（不用 tempfile + mv，
  避免 bind mount 换 inode 后容器仍持旧文件）；数据目录固定用 compose 同级 `./data`，
  不读 `.env` 里可能存在的 `DATA_PATH`。
- source 1Panel 写出的 `.env` 前**先改名再 source**：`UID`/`GID` 是 bash 只读变量，
  `set -e` 环境下直接中断。参考实现：[cfnb/v1.0.1/scripts/init.sh](../cfnb/v1.0.1/scripts/init.sh)。
  ```sh
  ENV_TMP="${WORKDIR}/.env.tmp"
  sed -e 's/^UID=/RUN_UID=/' -e 's/^GID=/RUN_GID=/' "${ENV_FILE}" > "${ENV_TMP}"
  set -a; . "${ENV_TMP}"; set +a; rm -f "${ENV_TMP}"
  ```

## 相关文档

- [data-yml-schema.md](data-yml-schema.md) — formField / rule / values 约束
- [app-structure.md](app-structure.md) — 版本目录与部署链路
- [automation.md](automation.md) — compose 变更进入自动校验
- [deploy-compat.md](deploy-compat.md) — 部署兼容性校验规则、架构核验、GPU 默认可用性、隔离沙箱冒烟测试
