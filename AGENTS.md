# AGENTS.md — 1Panel Local Apps

## Project

1Panel 本地应用仓库，包含自建 Docker 应用的 compose 文件、元数据和图标。
用于同步到 1Panel 应用商店并持续维护。

## Structure

```
<app-key>/               # 应用目录直接在仓库根
├── data.yml              # 根元数据 (key, name, type, description, website, github)
├── logo.png              # 应用图标
├── README.md             # 中文说明
└── <version>/            # 版本目录 (名称=版本参数，禁止使用 "latest")
    ├── data.yml          # 版本配置 + formFields (环境变量定义)
    ├── docker-compose.yml
    ├── data/             # 持久化数据目录 (.gitkeep)
    └── scripts/          # 可选: init.sh 等初始化脚本
```

## Rules

### Compose 文件

- 主服务: `container_name: ${CONTAINER_NAME}`
- 所有服务: `restart: always`, `networks: [1panel-network]`, `labels: {createdBy: "Apps"}`
- `1panel-network` 必须声明为 external
- 公开端口: 使用 `PANEL_APP_PORT_*` 变量
- 持久化挂载: 优先使用 `./data/...` 相对路径
- 镜像引用: 变量型应用使用 `${IMAGE}` / `${APP_VERSION}`；hardcode 类应用直接写 `image:tag`，由自动更新守护

### 变量声明

- compose 中每个 `${...}` 变量必须在版本 `data.yml` 的 formFields 中声明
- 1Panel 自动提供的变量可豁免: `${CONTAINER_NAME}`, `${HOST_IP}`, `${HOST_ADDRESS}`, `${PANEL_DB_PORT}`, `${CPUS}`, `${MEMORY_LIMIT}`
- 端口变量命名: `PANEL_APP_PORT_HTTP`, `PANEL_APP_PORT_HTTPS`, `PANEL_APP_PORT_API` 等

### 元数据

- `additionalProperties.key` 必须匹配应用目录名
- `type` 字段: 默认 `tool`
- `description` 和 form field `labels` 应包含 i18n: `en, zh, zh-Hant, ja, ko, ru, ms, pt-br`

### 图标

- 不允许占位符图标
- 优先级: 显式 URL → Dashboard Icons → Simple Icons → selfh.st Icons

## Scripts

```bash
# 检查镜像更新
./scripts/check-updates.sh [app-name...]
```

## lib/ 模块

仓库根 [.github/lib/](.github/lib/) 下三个 ESM 模块为脚本层提供共享能力：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| [`lib/semver.mjs`](.github/lib/semver.mjs:1) | 段值比较、纯 semver 选末位、黑名单过滤 | `parse` / `compare` / `isStable` / `pickLatest` |
| [`lib/registry.mjs`](.github/lib/registry.mjs:1) | DockerHub / GHCR 适配器、镜像字符串解析 | `parseImage` / `DockerHubAdapter` / `GhcrAdapter` / `createAdapter` |
| [`lib/apps.mjs`](.github/lib/apps.mjs:1) | 应用目录扫描、版本目录解析、嵌套应用补全 | `SKIP_DIRS` / `listApps` / `getAppMeta` / `getCurrentVersion` |
| [`lib/schema.mjs`](.github/lib/schema.mjs:1) | data.yml 结构定义与校验规则（纯 JS，无第三方依赖） | `validateFormField` / `validateKeyMatch` / `validateUrlField` / `normalizeFormField` / `FORMFIELD_TYPE_WHITELIST` |

### 本地跑测试

```bash
npm test          # 等价 node --test .github/lib/，38 case（含 schema 校验）
npm run lint      # 等价 node .github/bin/lint-apps.mjs，扫描全部 data.yml
```

需要 `node >= 18`（`engines` 字段已声明）。

### 新增模块规约

- 任何新增 `lib/*.mjs` **必须**配套 `*.test.mjs`（用 `node:test`）
- `lib/` 下**禁止**引入 `js-yaml` 之外的第三方依赖；新增依赖须先讨论
- 三个入口脚本（[`detect-updates.mjs`](.github/scripts/detect-updates.mjs:1) / [`sync-readme.mjs`](.github/scripts/sync-readme.mjs:1) / [`check-updates.sh`](scripts/check-updates.sh:1)）应**优先**复用 `lib/` 模块，不在入口内 inline 重复实现
- `bin/` 层为可执行入口脚本（如 [`.github/bin/lint-apps.mjs`](.github/bin/lint-apps.mjs:1)），可引入 `zod` 等 `lib/` 层禁用的第三方依赖；任何新增 bin/ 脚本须配套 `package.json` 中的 `scripts` 条目

