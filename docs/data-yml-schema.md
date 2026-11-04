# data.yml schema 与校验规则

> 职责（唯一）：`data.yml` 字段、type / rule 白名单、常见校验错误。
> 权威实现：[lib/schema.mjs](../.github/lib/schema.mjs)（纯 JS 白名单）+ [bin/lint-apps.mjs](../.github/bin/lint-apps.mjs)（zod 层校验）。
> 本文档只复述实现，不引入新规则；schema 改动须先改代码再同步本文。

## 1. 校验分层

| 层 | 文件 | 依赖 | 职责 |
|---|---|---|---|
| lib | [`.github/lib/schema.mjs`](../.github/lib/schema.mjs) | 无第三方 | 白名单常量 + 纯函数规则校验 |
| lib | [`.github/lib/consistency.mjs`](../.github/lib/consistency.mjs) | 无第三方 | 跨文件一致性规则（变量声明/Tag/端口/卷/运行时/README 对齐，ruleId 单一事实来源） |
| lib | [`.github/lib/lint-exemptions.mjs`](../.github/lib/lint-exemptions.mjs) | js-yaml | 结构化豁免加载/匹配/死条目检测 |
| bin | [`.github/bin/lint-apps.mjs`](../.github/bin/lint-apps.mjs) | zod（**仅此层允许**） | data.yml 结构解析 + 全仓扫描（`npm run lint`），error 阻塞 / warning 提示 |

### 1.1 跨文件一致性与豁免

`npm run lint` 除 schema 校验外，还执行跨文件一致性检查（compose ↔ data.yml ↔ README ↔ 版本目录名），
每条 finding 带 `ruleId`（定义在 `lib/consistency.mjs` 的 `RULES`，分级 P0/P1=error、P2=warning）。
应用自身的合理差异（如必须 `privileged`、上游仅发布 `latest` tag、README 引用关联应用的变量）
通过 [`.github/lint-exemptions.yml`](../.github/lint-exemptions.yml) 登记豁免：

- 每条必须绑定 `app + ruleId`（可选 `version`/`value` 收窄粒度）并写明实证过的 `reason`；
- 禁止全局关闭检查；死条目（应用/版本消失、规则不再报错）会被 lint 报 error 强制清理。

## 2. 根级 data.yml

- 顶层就是 `{ additionalProperties: {...} }`；**禁止**顶端直接平铺 `key`/`name`/`formFields`。
- `additionalProperties` 允许字段（zod）：
  `key`(必填, 与目录名一致)、`name`(必填)、`type`(必填, 枚举 `tool|media|library`, 默认 `tool`),
  `tags`、`shortDescZh`、`shortDescEn`、`description`(i18n 记录)、`architectures`(枚举 `amd64|arm64|arm/v7|386`),
  `crossVersionUpdate`、`limit`、`recommend`、`website`、`github`、`document`、`formFields`(可选)。
- **不要**写其它无关字段；`rule` 只允许 string，不允许 object（旧 1Panel v1 schema 已废）。

## 3. 版本级 data.yml

两种合法 union 形式（**不可混用**，混用会报含糊的 `invalid_union`）：

1. `additionalProperties: { key, name, type, formFields: [...] }`（紧凑，推荐）
2. `{ name?, title?, description?, additionalProperties: {...} }`（顶层可选 name/title/description + 嵌套）
   （注：第 2 种顶层 `description` 不改变 additionalProperties 内必填约束）

版本级 `additionalProperties` = 根级字段集合 + **`formFields` 必填** + 继承 `key`/`name` 必填:

```yaml
additionalProperties:
  key: <app-key>            # 必须与目录名一致
  name: <app-key> <version> # 1Panel UI 显示名
  type: tool                # tool | media | library
  formFields:
    - ...
```

## 4. formField

### 4.1 type 白名单（6 种）

