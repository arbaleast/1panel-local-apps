# Postmortems（事故复盘全量档案）

> 职责（唯一）：历届事故的**完整**复盘（时间线 / 根因链 / 修复 / 回归测试 / 教训）。
> 本文件与代码一起演化：修复已合入的根因段落保留原文（防止知识倒退），并标注现行防线位置。
> 可操作速判表见 [troubleshooting.md](troubleshooting.md)；现行铁律见 [automation.md §1](automation.md#1-事件与权限隔离安全不变量)。

## 合并门禁与权限类事故

### auto-update 工作流曾是 CI 提权面（2026-11-01）

**事故**：旧版 [auto-update.yml](../.github/workflows/auto-update.yml) 顶层写
`permissions: contents: write / pull-requests: write`，且 `pull_request` 事件触发整个工作流——
任何外部 PR 的代码都能在持有 `secrets.PAT_TOKEN` 的 job 里执行（`detect-and-pr` job 的 checkout 用
PAT），典型的 CI 提权漏洞；该 job 还「检测 → 改 README → 推分支 → 开 PR → 立刻合并」，
等于让 PR 代码自己给自己发写权限。

**修复**（现行防线，[automation.md §1](automation.md#1-事件与权限隔离安全不变量)）：
PR 事件只跑只读 `validate`；写 job 事件白名单 + 限 `main`；顶层 `permissions: {}`；
PAT 只出现在写 job；脚本层事件护栏（[lib/pr-flow.test.mjs](../.github/lib/pr-flow.test.mjs)）。

**判定方法**：`grep -n "permissions\|PAT_TOKEN\|pull_request" .github/workflows/auto-update.yml`
逐条确认 PAT 与写权限没有出现在任何 PR 可达路径上。

### 自动更新 PR「开完就合」门禁缺失

**事故**：旧版 [bin/open-update-pr.mjs](../.github/bin/open-update-pr.mjs) 创建 PR 后立刻 merge，
不等检查、不校验内容——坏掉的 `data.yml` / `latest` tag / README 不同步直接进主干。

**修复**：开 PR 前跑 [lib/validate-batch.mjs](../.github/lib/validate-batch.mjs) 批次校验
（有 error 不开 PR）；开 PR 后 [lib/github.mjs](../.github/lib/github.mjs) 的 `waitForChecks`
轮询 check-runs + combined status，只有全部 success 才合并；failure / timeout / unknown 保留 PR
与远程分支、非零退出。

**注意**：`GITHUB_TOKEN` 开的 PR 不触发 `pull_request` 工作流（GitHub 防递归机制）→
必需检查永远 Pending → 门禁超时 → PR 保留不合并（安全失败）。所以本仓必须配置 `secrets.PAT_TOKEN`。

### PR title / HEAD commit 带 `[skip ci]` 锁死合并门禁

GitHub 的 skip 指令对 PR title / body / HEAD commit message 都生效 → 带 `[skip ci]` 的自动更新
PR 不会触发 `pull_request` 工作流 → 检查永远 Pending → 门禁只能超时。**正确做法**：自动更新的
commit message 与 PR title 都不带 skip 指令；防合并后 push 递归靠工作流 `on.push.paths` 白名单
（只匹配 `.github/**` 等自动更新链路文件）。回归：[lib/github.test.mjs](../.github/lib/github.test.mjs)
的 `buildCommitMessage` / `buildPullRequestTitle`。

## Registry / 版本选型类事故

### Registry 请求失败冒充「无更新」（2026-11-01）

**事故**：旧版 [lib/registry.mjs](../.github/lib/registry.mjs) 把网络错误 / HTTP 非 2xx / JSON
解析失败全部 `return null`，与「请求成功但无稳定 tag」混为一谈 → detect 记日志继续跑 →
整个 workflow 绿灯但该应用根本没检测过。

**修复**：`getLatestTag` 只在「请求成功且无可用稳定 tag」返回 `null`，其余抛 `RegistryRequestError`；
detect 三态（`success`/`skipped`/`failed`）写 `updates.json`，failed → 脚本退出码 2 →
workflow 末尾门禁 `exit 1`。**分页中途失败必须抛错**（GHCR 字典序返回最旧 tag，半截数据会选远古版本）。

### GHCR 未翻页 → traefik 3.0.3（2026-11-01，PR #41）

[lib/registry.mjs](../.github/lib/registry.mjs) 切 GhcrAdapter 后，cron 检出 `3.0.3` 并生成远古版本
目录。根因：GHCR `n=1000` 只是单页上限，tag 按字典序返回（traefik 2700+ tag，第一页只到
`v2.0.0-alpha6-*`）。修复：跟随 `Link: rel="next"` 翻页（MAX_PAGES=10，相对/绝对 next URL 均支持，
后续页失败保留已取 tag，第一页失败返回 null）。回归：[lib/registry.test.mjs](../.github/lib/registry.test.mjs)
case 22-24。判定：
`node -e "import('./.github/lib/registry.mjs').then(async m=>console.log(await m.createAdapter('ghcr.io/traefik/traefik:v3.6.6').getLatestTag('ghcr.io/traefik/traefik:v3.6.6','v3.6.6')))"`
返回 `v3.7.17` 这类新 tag 才正常，`3.0.3` 即命中。

### anirss 不更新：semver+后缀形态漏匹配（2026-09-08）

**症状**：上游已发 `v3.2.29(-arm32v7)`，仓内最末 `v3.2.24`，cron 不出 PR。

**根因**：[registry.mjs](../.github/lib/registry.mjs)（90 行附近）variant 正则
`^([a-zA-Z][a-zA-Z0-9]*)(?:-|$)` 对 `v3.2.18-arm32v7` 不匹配（`v` 后是数字），fallback 被
`pickLatest` 的 `PURE_SEMVER_RE = /^v?\d+\.\d+\.\d+$/` 过滤掉全部变体 tag，选 `v3.2.29`。
链式后果：9 个 versionDir 全部 `maxTo=v3.2.29` → 9 次对同一 `v3.2.29/` 目录 rmSync+cpSync，
**`v3.2.29-arm32v7/` 目录永远创建不出**。同源现象：PR #14 全空 before/after（refactor 后首个 cron，
`processApp` 返回路径漏处理导致全军覆没，波及 firecrawl/handbrake/hindsight/jellyfin/linkwarden/
llamacpp/moviepilot/qdrant/searxng/syncthing/vane）。

**修复**：variant 识别扩到 3 种 currentTag 形态（裸变体 / 变体+版本 / semver+后缀：先提 suffix 再
`pickLatest(stable.filter(t => t.endsWith('-'+suffix)))`，同 suffix 不存在走 fallback）。
清理 GhcrAdapter 内 8 处 `[DEBUG-hindsight]` console.log。回归 case 14-17。
教训：变体识别是 prefix+suffix 双维度复合查询；测试盲区即事故；`git grep DEBUG-` 应在合入前检查。

### collabora 降级到 2017 年 `2.1.5`（2026-10-19）

`pickLatest` 的「纯 semver 优先」让候选中存在任意 3 段 tag 时盖过非纯 semver：`collabora/code`
同时有 2017 年 `2.1.2~2.1.5` 与当前 `26.04.5.1.1` → 选 `2.1.5` → 新建 `2.1.5/` 目录（降级）。
修复：DockerHub/GHCR `getLatestTag` 新增**形态 4**——`currentTag` 匹配 `^\d+(?:\.\d+){3,}$`
时把候选收敛到同段数纯数字 tag 再 pickLatest，同段数不存在回退原逻辑。回归 case 18-21。
判定：`node -e "import('./.github/lib/semver.mjs').then(m=>console.log(m.pickLatest(['2.1.5','26.04.5.1.1'])))"`
返回 `2.1.5` 即命中坑。教训：接入多段数字版本镜像前先跑一次 pickLatest 验证选型。

### jellyfin 日期型目录被跨目录覆盖（2026-09-25）

**事故**：`jellyfin/` 混排纯 semver（`10.11.11/`）与日期型（`2026091410-arm64/`）目录。
`parse('2026091410-arm64') → [2026091410]` 数值最大 → `maxKnown` 选中日期型目录；
而 registry 变体正则不匹配日期型 tag → fallback `pickLatest` pure-semver 命中 `10.11.11` →
detect 判定「最新版本 = 10.11.11」→ `rmSync` + `cpSync` 覆盖 → **10.11.11 目录里手维护的
`name` / `CACHE_FOLDER_PATH` / 自定义 formFields 被兄弟目录整体顶掉**（auto-update PR 把 name
改回 `jellyfin 2026081705-arm64`、cache default 退回 `/dev/shm`）。

**修复**：① detect 加入 `SKIP_AUTO_UPDATE_APPS`（anythingllm / jellyfin，手维护）；
② 新增 `canCopyVersionDir(fromDir, toDir, targetExists)`——目标已存在且与来源不同时拒绝 cpSync，
`processApp` continue 跳过。

**教训**：混排日期型 + semver 的应用要么统一目录形态要么进白名单；只加 maxKnown 保护不够
（数值比较日期型永远最大）。

### 副作用 service 的 tag 劫持应用版本目录（2026-11-04，镜像版本引擎治理阶段 1 审计）

**事故**：审计 [lib/registry.mjs](../.github/lib/registry.mjs) 的旧「4 级形态级联 + 全局
`pickLatest` 回退」时发现两处**活的**误判（尚未被 CI 触发，但随时可能被自动更新触发）：

| 应用 | 当前镜像 | 旧实现选出 | 后果 |
|---|---|---|---|
| linkwarden（6 个版本目录） | `postgres:16-alpine` | `9.6.24` | **PostgreSQL 降级 12 个大版本** |
| firecrawl（6 个版本目录） | `rabbitmq:3-management` | `3.13.7` | 丢失 management 变体 |

**根因**：旧实现的形态级联要求「变体后缀形态必须是 `v<semver>-<后缀>`」（正则强制带 `v` 前缀），
且只处理「裸变体 / 变体+版本 / semver+后缀 / 4 段以上数字」四种形态。
`16-alpine` / `3-management` / `1.11.2-ls36` / `0.8.6-pg18-trixie` / `3.64.0-v1` 全部落空 →
落到 `return pickLatest(allStable)` —— **该回退完全忽略当前轨道**，于是
postgres 的纯 semver tag 里最高的是 2017 年的 `9.6.24`。

**同源的第二处问题**：新版本目录名取的是「各 service tag 的宽松数字段最大值」（`maxTo`），
于是**副作用 service** 的 tag 会劫持**应用**的版本目录名（linkwarden 生成 `linkwarden/9.6.24/`、
firecrawl 生成 `firecrawl/3.13.7/`）。

**与历史事故的关系**：这与 [jellyfin 日期型目录被跨目录覆盖](#jellyfin-日期型目录被跨目录覆盖2026-09-25)
是**同一个根因**（形态级联落空 → 全局回退 → 跨轨道选中）。jellyfin 当时用
`SKIP_AUTO_UPDATE_APPS` 白名单**绕过**（未修根因），于是根因留在原地，postgres / rabbitmq /
pgvector / handbrake / losslesscut / llamacpp / photopea 全部中招。

**修复**（镜像版本引擎治理阶段 2–4）：

1. 新增 [lib/version.mjs](../.github/lib/version.mjs)：**唯一**版本引擎。先**分类**
   （scheme + 轨道），再**同轨比较**。轨道 = 版本形态（`num:3` / `num:3@alpine` /
   `calver` / `pfx:server-cuda12@num:3` …），**跨轨道一律拒绝**。
2. [lib/registry.mjs](../.github/lib/registry.mjs) 退化为**纯传输层**（认证 / 分页 / 超时 /
   重试 / 请求去重 / 并发上限），选型一律委托给 version.mjs。
3. 版本目录名改由**主服务**（compose 里第一个带 image 的 service，与
   [lib/consistency.mjs](../.github/lib/consistency.mjs) 的 tag.dir 口径一致）决定；
   主服务未更新时保持原目录名（走「就地更新受管文件」）。
4. 回归：[lib/regression-images.test.mjs](../.github/lib/regression-images.test.mjs)（全仓 274 处
   存量镜像的解析与分类护栏）+ [lib/detect-updates-e2e.test.mjs](../.github/lib/detect-updates-e2e.test.mjs)
   （本地 mock registry 驱动真实 detect 链路的离线 E2E）。

**教训**：**「找不到匹配形态就回退到全局取最大」是版本选型里最危险的一行代码**。
匹配失败应当**拒绝**（宁缺毋滥），而不是退回到一个语义不同的候选集。
白名单是止血，不是修复。

## 脚本健壮性事故

### PR body 反引号进 shell → 批次 42 文件凭空消失（2026-10-20）

**事故链**：旧版 `execSync(\`curl ... -d ${JSON.stringify(...payload)} ...\`)` 中 body 的 markdown
反引号（`` `v3.2.51` ``、`` `anirss/v3.2.51/data.yml` ``）被 POSIX shell 当命令替换执行：

```text
/bin/sh: 1: 2026-10-20T03:03:25.637Z: not found      ← 检测时间被吃掉
/bin/sh: 1: v3.2.49: not found                       ← before/after 列被吃掉
/bin/sh: 1: anirss/v3.2.51/data.yml: Permission denied
```

body 被掏空 → GitHub 返回错误对象（无 `number`/`html_url`）→ 旧代码只判 JSON.parse 成功就打印
``[OK] PR 已开: undefined`` → merge 打到 `/pulls/undefined/merge` 得 Not Found →
**旧代码仍继续执行并删掉刚推送的远程分支** → 整批 42 文件丢失（该分支 PR 从未创建）。
同缺陷更早发作：PR #33（2026-10-13）、#35（2026-10-17）body 全空。

**修复**：① [lib/github.mjs](../.github/lib/github.mjs) 改 Node 内置 fetch（不经 shell，token 不进 ps），
`createPullRequest` 必须拿到数字 `number` 才算成功，否则抛 `GitHubApiError`；
② git 调用改 `execFileSync('git', [...])`，commit message 拆两个 `-m`（旧写法 `\n` 是字面量）；
③ 失败一律非零退出并保留远程分支，远程分支只在合并成功后删。回归：[lib/github.test.mjs](../.github/lib/github.test.mjs)
锁「反引号原样送达」16 case。

**教训**：永不把不可信内容（PR body / issue 标题 / 分支名 / commit message）拼进 shell 命令字符串；
API 响应必须做形状校验；失败时绝不执行清理动作。

### PR / merge API 查询失败未中止（2026-11 审计 P2）

防重查询（title 前缀 + head 过滤）失败时旧代码仅 `console.warn` 继续 → 无法确认是否已有重复 PR
的情况下仍会推分支 / 开 PR。**现行规则**：查询失败 = 中止（不做任何写操作）；推送用
`--force-with-lease`（带远端 SHA），不裸 `--force`。

## 容器运行时事故

### photoprism `init: true` 事故（2026-10-03）

`photoprism/260919/docker-compose.yml` 误加 `init: true` → s6-overlay 要求自身 PID 1，
tini 抢占后 `s6-overlay-suexec: fatal: can only run as pid 1` → 启动失败被 `restart: always`
反复重拉。解决：删 `init: true`。判定：镜像基线用 s6-overlay（`linuxserver/*`、`hotio/*`、
PhotoPrism、部分 Go 自建镜像）或日志含 `s6-overlay-suexec` / `s6-rc`；同源禁忌还有 `user:`、`pid:`。
自查：`grep -rn --include="docker-compose.yml" -E "^\s*init:\s*true" .`
（[bookorbit/3.2.0](../bookorbit/3.2.0/docker-compose.yml) 第 47 行也有 `init: true`，改前确认镜像）。

### jellyfin 官方镜像的运行身份（user: vs PUID/PGID）

`jellyfin/jellyfin` 官方镜像 `ENTRYPOINT ["/jellyfin/jellyfin"]` + 无 `USER`，
**不读** `PUID`/`PGID`；换身份只能 compose `user: "${UID}:${GID}"`（上游文档原话："Replace
`uid:gid` if you want to run jellyfin as a specific user/group"），且 bind mount 目录必须先
`chown` 同 UID/GID，否则启动即失败。完整机制对照表见
[compose-conventions.md §5](compose-conventions.md#5-容器运行身份puidpgiduidgid)。

### 运行身份全仓统一（2026-11）

每个应用均提供运行身份参数，默认 `99`/`100`（与 kdenlive/openshot/unmanic 一致）；两套机制互斥、
选错启动失败——判定方法与已知 PUID 家族清单见
[compose-conventions.md §5](compose-conventions.md#5-容器运行身份puidpgiduidgid)。

## 1Panel UI / schema 坑类事故

### 1Panel 前端 formField 白名单与死字段

- 1Panel [params/index.vue](https://github.com/1Panel-dev/1Panel/blob/main/frontend/src/views/app-store/apps/params/index.vue)
  仅支持 6 种 type；`type: boolean` 不渲染且无报错 → 用 `type: select` + `values` 模拟
  （anirss / firecrawl / mihomo / moviepilot / handbrake / traefik 均有同模式字段）。
- 前端不渲染 formField `help:` / `placeholder:`（历史遗留死代码：searxng、mineru、vane 均有
  `help:`）。正确做法：提示值写进 `default`，冗长说明进应用 README。

### dendrite label 超长截断（2026-09-11）

[dendrite/v0.15.2/data.yml](../dendrite/v0.15.2/data.yml) 最初把 `DATABASE_URL` 的 i18n label 写成
60+ 字符「label 内嵌使用说明」（8 语种 ≈500 字符垃圾）→ UI 单行截断。解决：label 收回 ≤12 字符
短词，详细说明移到 README 的「安装 → 切到 PostgreSQL」。另：`DATABASE_URL` 单字段 + `paramCommon`
被前端正则 `/^[a-zA-Z0-9]{1}[a-zA-Z0-9._-]{1,63}$/` 拒（含 `:`/`@`/`?`/`/`）→ 拆成
`DB_TYPE/DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` 6 个分字段由 init.sh 拼。
1Panel-postgresql 容器名形如 `1Panel-postgresql-ZU4y`（Base32 `[A-Z0-9]` 4 字符后缀），
PG host 段必须与之完全一致（host 校验用 `^[A-Za-z0-9-]+$`，不能用小写宽松正则）。

### photoprism 纯数字 tag 的 values[].value unmarshal（2026-10-03）

上游发布日期型无字母 tag `260919`，`- value: 260919` 被解析成 int → 1Panel Go struct
`AppFormValue.formFields.values.value of type string` 报错、版本同步失败。此前 tag
`260919-28c46a116` 含字母是 string，恰好掩盖。解决：value（连同 default/label）加双引号。
lint（js-yaml + zod）不报这个错，本地校验脚本与说明见
[data-yml-schema.md §6](data-yml-schema.md#6-常见校验错误速查)。

### 几何性 schema 联合（union）盲区：firecrawl / jellystat / llamaindex / immich / pgvector / qdrant 等

- zod 3.x `invalid_union` 隐藏内层错误；诊断脚本写 `.agent_cache/`
  （gitignore 已忽略）用 safeParse 分 case 展开。
- firecrawl 的真正根因是 formFields 列表里重复且残缺的 `- default: 1Panel-localpgvector-kD9L`
  （缺 envKey/type），不是缺 key/name；**union 错误先 grep `^- default:` 找孤立项**。
- 历史遗留已被 lint 拒绝：`type: photo`（immich）、`type: database`（pgvector/qdrant）、
  `rule: paramHttp`（llamaindex）、`rule: paramInt`（immich×4）、`rule:` 为 object
  （jellystat）、formField 用 `key:` 而非 `envKey:`（jellystat）、顶层平铺 `key/name/formFields`
  （jellystat/llmwiki）、版本级缺 key/name（hindsight×5、jellyfin×2、llamacpp×2、infinity/cu124、
  mineru/3.4.2、gecoos/v2.2）。全部解法见 [data-yml-schema.md](data-yml-schema.md)。

### marginalia 顶层 volumes 插值（commit `3d08ed4`）

1Panel 拒绝顶层 `volumes` 键名 `${CONTAINER_NAME}-xxx`；改相对路径 bind mount 并删顶层
`volumes:` 块，见 [marginalia/0.3.4](../marginalia/0.3.4/docker-compose.yml)（commit `3d08ed4`）。

## 变量型应用检测事故

### bookorbit 等 9 个双 envKey 变量型应用不更新（2026-10-14）

**症状**：上游已发 `ghcr.io/bookorbit/bookorbit:3.4.0`，但本仓 `bookorbit/3.2.0/` 停在 3.2.0；
其它 8 个 `image: ${IMAGE}:${APP_VERSION}` 双 envKey 形态的应用（photoprism / mineru / onenav /
cinny / music-tag-web / navi-homepage / newapi / xunlei）同样检不出新版本。detect 静默跳过，cron 不出 PR。

**根因**：detect 的变量型分支假设"image 模板只含 1 个 `${VAR}`，且该 envKey 的
`formField.default` 持有完整镜像字符串"，对每个 envKey 循环做 `defaultVal.split(':')`：

```js
for (const envKey of varEnvKeys) {
  const [imageRepo, currentTag] = defaultVal.split(':');
  if (!imageRepo || !currentTag) continue;   // ← 静默 continue
}
```

bookorbit 这 9 个应用把镜像拆成两个 envKey：

- `APP_IMAGE` default = `ghcr.io/bookorbit/bookorbit`（无 tag）→ split 后 `currentTag = undefined` → continue
- `APP_VERSION` default = `3.2.0` → split 后 `imageRepo = '3.2.0'`、`currentTag = undefined` → continue

两个 envKey 单独都失败，**整个变量型分支对双 envKey 形态输出 0 更新**。旁证：
`grep "image: \${X}:\${Y}" --include=docker-compose.yml -r .` 命中 9 个应用，全部中招。

**修复**：新增 [lib/compose.mjs](../.github/lib/compose.mjs) 纯函数
`resolveImageTemplate(image, fields)`，统一处理 2 种变量型形态：

1. **单 envKey 持有完整字符串**：`image: ghcr.io/foo/bar:${VERSION}` +
   `VERSION.default = 'ghcr.io/foo/bar:v1.19.18'`（mihomo 业务，行为不变）
2. **双 envKey 拆 repo/tag**：`image: ${APP_IMAGE}:${APP_VERSION}` +
   `APP_IMAGE.default = 'repo'`、`APP_VERSION.default = 'tag'`（bookorbit 等 9 个，新增支持）

`resolveImageTemplate` 返回 `{imageRepo, currentTag, envKey, defaultVal, newDefaultVal}`；
detect 用 `rebuildImageDefault(image, envKey, imageRepo, latest)` 计算写回新值：形态 2 直接覆盖
整个 field（`repo:newTag`），形态 3 只覆盖 tag 那个 field（repo 字段不动）。detect 末尾的写回逻辑天然兼容两种形态。
`createAdapter` / `parseImage`（[lib/registry.mjs](../.github/lib/registry.mjs)）仍是镜像字符串解析的唯一入口。

**回归测试**：[lib/compose.test.mjs](../.github/lib/compose.test.mjs) 19 case（形态 2 拆分与
registry 端口在 repo 段内 `ghcr.io:443/foo` 的边界、形态 3 bookorbit / photoprism 复杂 tag
`260919-28c46a116`、envKey 缺失 / 默认值含 `:` / 3+ envKey 全部保守放弃返回 null）。

**教训**：

- 变量型 compose 模板**至少 2 种形态**；只假设一种输入形态的逻辑必须在 `lib/` 层建纯函数 +
  配套测试，不要在 detect 入口堆 if-else。
- "按 envKey 单独循环"是双 envKey 形态的根本反模式——修复本质是"对 image 整体解析一次"。
- formField 类型/形态清单必须集中在 [compose-conventions.md](compose-conventions.md) /
  [data-yml-schema.md](data-yml-schema.md) 这类文档单点维护，否则新应用上线时无人发现假设不成立。
- 端到端 dry-run 会写盘（`updates.json` + 新版本目录），隔离验证须走
  `.agent_cache/` 临时脚本 + 清理（见 [CONTRIBUTING.md](../CONTRIBUTING.md) 工作区卫生）。

## 初始化与配置生成类事故

### cfnb：静态二进制读不进 snake_case 配置（viper/mapstructure）

静态二进制（Go + viper/mapstructure）按 **Go 字段名**（小写无下划线）匹配键，上游镜像自带默认
`config.yaml` 是 snake_case → **静默忽略、照抄即失效**。差分探测法：每次只改一个键跑一遍，
用启动日志里的可观测量（模式文案 / 成功率百分比 / 并发数 / 监听端口 / 订阅路径）判断该键是否生效；
判定要精确解析数字（正则抓具体数值），别用「行里含某数字」粗判，避免时间戳假阳性。
`scripts/init.sh` 按 1Panel 安装参数生成配置挂进容器：写文件**原地覆写**（tempfile + mv 会换
inode，容器仍持旧文件）；数据目录固定 compose 同级 `./data`，不读 `.env` 里可能存在的
`DATA_PATH`。参考 [cfnb/v1.0.1/scripts/init.sh](../cfnb/v1.0.1/scripts/init.sh) 与
[cfnb/README.md](../cfnb/README.md) 的「配置说明」表。

### hindsight：上游/容器忽略的非标准变量名（同上方法可探测）

上游容器进程读取的环境变量名未必与 compose 声明一致（`HINDSIGHT_CP_HOSTNAME` vs
`HINDSIGHT_CP_HOST`）——交叉验证 Dockerfile / 启动脚本 / `.env.example`；调试日志清理
（`[DEBUG-hindsight]` 应在合入前 `git grep DEBUG-`）。

### anirss 后缀维度的人工补数与 pickLatest 双刃剑

事故当时的手工补救：为 anirss 补出 `v3.2.29/` 与 `v3.2.29-arm32v7/` 两个目录
（cpSync `v3.2.24` / `v3.2.18-arm32v7` 后改 compose image），保证 1Panel UI 当下可用。
补充教训：`pickLatest` 的 `PURE_SEMVER_RE` 过滤是双刃剑——把变体 tag 当作「非 semver」丢掉，
上游同 suffix 有更新时会静默漏报，suffix 维度需要专门筛选（不能依赖 fallback 退路）。

## 用户日常安装体验

- 生产可用的"浅色提示"：示例值写进 `formField.default`（Element Plus 会显示在输入框），
  不用不渲染的 `help`/`placeholder`；典型对照
  [personal-todo-vault/latest/data.yml](../personal-todo-vault/latest/data.yml)
  仅 4 个字段（HTTP 端口 / 容器内端口 / 时区 / Origin），SMTP 与坚果云 WebDAV 全走
  应用内配置中心（AES-256-GCM 落盘）。