### DockerHub 镜像选取口径

`DockerHubAdapter` 用 `page_size=20&ordering=last_updated` 取最近更新的 20 个 tag，再过滤不稳定关键字（`latest|nightly|dev|edge`）后选末位。GHCR 用 OCI Registry API + 匿名 token（`n=1000`），黑名单包含 `alpha|beta|rc|main|master`。

## Automation

- `.github/workflows/auto-update.yml` — 每周一 UTC 0 点（也可手动）检测 hardcode 类应用镜像更新
- 命中即开 PR（分支 `auto-update/<date>`，单 PR 合并本批次全部变更），PR body 列出所有 service 变更
- 修改 `<app>/<version>/docker-compose.yml` 与 `<app>/data.yml`
- 变量型应用（compose 用 `${IMAGE}` / `${APP_VERSION}`）不在自动范围
- PR title 含 `[skip ci]`，防合并时递归触发
- 同步更新仓库根 `README.md` 的"应用列表"表格（应用名/描述/版本）
  - 应用名映射与描述覆盖：[`.github/app-aliases.yml`](.github/app-aliases.yml)
  - 同步脚本：[`.github/scripts/sync-readme.mjs`](.github/scripts/sync-readme.mjs)

## Deployment

1. 修改 compose 或 data.yml
2. `git commit` 并 `git push`
3. 由 1Panel 计划任务拉取最新仓库并触发本地应用同步
4. 在 1Panel UI 重新部署应用

## Common Pitfalls

