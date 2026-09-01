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
- **`formField` 必填 `envKey` 和 `type`**，禁用 `key:`：[`formFieldZodSchema`](.github/bin/lint-apps.mjs:24) 显式要求 `envKey: z.string().min(1)` 和 `type: z.string()`。[`jellystat/1.1.11/data.yml`](jellystat/1.1.11/data.yml:1) 历史遗留用 `key: PANEL_APP_PORT_HTTP`（少 envKey 3 字符），schema 完全不接受。**解决方式**：所有 formField 顶层 `key:` 改为 `envKey:`。**检测技巧**：运行 `node .github/bin/lint-apps.mjs 2>&1 | grep -E "formFields\[\d+\]"` 查看每个 formField 报的错。
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
- **临时诊断脚本应放 `.agent_cache/`**：仓库根 `.gitignore` line 20 已忽略 `.agent_cache/`，所有 `*.mjs` / `*.ps1` / `*.txt` 诊断产物放在该目录下，结束后用 `node .agent_cache/cleanup.mjs`（仅保留 `.gitkeep`）清理，符合「Trace-less Execution」原则。

## Node 工具链使用规范

仓库 `package.json` 声明 `engines.node >= 18`，所有 lint/test 脚本都是 ESM 入口。本节沉淀本仓本环境下的 Node 使用实操要点。

### 运行入口脚本

```bash
# 标准方式（推荐）：package.json 提供的 scripts
npm test       # 等价 node --test .github/lib/*.test.mjs (5 个文件, 38 case)
npm run lint   # 等价 node .github/bin/lint-apps.mjs

# 直接调用（CI 调试 / 子进程环境）
node .github/bin/lint-apps.mjs
node .github/bin/open-update-pr.mjs
node --test .github/lib/schema.test.mjs   # 单跑某 lib 测试
```

### 路径解析：优先 `process.cwd()` 而非 `import.meta.dirname`

诊断脚本若从仓库根运行，`import.meta.dirname` 落在脚本所在子目录（如 `.agent_cache/`），`..` 跳转后可能跳过 `1panel-local-apps/`。**统一做法**：

```js
// 推荐：当前工作目录总是仓库根（npm script 保证）
const ROOT = process.cwd();

// 不推荐：依赖脚本位置
const ROOT = join(import.meta.dirname, '..'); // 嵌套目录下不正确
```

### 输出捕获：避免 shell 管道丢失 PATH

Windows + fnm 环境下，`cd .agent_cache && node x.mjs` 后 `type output.txt` 偶发 PATH 丢失。**可靠做法**：脚本内 `writeFileSync(..., 'utf8')` 落盘，再单独 `type` 读取。

```js
import { writeFileSync } from 'node:fs';
writeFileSync(join(import.meta.dirname, 'out.txt'), text, 'utf8');
```

### 编码与行尾

所有 `data.yml` 保持 UTF-8（无 BOM）+ CRLF。批量替换时用 `readFileSync` / `writeFileSync('utf8')` 即可，**不要**在 PowerShell 用 `Out-File -Encoding utf8`（默认 UTF-16，会产生 0 字节空文件）。如需在脚本里强制 CRLF：

```js
const CRLF = '\r\n';
let text = readFileSync(p, 'utf8');
const hadCRLF = text.includes(CRLF);
text = text.replace(/\r\n/g, '\n');
// ... 修改 ...
let out = text;
if (hadCRLF && !out.includes(CRLF)) out = out.replace(/\n/g, CRLF);
writeFileSync(p, out, 'utf8');
```

### 依赖分层

- `lib/*.mjs` **禁止** `js-yaml` 之外的第三方依赖；只允许 Node 内置模块
- `bin/*.mjs` 允许 `zod` 等校验库；新增 `bin/` 脚本须配 `package.json` 的 `scripts` 条目
- `lib/` 新增模块**必须**配 `*.test.mjs`（用 `node:test`）

### 调试 zod 错误的最小样板

```js
import { z } from 'zod';
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';

const schema = z.union([A, B]);
const data = yaml.load(readFileSync('path/to/data.yml', 'utf8'));
const r = schema.safeParse(data);
if (!r.success) {
  // union 失败只显示 "Invalid input"，需拆分：
  const ra = A.safeParse(data);
  const rb = B.safeParse(data);
  if (!ra.success) console.log('A:', JSON.stringify(ra.error.issues, null, 2));
  if (!rb.success) console.log('B:', JSON.stringify(rb.error.issues, null, 2));
}
```
