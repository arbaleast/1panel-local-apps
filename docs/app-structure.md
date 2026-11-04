# 应用目录结构与元数据规范

> 职责（唯一）：应用目录布局、根/版本 `data.yml` 职责划分、新增/更新应用流程、README 与 logo 规范、部署链路。
> schema 字段明细见 [data-yml-schema.md](data-yml-schema.md)；compose 规则见 [compose-conventions.md](compose-conventions.md)。

## 1. 目录布局

应用目录直接在仓库根，每个应用一个目录（应用目录名 = `additionalProperties.key`）：

```text
<app-key>/               # 应用目录直接在仓库根
├── data.yml              # 根元数据 (key, name, type, description, website, github)
├── logo.png              # 应用图标
├── README.md             # 中文说明（版本表格由 sync-readme.mjs 维护）
└── <version>/            # 版本目录 (名称=版本参数)
    ├── data.yml          # 版本配置 + formFields (环境变量定义)
    ├── docker-compose.yml
    ├── data/             # 持久化数据目录 (.gitkeep)
    └── scripts/          # 可选: init.sh 等初始化脚本
```

## 2. 版本目录规则

- **版本目录名就是版本参数**：改目录名即改 1Panel UI 中的版本选项。
- **禁止使用 `latest` 作为版本目录名或镜像 tag**：`latest` 会导致版本漂移。应使用具体
  semver / date-based / functional tag（如 `10.11.11`、`v1.2.3`、`2024.08`、`pg` 等）。
  仅当上游镜像完全无版本化 tag 时方可例外保留 `latest`（需在 PR 描述中注明根因）。
- 新增版本目录：**只复制现有版本子目录**（`<app>/<version>/`），**不要**复制整个 `<key>/*`，
  否则会把兄弟版本目录互相顶掉。
- SQLite key 有 `local` 前缀（1Panel 约定）：`jellyfin` → `localjellyfin`。
- 嵌套应用目录会被扫描层自动补全（[lib/apps.mjs](../.github/lib/apps.mjs) 的 `listApps`），
  应用目录名仍须与 `additionalProperties.key` 一致。

## 3. 根级 data.yml（应用元数据）

只承载「应用级」元数据，顶层必须是 `additionalProperties: {...}` 一种形态：

```yaml
additionalProperties:
  key: <app-key>          # 必须与应用目录名一致（lint 强制）
  name: <应用显示名>
  type: tool              # tool | media | library（默认 tool，详见 data-yml-schema.md）
  description:            # i18n: en, zh, zh-Hant, ja, ko, ru, ms, pt-br
  tags: []
  website: https://...
  github: https://...
```

- `type` 字段使用仓库白名单之一（`tool` / `media` / `library`），不支持 `photo` / `database` 等
  非白名单值（历史遗留已被 lint 拒绝）；如需在 README/描述里强调「照片管理」「数据库」，
  放 `description` / `tags` / `shortDescZh`。
- 根级 `data.yml` 没有 `formFields`；环境变量与安装参数只写在版本级 `data.yml`。

## 4. 版本级 data.yml（版本配置）

- 必须含 `additionalProperties.key` / `name`（**继承根级必填**）/ `type` / `formFields`（必填）。
- `name` 形如 `<app-key> <version>`（1Panel UI 显示名）。
- 顶层可选 `name` / `title` / `description` + 嵌套 `additionalProperties` 的第二种 union 形式可以
  使用，但**两种形式不可混用**（选了一种就不要在根级再写重复字段）。
- 字段定义、type / rule 白名单、常见 schema 错误见 [data-yml-schema.md](data-yml-schema.md)。

## 5. 新增 / 更新应用流程

1. 在仓库根新建 `<app-key>/`（无则），复制最接近的现有版本子目录作为起点（只复制子目录）。
2. 修改版本级 `data.yml`（key/name/type/formFields）与 `docker-compose.yml`
   （红线见 [compose-conventions.md](compose-conventions.md)；运行身份见其 PUID/PGID 表）。
3. 准备 `logo.png`（规格见下节）与中文 `README.md`。
4. 更新仓库根 `README.md` 应用列表表格（应用名/描述/版本；名字与描述覆盖映射写在
   [`.github/app-aliases.yml`](../.github/app-aliases.yml)，由 [`.github/scripts/sync-readme.mjs`](../.github/scripts/sync-readme.mjs) 同步）。
5. 校验：
   ```bash
   npm run lint        # 全仓 data.yml schema 校验
   npm test            # 脚本层回归测试
   npm run detect:dry-run   # dry-run 检测更新（不写盘）
   ```

## 6. README 与图标规范

- 应用 `README.md` 用中文，包含用途、安装参数说明、数据持久化目录。
  1Panel 前端不渲染 formField `help` / `placeholder`，**附录性说明写进 README 的
  「安装 / 配置」段落**，不写进表单 label（见 data-yml-schema.md 常见错误）。
- README 中含版本表格时，其版本一致性由 [lib/validate-batch.mjs](../.github/lib/validate-batch.mjs)
  的 `readReadmeVersionTable` / `validateReadmeVersion` 在自动更新批次校验中强制。
- 图标：**不允许占位符图标**。优先级：显式 URL → Dashboard Icons → Simple Icons → selfh.st Icons。

## 7. 部署链路（本地应用同步）

1. 修改 compose 或 `data.yml` 后 `git commit`（流程与红线见 [git-workflow.md](git-workflow.md)）。
2. 由 1Panel 计划任务拉取最新仓库并触发本地应用同步。
3. 在 1Panel UI 重新部署应用。
4. 上一版本的 `data/` 目录内容属于持久化数据，不随版本目录增删丢失。

## 相关文档

- [data-yml-schema.md](data-yml-schema.md) — 字段、类型、rules
- [compose-conventions.md](compose-conventions.md) — compose 红线与运行身份
- [automation.md](automation.md) — 自动更新对目录/README 的写入约束
- [troubleshooting.md](troubleshooting.md) — 环境特例与运行时故障