- **禁止使用 `latest` 作为版本目录名或镜像 tag**：`latest` 会导致版本漂移，1Panel UI 中该目录名即为版本参数。应使用具体 semver / date-based / functional tag（如 `v1.2.3`、`2024.08`、`pg` 等）。仅当上游镜像完全无版本化 tag 时方可例外保留 `latest`（需在 PR 描述中注明根因）。
- 版本目录名就是版本参数，改目录名即改版本选项
- SQLite key 有 `local` 前缀: `jellyfin` → `localjellyfin`
- 更新时只复制版本子目录，不要复制整个 `<key>/*`
- sed -i 在 bind-mount 上会失败，用 tempfile + mv
- 端口变更会影响反向代理配置
- **formField type 不支持 boolean**: 1Panel 前端 [`params/index.vue`](https://github.com/1Panel-dev/1Panel/blob/main/frontend/src/views/app-store/apps/params/index.vue) 使用 `v-if` 按 type 渲染表单控件，**仅支持 6 种 type**：`text` / `number` / `password` / `service` / `select` / `apps`。如果在 formFields 中使用 `type: boolean`，UI 中该字段会完全不显示且无任何报错。**解决方式**：布尔开关一律用 `type: select` + `values: [{label: 'true', value: 'true'}, {label: 'false', value: 'false'}]` 来模拟。参考应用：`anirss`、`firecrawl`、`mihomo`、`moviepilot`、`handbrake`、`traefik` 等均有同模式字段。**检测技巧**：新增 formField 后如果 UI 未出现，先核对 `type` 是否在上述白名单内。
- **GHCR 镜像更新检测应使用 OCI Registry API**：GitHub Packages API（`https://api.github.com/orgs/<org>/packages/container/<repo>/versions`）对匿名访问返回 401，即使提供 `GITHUB_TOKEN` 也无法跨组织读取 packages，导致 hardcode 类 GHCR 镜像永远检测不到更新。**正确方式**：先用 `https://ghcr.io/token?scope=repository:<repo>:pull` 获取匿名 pull token（无需认证），再用 `https://ghcr.io/v2/<repo>/tags/list?n=1000` 列出 tags（`n=1000` 覆盖绝大多数场景）。参考：`detect-updates.mjs` 的 `getLatestTagFromGHCR` 与 `check-updates.sh` 的 GHCR 分支。
- **compose 环境变量名需与上游实际读取名一致**：上游容器进程读取的环境变量名未必与 compose 中声明的相同（如上游 `start-all.sh` 读取 `HINDSIGHT_CP_HOSTNAME` 而非 `HINDSIGHT_CP_HOST`）。在新增版本目录或补全 formField 时，应通过阅读上游 Dockerfile / 启动脚本 / `.env.example` 交叉验证变量名，不确定时查上游仓库对应 tag 的 `docker/standalone/start-all.sh`。
- **1Panel 拒绝顶层 `volumes` 块使用变量插值命名卷**：部署时报错 `validating .../docker-compose.yml: volumes additional properties '${CONTAINER_NAME}-xxx' not allowed`。**根因**：1Panel 用 Go json-schema 严格校验顶层 `volumes` 键名，只接受字面量（如 `pgvector_data: null`），不接受 `${...}` 插值。**解决方式**：需要按 `${CONTAINER_NAME}` 命名的卷一律改为相对路径 bind mount（如 `./data/minio:/data`），并直接删掉顶层 `volumes:` 块，与本仓「持久化挂载优先使用 `./data/...` 相对路径」规约一致。**参考**：[`marginalia/0.3.4/docker-compose.yml`](marginalia/0.3.4/docker-compose.yml:1) commit `3d08ed4`。
- **`additionalProperties.type` 必须在白名单 `[tool, media, library]` 内**：[`lint-apps.mjs`](.github/bin/lint-apps.mjs:38) 中 `rootAdditionalPropertiesSchema.type = z.enum(TYPE_ENUM)`，仅接受 `tool` / `media` / `library`。历史遗留中曾出现 `type: photo`（[`immich/data.yml`](immich/data.yml:11)、[`immich/v3.0.3/data.yml`](immich/v3.0.3/data.yml:1)）和 `type: database`（[`pgvector/data.yml`](pgvector/data.yml:11)、[`qdrant/data.yml`](qdrant/data.yml:11)），均会被 lint 拒绝。**解决方式**：媒体类用 `media`，数据库类用 `tool`；如需在 README/描述里强调「这是照片管理」「这是数据库」，应放在 `description`/`tags`/`shortDescZh` 而非 `type`。
- **`formField.rule` 必须在白名单 6 选 1**：`FORMFIELD_RULE_WHITELIST = [paramImageTag, paramPort, paramPath, paramCommon, paramSelect, paramComplexity]`（见 [`lib/schema.mjs`](.github/lib/schema.mjs:1)）。历史遗留 `rule: paramHttp`（[`llamaindex/v0.9.2/data.yml`](llamaindex/v0.9.2/data.yml:1)）和 `rule: paramInt`（[`immich/v3.0.3/data.yml`](immich/v3.0.3/data.yml:1) 4 处）不在白名单。**解决方式**：URL 类改用 `paramCommon`（同 source/dest 字符串），整数类改用 `paramCommon`（同 number 文本框）。**检测技巧**：lint 报 `rule="X" 不在白名单内` 时，先查 `lib/schema.mjs` 的 `FORMFIELD_RULE_WHITELIST`。
- **`formField.rule` 必须是 string，不能是 object**：[`lint-apps.mjs`](.github/bin/lint-apps.mjs:32) 中 `rule: z.string().optional()`，但 [`jellystat/1.1.11/data.yml`](jellystat/1.1.11/data.yml:1) 曾用 `rule: { type: parameter, required: true, max: 128, min: 16, range: {...} }`（object 形式，疑似 1Panel v1 旧 schema）。**解决方式**：直接删除 `rule:` object 块（rule optional），如需保留校验信息可放入 `label`/`description` 文案里。
- **`formField` 必填 `envKey` 和 `type`，禁用 `key:`**：[`formFieldZodSchema`](.github/bin/lint-apps.mjs:24) 显式要求 `envKey: z.string().min(1)` 和 `type: z.string()`。[`jellystat/1.1.11/data.yml`](jellystat/1.1.11/data.yml:1) 历史遗留用 `key: PANEL_APP_PORT_HTTP`（少 envKey 3 字符），schema 完全不接受。**解决方式**：所有 formField 顶层 `key:` 改为 `envKey:`。**检测技巧**：运行 `node .github/bin/lint-apps.mjs 2>&1 | grep -E "formFields\[\d+\]"` 查看每个 formField 报的错。
- **`versionAdditionalPropertiesSchema` 继承 `key`/`name` 必填**：[`lint-apps.mjs`](.github/bin/lint-apps.mjs:44) 中 `versionAdditionalPropertiesSchema = rootAdditionalPropertiesSchema.extend({ formFields: required })`，**继承**了 `key: z.string().min(1)` 和 `name: z.string().min(1)` 必填。历史遗留的 `additionalProperties: { formFields: [...] }`（缺 key/name）会被 union 拒绝。**解决方式**：在 `additionalProperties:` 下、紧贴 `formFields:` 之前补 3 行：
  ```yaml
  additionalProperties:
    key: <app-key>            # 必须与目录名一致
    name: <app-key> <version> # 1Panel UI 显示名
    type: tool                # tool | media | library
    formFields:
  ```
  **已修复的应用**：hindsight×5、jellyfin×2、llamacpp×2、[`infinity/cu124/data.yml`](infinity/cu124/data.yml:1)、[`mineru/3.4.2/data.yml`](mineru/3.4.2/data.yml:1)（4 空格缩进）、[`gecoos/v2.2/data.yml`](gecoos/v2.2/data.yml:1)（仅缺 name）。
- **zod 3.x `invalid_union` 隐藏内层错误**：[`lint-apps.mjs`](.github/bin/lint-apps.mjs:52) 中 `versionDataYmlSchema = z.union([A, B])` 失败时只报 `Invalid input`，不展开 A/B 各自的子错误，导致根因难定位。**诊断套路**（写入临时 `.agent_cache/union_split.mjs`）：
  ```js
  const resultA = A.safeParse(data);
  const resultB = B.safeParse(data);
  if (!resultA.success) console.log('A 失败:', JSON.stringify(resultA.error.issues, null, 2));
  if (!resultB.success) console.log('B 失败:', JSON.stringify(resultB.error.issues, null, 2));
  ```
  一般根因落在 `additionalProperties.key` / `additionalProperties.name` / `additionalProperties.type` 之一。
- **firecrawl 历史 case 警示**：[`firecrawl/2.11.14/2.11.202/2.11.209/data.yml`](firecrawl/2.11.14/data.yml:185) formFields 列表里曾出现重复且残缺的 `- default: 1Panel-localpgvector-kD9L`（缺 envKey/type），是 union 失败的真正根因，**不是**缺 `key/name`。**检测技巧**：当 union 错误出现在已有完整 `additionalProperties` 元数据的应用上时，**先**检查 formFields 列表里有没有缺 `envKey` 或 `type` 的残缺项（grep `^- default:` 找孤立项），**再**判断是否需要补 `key/name`。
- **顶层 `data.yml` 必须是 `{ additionalProperties: {...} }`**：[`rootDataYmlSchema`](.github/bin/lint-apps.mjs:41) 只接受这种结构，**禁止**顶层直接平铺 `key`/`name`/`description`/`formFields`。历史遗留 [`jellystat/1.1.11/data.yml`](jellystat/1.1.11/data.yml:1) 顶层有 `version`/`image`/`appId`/`servicePort`/`formFields`，[`llmwiki/latest/data.yml`](llmwiki/latest/data.yml:1) 顶层有 `key`/`version`/`name`/`description`/`formFields`，均需重组成 `additionalProperties: { key, name, type, formFields }`。
- **版本目录 `data.yml` 支持两种 union 形式**：[`versionDataYmlSchema`](.github/bin/lint-apps.mjs:52) 接受：
  1. `additionalProperties: { key, name, type, formFields, ... }`（紧凑）
  2. `{ name?, title?, description?, additionalProperties: {...} }`（顶层有可选 `name`/`title`/`description` + 嵌套 `additionalProperties`）
  两种**不可混用**：选了形式 1 就不要再在根级写 `name:`/`title:`/`description:`，否则 YAML 不会报但 zod 报 Invalid union 之外的奇怪错。
- **临时诊断脚本应放 `.agent_cache/`**：仓库根 `.gitignore` line 20 已忽略 `.agent_cache/`，所有 `*.mjs` / `*.ps1` / `txt` 诊断产物放在该目录下，结束后用 `node .agent_cache/cleanup.mjs`（仅保留 `.gitkeep`）清理，符合「Trace-less Execution」原则。
- **1Panel formField 没有 `help:` / `placeholder:` 渲染**：实测 1Panel [`params/index.vue`](https://github.com/1Panel-dev/1Panel/blob/dev/frontend/src/views/app-store/detail/params/index.vue) 的 `el-input` 只绑定 `v-model="form[p.envKey]"` 并读取 `p.default` / `p.label`，**整个模板里没有 `p.help` 也没有 `p.placeholder` 任何引用**。这意味着：
  - 写 `help:` 字段在 lint 里不会被拒绝（zod `passthrough` 沉默通过），UI 上也**完全不显示**。仓库里 [`searxng/2026.9.7-3e454637f/data.yml`](searxng/2026.9.7-3e454637f/data.yml:65) / [`mineru/3.4.2/data.yml`](mineru/3.4.2/data.yml:174) / [`vane/v1.12.2/data.yml`](vane/v1.12.2/data.yml:121) 都用 `help:` 但用户看不到，是历史遗留死代码。
  - 写 `placeholder:` 同样不生效（前端没有这个 prop 绑定）。
  - **正确做法**：把"提示文字"塞进 `default` 字段（作为示例值；Element Plus 的 `<el-input>` 会把 `default` 当输入框初始值，但用户**删掉**才会清空——不是灰色 placeholder），或者把冗长说明拆到 **README.md** 的「安装 / 配置」段落，**不要**堆在 `label` 里把标题拉成 2-3 行。
  - **dendrite 复盘（2026-09-11）**：[`dendrite/v0.15.2/data.yml`](dendrite/v0.15.2/data.yml:107) 最初把 `DATABASE_URL` 的 i18n label 写成 60+ 字符的"label 内嵌使用说明"（8 个语种 × 60 字符 = ~500 字符垃圾），1Panel UI 渲染成单行 label 后整行被截断 / 换行。**解决**：label 收回到 ≤12 字符短词（"数据库连接串" / "Database URL"），详细说明（含 Postgres 连接串示例、容器名命名规则）移到 README 的「安装 → 切到 PostgreSQL」段落。
  - **1Panel-postgresql 容器名命名限制**：1Panel 自动生成的 PG 容器名形如 `1Panel-postgresql-ZU4y`，后缀是 Base32 `[A-Z0-9]` 4 字符随机串。用户填 `DATABASE_URL` 时，**Postgres 主机名段必须与该容器名完全一致**（仅大写字母与数字，**没有**短横线 / 下划线 / 小写字母）。如果上游应用层想做 host 校验，**不能**用 `^[a-z0-9-]+$` 之类的宽松正则，要用 `^[A-Za-z0-9-]+$` 且 host 部分须显式校验非空。本仓 `paramCommon` 规则本身不限制这个，由开发者根据上游网络拓扑自行决定。
  - **`rule: paramCommon` 不能放过完整 DSN / URL**：1Panel `frontend/src/global/form-rules.ts:369` 的 `checkParamCommon` 正则是 `/^[a-zA-Z0-9]{1}[a-zA-Z0-9._-]{1,63}$/`（即"支持英文、数字、.-和_，长度 2-64"那条用户会看到的提示）。Postgres DSN 形如 `postgres://user:pass@host:5432/dbname?sslmode=disable` 含 `:` / `@` / `?` / `/` 全部会被前端拒，**即使是合法连接串也提交不了**。`paramImageTag` / `paramPort` / `paramPath` / `paramComplexity` 同样都不能放过。**正确做法**：把 DSN 拆成 `DB_TYPE`（select） + `DB_HOST`（`paramCommon`） + `DB_PORT`（`paramPort`） + `DB_NAME`（`paramCommon`） + `DB_USER`（`paramCommon`） + `DB_PASSWORD`（`paramComplexity`）6 个分字段，由 `init.sh` 在容器内拼。**dendrite 复盘（2026-09-11）**：[`dendrite/v0.15.2/data.yml`](dendrite/v0.15.2/data.yml:101) 最初用单 `DATABASE_URL` 字段 + `paramCommon`，用户填 `postgresql://user_wEJsSp:password_tyrcEJ@1Panel-postgresql-ZU4y:5432/dendrite?sslmode=disable` 时前端弹"支持英文、数字、.-和_，长度 2-64"拒掉，**改成 6 个分字段后**每条提示都跟字段语义一致，提交成功。

## 沙箱中 `node` 不可见的应对

本仓 lint / test 脚本依赖 `node >= 18`（`package.json` `engines` 字段已声明），但执行沙箱（Windows + fnm + `cmd.exe`）下 `node` / `npm` **经常不在 PATH 里**，体现为：

```text
'node' is not recognized as an internal or external command,
operable program or batch file.
```

### 现象与根因

- `D:\Env\UserScoop\shims\fnm.exe` 装在沙箱里，但**沙箱 shell 不会自动执行 fnm 的 PATH 注入钩子**（`fnm current` 直接报 `` `fnm env` was not applied in this context.``）
- `where node` 命中 `C:\Windows\System32\where.exe` 自身；`where node.exe` 在沙箱里 `INFO: Could not find files`
- `D:\Env\UserScoop\shims\` 下只有 `fnm.exe`，**没有** `node.exe` shim（fnm 不会为 node 创建持久 shim）
- 直接 `dir "C:\Users\33098\AppData\Roaming\fnm\node-versions\v22.22.3\installation"` 在本机也不存在，fnm list 显示 `v22.22.3 default` 但实际安装目录被搬走或未同步

### 排查阶梯（按代价从低到高）

1. **确认任务可仅靠 git 完成**：lint / test 必须 `node`，但**文档、commit、push、revert、status、diff 全部可仅用 `git` 完成**。沙箱里只要能 `git status` / `git commit` / `git push` 就够覆盖绝大多数维护性任务，**不要**为「想跑一次 lint」反复尝试唤起 node。
2. **查 PATH 中是否被前缀 cmd 截断**：用 `where node`、`where npm`、`where fnm` 分别看；
   - 命中 `D:\Env\UserScoop\shims\fnm.exe`：fnm 在，但 shell 缺 env 注入，走第 3 步；
   - 全部 `INFO: Could not find`：fnm 都不在 PATH，沙箱 exec 环境与真实 shell 不一致，**不要**继续追 node，跳到第 5 步。
3. **让 fnm 给出 env 块**（一次性，不会改当前 shell）：
   ```cmd
   fnm env --shell=cmd
   ```
   输出里 `SET PATH=...;C:\Users\33098\AppData\Local\fnm_multishells\<pid>_<ts>;D:\Env\UserScoop\shims;...` 包含当前 multi-shell 路径。但**该 PATH 不持久**，下一条命令仍然找不到 node。
4. **PowerShell 递归定位 node.exe**（慢，可能跑飞）：
   ```powershell
   Get-ChildItem -Path 'C:\Users\33098\AppData\Roaming\fnm','C:\Users\33098\AppData\Local\fnm' -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty FullName
   ```
   **注意**：递归整个 fnm 目录（尤其是跨 `node-versions\v*\installation\`）在 Windows 上动辄几十秒，**且对本仓大多数任务无收益**——本仓 lint 已经验证通过，commit 前不必再跑。
5. **止损策略**（推荐默认行为）：
   - `git` / `curl` / `findstr` / `dir` / `del` 在沙箱里都可用，能完成 AGENTS.md 改写、`git commit` / `push` / `revert`、文件 diff 校验、临时清理；
   - `node` 相关操作（lint、test、auto-update 脚本）**留给用户真实 shell**（VSCode 集成终端 / PowerShell 已配 fnm PATH 注入的环境），不要在沙箱里硬撑；
   - 不要在沙箱中尝试 `npm install` / `node .github/bin/lint-apps.mjs` 等命令重试超过一次，连续失败即应转为文档 commit / ask user。

### 反例

- ❌ `cd .agent_cache && node x.mjs && type out.txt` —— fnm 没注入 env，`node` 报 not recognized 概率 > 50%；
- ❌ `npm run lint | tee out.txt` —— `tee` 在 Windows cmd 上对 npm 包装器退出码语义不一致，输出会丢；
- ❌ 反复递归 `dir /b /s "C:\Users\33098" | findstr node.exe` —— 全盘扫描动辄 30s+，沙箱里**会卡住后台终端**，并污染 `Actively Running Terminals` 列表。
- ✅ 改为 `git diff AGENTS.md` / `git status` / `git log --oneline` 完成同类校验。

## anirss 不更新根因复盘（2026-09-08）

**症状**：上游 wushuo894/ani-rss 在 2026-09-05 发布 v3.2.29 / v3.2.29-arm32v7，但本仓 `anirss/` 下最末版本仍停留在 v3.2.24（2026-08-28）。`detect-updates.mjs` cron 周一拍不出 PR。

**根因**（[`registry.mjs`](.github/lib/registry.mjs:90) refactor 引入的回归）：

`DockerHubAdapter.getLatestTag` 的 variant 正则 `^([a-zA-Z][a-zA-Z0-9]*)(?:-|$)/` 对 `currentTag='v3.2.18-arm32v7'` 永远不匹配（'v' 之后是 '3'，既不是 `-` 也不是 `$`）。fallback 走 `pickLatest(stable)` → `pickLatest` 内部 `PURE_SEMVER_RE = /^v?\d+\.\d+\.\d+$/` 把所有 `*-arm32v7` tag 过滤掉，永远返回无后缀的 `v3.2.29`。

**链式后果**（[`detect-updates.mjs`](.github/scripts/detect-updates.mjs:303-322) hardcode 路径）：

1. anirss 9 个 versionDir 全部把 `maxTo` 设为 `v3.2.29`（arm32v7 后缀在 fallback 中被丢）
2. 9 次循环对同一 `v3.2.29/` 目录 `rmSync` + `cpSync` 覆盖，**`v3.2.29-arm32v7/` 目录永远不会被创建**
3. 1Panel UI 版本下拉中 arm32v7 用户拿不到 v3.2.29

**PR #14 全空 before/after 同根**：cron 周一 2026-08-25 跑 `detect-updates.mjs`（refactor 之后首次），所有应用遍历后 `serviceChanges` 全部为空（refactor 在 `processApp` 返回路径上漏处理），所以全 PR 空修改。这与本仓 firecrawl/handbrake/hindsight/jellyfin/linkwarden/llamacpp/moviepilot/qdrant/searxng/syncthing/vane 全军覆没**同源**。

**修复**（[`.github/lib/registry.mjs`](.github/lib/registry.mjs:87)）：

variant 识别扩展为 3 种 currentTag 形态：
1. 裸变体 `'pg'` → 匹配 `'pg-1.16.0'`（AGENTS.md 已有业务，行为不变）
2. 变体+版本 `'pg-1.16.0'` → 匹配 `'pg-1.16.1'`（行为不变）
3. **semver+后缀 `'v3.2.18-arm32v7'` → 匹配 `'v3.2.29-arm32v7'`**（新增）

形态 3 实现：先正则提取 suffix，再 `pickLatest(stable.filter(t => t.endsWith('-' + suffix)))`。同 suffix 的版本不存在时（如上游删了 arm32v7）走 fallback，避免误报。

**清理**：[`GhcrAdapter`](.github/lib/registry.mjs:132) 内部残留的 `[DEBUG-hindsight]` 8 处 `console.log` 全部删除（PR #13 hindsight 修复遗留）。

**回归测试**（[`.github/lib/registry.test.mjs`](.github/lib/registry.test.mjs:200)）：

- case 14: `v3.2.18-arm32v7` → `v3.2.29-arm32v7`（anirss 核心场景）
- case 15: `v3.2.24`（无后缀）走 fallback 拿到 `v3.2.29`
- case 16: `v3.2.18-arm64v8`（suffix 不存在）走 fallback 不误报
- case 17: GHCR 同样形态 3 支持

**手动补救**：anirss 补出 `v3.2.29/` + `v3.2.29-arm32v7/` 两个目录（cpSync v3.2.24 / v3.2.18-arm32v7 后改 compose image），保证 1Panel UI 当下可用。

**教训**：

- 变体识别是**两个维度**的复合查询：prefix（裸变体语义）+ suffix（semver 后缀架构）。原正则只支持 prefix 一种形态，semver+后缀这种主流架构（anirss/handbrake/scrob 等都这样）会全部走错路径。
- 测试覆盖不足：原 `registry.test.mjs` 只测了 `pg` / `railway`（anythingllm 业务），没有 `v3.2.X-arm32v7` 这种 semver+suffix 形态。新增 case 14-17 锁死该形态。
- DEBUG 日志 `[DEBUG-hindsight]` 这种前缀在 PR 合入时**没有清理**——下次类似 PR 应检查 `git grep DEBUG-`。
- `pickLatest` 的 `PURE_SEMVER_RE` 过滤是双刃剑：把变体 tag 当作"非 semver"丢掉，导致上游有同 suffix 但版本号低时不报错。需要上游**专门**给 suffix 维度筛选（不能完全靠 pickLatest 退路）。
