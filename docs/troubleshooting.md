# Troubleshooting（环境与故障排查）

> 职责（唯一）：执行环境特例（DSH 沙箱、SSH、node 可见性）与一些容器运行时的判定方法。
> 常规红线见 [git-workflow.md](git-workflow.md)；自动化故障见 [automation.md](automation.md) / [postmortems.md](postmortems.md)。

## 1. 沙箱中 `node` 不可见的应对

本仓 lint / test 依赖 `node >= 24`（`package.json` `engines` 已声明，与 CI `.nvmrc` 一致），
但 DSH 沙箱（Windows + fnm + `cmd.exe`）下 `node` / `npm` **经常不在 PATH**：
`'node' is not recognized as an internal or external command`。

根因：

- `D:\Env\UserScoop\shims\fnm.exe` 在，但沙箱 shell 不执行 fnm 的 PATH 注入钩子
  （`fnm current` 报 `` `fnm env` was not applied in this context.``）；
- `where node` 命中 `C:\Windows\System32\where.exe`；shims 目录只有 `fnm.exe`，没有 `node.exe` shim；
- fnm 实际安装目录可能被搬走或未同步（`fnm list` 显示 v22.x default 但目录不存在）。

排查阶梯（按代价从低到高）：

1. **确认任务可否仅靠 git 完成**：文档、commit、push、revert、status、diff 均可仅用 git。
   不要为「想跑一次 lint」反复尝试唤起 node。
2. `where node` / `where npm` / `where fnm` 区分「fnm 在但未注入」与「fnm 都不在」；
   全部 `INFO: Could not find` 时不要继续追 node。
3. `fnm env --shell=cmd` 可列出 multi-shell PATH，但**该 PATH 不持久**，下一条命令仍找不到 node。
4. 止损（推荐默认）：node 相关操作留给用户的真实 shell；不要在沙箱中重复
   `npm install` / `node …` 超过一次，连续失败即转文档/commit 并在报告中如实记录「未验证」。

反例：`cd .agent_cache && node x.mjs`、`npm run lint | tee out.txt`（cmd 下 tee 对 npm 包装器
退出码语义不一致）、全盘递归 `dir /b /s …` 找 node.exe（30s+ 且卡后台终端）。
正例：用 `git diff` / `git status` / `git log --oneline` 完成同类校验。

Linux 沙箱（本仓 CI 同构）有 node 时一切照常；跑法见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 2. Git push 相关的沙箱环境

- 沙箱 SSH 鉴权默认不可用（无 known_hosts / agent）。需要 push（须先获用户授权）时：
  1. `ls -la ~/.ssh/`（或宿主提供的密钥目录）确认可用私钥；
  2. 配置 `core.sshCommand` 时**不要**用 `-o StrictHostKeyChecking=no`（静默关闭主机校验会先于
     MITM 中招），改用显式 known_hosts：
     ```bash
     ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts
     git config core.sshCommand "ssh -i <私钥路径> -o UserKnownHostsFile=$HOME/.ssh/known_hosts"
     git remote set-url origin git@github.com:arbaleast/1panel-local-apps.git   # HTTPS remote 时切换
     git push origin <branch>
     ```
  3. SSH key 有密码保护时，用 ssh-agent 或 `GIT_SSH_COMMAND` 里的 `AddKeysToAgent`/`UseKeychain`。
  - 私钥路径**只写在 git config / 环境变量**，不写进仓库任何文件。
  - push 前重读 [git-workflow.md](git-workflow.md) §1 授权铁律。
- 严禁把密钥 / token 提交进仓库，或写入 git 全局配置里指向明文文件的 credential helper。

## 3. 运行时故障速判

| 症状 | 判定 | 依据文档 |
|---|---|---|
| 容器启动即失败、日志刷 `s6-overlay-suexec: fatal: can only run as pid 1` | 镜像是 s6，误加 `init: true` / `user:` / `pid:` | [compose-conventions.md §6](compose-conventions.md#6-s6-overlay--pid-1-禁忌)、[postmortems.md](postmortems.md#photoprism-inittrue-事故2026-10-03) |
| 新 formField 在 1Panel UI 不出现 | type 不在 6 种控件白名单（如 `boolean`） | [data-yml-schema.md §4.1](data-yml-schema.md#41-type-白名单6-种) |
| 表单提交报「支持英文、数字、.-和_，长度 2-64」 | 提交了完整 DSN/URL 走 `paramCommon` | [data-yml-schema.md §4.2](data-yml-schema.md#42-rule-白名单6-种) |
| 1Panel 报 Go struct unmarshal number → string | select `values[].value` 是纯数字未加引号 | [data-yml-schema.md §4.3](data-yml-schema.md#43-其余字段要求zod) |
| `volumes additional properties '${CONTAINER_NAME}-xxx' not allowed` | 顶层 volumes 用了 ${} 插值命名卷 | [compose-conventions.md §3](compose-conventions.md#3-顶层-volumes-命名卷的-1panel-限制) |
| 容器内配置完全不生效（无报错） | 静态二进制按 Go 字段名匹配，上游默认 config 是 snake_case | [compose-conventions.md §7](compose-conventions.md#7-initsh-配置生成约定) |
| `bash: UID: readonly variable` 中断 init.sh | source 1Panel `.env` 未改名 | [compose-conventions.md §7](compose-conventions.md#7-initsh-配置生成约定) |
| auto-update 合并门禁总是超时 | PAT_TOKEN 缺失 / PR title/HEAD commit 带 `[skip ci]` / 轮询时长不足 | [automation.md §4](automation.md#4-批次校验与-pr-门禁) |
| 自动更新选到远古版本 | GHCR 未翻页 / 多段数字 tag 被纯 semver 抢占 | [automation.md §3](automation.md#3-镜像版本选型口径)、[postmortems.md](postmortems.md) |

## 4. 历史事故全量复盘

更完整的 incident narrative（时间线、根因链、回归 case）见 [postmortems.md](postmortems.md)，
本文件只保留可操作的速判表。