1Panel 前端 [`params/index.vue`](https://github.com/1Panel-dev/1Panel/blob/main/frontend/src/views/app-store/apps/params/index.vue)
`v-if` 按 type 渲染控件，**仅支持** `text` / `number` / `password` / `service` / `select` / `apps`。

- `type: boolean` **完全不渲染且无报错**。布尔开关一律用 `type: select` +
  `values: [{label: 'true', value: 'true'}, {label: 'false', value: 'false'}]` 模拟。
- `type: select` **必须有 `values`**。
- `type: number` 的 `default` 必须可转数字。

### 4.2 rule 白名单（6 种）

`FORMFIELD_RULE_WHITELIST` = `paramImageTag | paramPort | paramPath | paramCommon | paramSelect | paramComplexity`。

- `paramHttp` / `paramInt` 等历史遗留**不在白名单**：URL/整数类改用 `paramCommon`（但注意 §4.5）。
- `paramCommon` 前端正则 `/^[a-zA-Z0-9]{1}[a-zA-Z0-9._-]{1,63}$/`（英数 `._-` 长2-64）。
  **完整 DSN / URL 不能用 paramCommon**（含 `:`/`@`/`?` 会被拒）——拆字段由 `init.sh` 拼（见 §5）。
- `paramCommon` 正则要求 ≥2 字符：单字符 ID（如 `UID=9`）会被拒，可在 formField 给 `default: 99` 这类双位。

### 4.3 其余字段要求（zod）

- `envKey` 必填；**禁用 `key:`**（旧 schema 已废）。
- `label`: i18n 记录，推荐 `en, zh, zh-Hant, ja, ko, ru, ms, pt-br`；
  每个 label ≤12 字符短词（长说明会截断，写进 README）。
- `values[].value` 必须为 **string**（1Panel Go struct 声明）。YAML 纯数字默认解析 int 会爆炸：
  上游 tag 是纯日期类（`260919`）时写成 `- value: 260919` 会报 Go struct unmarshal error。
  **解决**：给 `values[].value`（建议连 `default`/`label`）加双引号。
- `help:` / `placeholder:` **不被 1Panel UI 渲染**（前端无对应绑定），别写。
  要给用户「浅色提示」：把示例值写进 `default`（Element Plus 会填进输入框），冗长说明写进应用 README。
- 安装参数保持简短：只暴露与本机部署强相关的少量字段（HTTP 端口、TZ、反代 Origin 等）；
  SMTP / WebDAV / 第三方 API key / 备份策略 / 主题等一律走应用内「配置中心」明文不进 1Panel 表单。

### 4.4 运行身份参数（UID / GID）

两套机制互斥（详细对照表见 [compose-conventions.md §PUID/PGID](compose-conventions.md#5-容器运行身份puidpgiduidgid)）:

- 镜像原生支持 `PUID`/`PGID`（entrypoint chown + su-exec/gosu 降权）→ formField `PUID`/`PGID` + compose `environment` 透传。
- 官方镜像（无 `PUID` 、非 s6）→ formField `UID`/`GID` + compose `user: "${UID}:${GID}"`，**宿主机先 chown 再部署**。
- s6-overlay 严禁 `user:`（s6 必须 PID 1），见 compose-conventions.md §6。
- Postgres 系 / `collabora/code` 内置非 root 身份的镜像 **不提供**该参数。

### 4.5 DSN 拆字段由 init.sh 拼（针对 paramCommon）

Postgres / URL 连接串不能走单个 `DATABASE_URL` + `paramCommon`；正确做法是拆成
`DB_TYPE(select) + DB_HOST(paramCommon) + DB_PORT(paramPort) + DB_NAME(paramCommon) + DB_USER(paramCommon) + DB_PASSWORD(paramComplexity)`
6 个分字段，由 `scripts/init.sh` 拼接。参考 [dendrite/v0.15.2/data.yml](../dendrite/v0.15.2/data.yml)。

## 5. envKey 与 `${...}` 变量（1Panel 侧）

- 1Panel 读取`formFields[].envKey` → 写出 `.env`；compose 中 `${...}` 必须有声明。
- 1Panel 自动提供的变量可豁免：`${CONTAINER_NAME}`, `${HOST_IP}`, `${HOST_ADDRESS}`, `${PANEL_DB_PORT}`, `${CPUS}`, `${MEMORY_LIMIT}`。
- init.sh 在 `source` 1Panel `.env` 时**先改名再 source**：`UID` 在 bash 是只读变量，
  `set -e` 环境下直接中断，示例（带 `RUN_UID`/`RUN_GID`）见 [cfnb/v1.0.1/scripts/init.sh](../cfnb/v1.0.1/scripts/init.sh)。

## 6. 常见校验错误速查

| 错误 | 根因 | 解法 |
|---|---|---|
| `type="photo"/"database" 不在白名单` | `additionalProperties.type` 非白名单 | 改 `tool`/`media`/`library`，强调语义放 description |
| `rule="paramHttp" 不在白名单` | rule 非白名单 | 换 `paramCommon`/`paramPort` 等 |
| `rule 为 object` | 旧 1Panel v1 schema 遗留 | 删除 `rule:` object 块 |
| `缺 member key/name` | 版本级 additionalProperties 缺必填 | 补 `key`/`name`/`type` |
| `envKey 缺失 / type 缺失` | formField 元数据残缺（多为复制粘贴错） | grep `^- default:` 找孤立项 |
| `values[].value number → Go struct` | select value 被解析 int | 给 value 加双引号 |
| `invalid_union` 不展开内层 | zod 3.x 上层报 Invalid input | 临时诊断脚本放 `.agent_cache/`（`gitignore` 已忽略），分 case safeParse 展开 |
| `type=select 缺 values` | 少写 values 数组 | 用 select + 双值 boolean 模式时尤需注意 |

## 相关文档

- [app-structure.md](app-structure.md) — 目录结构与新增应用流程
- [compose-conventions.md](compose-conventions.md) — compose 环境变量映射与运行身份
- [automation.md](automation.md) — 校验在自动更新链路中的位置
