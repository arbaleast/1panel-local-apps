# Music Tag Web

Music Tag Web 是一款**自托管的本地音乐库管理 Web 应用**,基于 Docker 一键部署,支持自动刮削歌曲标签、封面、歌词与元数据,并提供浏览器端批量编辑与重命名能力。面向 NAS / 个人音乐收藏场景,**仅供本地学习与个人使用,不得用于商业用途**。

- **GitHub**: <https://github.com/xhongc/music-tag-web>
- **官方文档(V2)**: <https://xiers-organization.gitbook.io/music-tag-web-v2/>
- **Docker Hub 镜像**: <https://hub.docker.com/r/xhongc/music_tag_web>
- **License**: GPL-3.0(附加禁止商用补充条款)

## 核心特性

- 自动刮削歌曲标签、封面、歌词与艺术家信息(对接主流音乐元数据源)
- Web 端可视化批量编辑、重命名与匹配修正
- 自带内部 SQLite 数据库,默认开箱即用;**可选**外部 MySQL/MariaDB
- 内置 nginx / gunicorn / redis / Celery worker + beat / rpc_service,supervisord 统一编排
- 提供 `/admin` 管理后台,首次部署使用 `admin / admin` 登录,强制立即修改密码
- 容器内服务端口固定 `8002`(V2 协议)

## 快速开始

1. 在 1Panel 应用商店中找到 **Music Tag Web**,选择版本 `2.7.7`
2. 在「应用参数」中按需填写端口(默认 `8002`)、是否启用外部 MySQL、`WORKER_NUM` 等
3. 点击「安装」,1Panel 将拉取镜像 `xhongc/music_tag_web:2.7.7` 并启动容器
4. 部署完成后浏览器访问 `http://<服务器IP>:<端口>/admin`,使用 `admin / admin` 登录并立即改密

## 目录结构

本仓库按 1Panel 应用规范组织:

```
music-tag-web/
├── data.yml               # 根元数据
├── logo.png               # 应用图标
├── README.md              # 本说明
└── 2.7.7/                 # V2 协议 + 变量型镜像
    ├── data.yml           # 版本配置 + formFields
    ├── docker-compose.yml
    └── data/              # 持久化占位(.gitkeep)
```

## 端口说明

- 容器内服务端口固定为 `8002`(V2 协议,旧 V1 为 8001,本版本未提供)
- 主机侧端口由 1Panel 在安装时自动分配,引用变量 `${PANEL_APP_PORT_HTTP}`,默认 `8002`
- 如启用「外部 MySQL」,需自行保障 `3306`(默认)可达

## 数据持久化

| 容器内路径 | 主机侧路径 | 用途 | 是否必填 |
| --- | --- | --- | --- |
| `/app/media` | `./media` | 用户的本地音乐库根目录,容器内可直接浏览 | **必填** |
| `/app/data` | `./data` | 应用配置 + SQLite/缓存 + 封面 + 日志等 | **必填** |
| `/app/download` | `./download` | 后台监控下载目录,自动入库(可选) | 否 |

> 请勿把 `./data` 目录加入版本库外的备份(应用自身已完成数据迁移);如需重置数据,停止容器后删除 `music-tag-web/2.7.7/data/` 即可。

## 配置项说明

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `IMAGE` | text | `xhongc/music_tag_web` | 镜像名称(变量型,不在自动更新范围) |
| `APP_VERSION` | text | `2.7.7` | 镜像 tag,跟随上游稳定版手动更新 |
| `PANEL_APP_PORT_HTTP` | number | `8002` | 主机侧 HTTP 端口 |
| `ENABLE_MYSQL` | select | `false` | 是否启用外部 MySQL;关闭时容器内置 SQLite |
| `MYSQL_HOST` | text | _(空)_ | MySQL 主机;留空走 SQLite |
| `MYSQL_PORT` | number | `3306` | MySQL 端口 |
| `MYSQL_USER` | text | `root` | MySQL 用户名 |
| `MYSQL_PASSWORD` | password | _(空)_ | MySQL 密码 |
| `MYSQL_DB_NAME` | text | `music_tag` | MySQL 数据库名,**需提前在 DB 内 `CREATE DATABASE music_tag;`** |
| `WORKER_NUM` | number | `8` | 后台 Celery worker 并发数,控制批量刮削并发度 |

### 启用外部 MySQL 步骤

1. 在外部 MySQL/MariaDB 中先建库:`CREATE DATABASE music_tag DEFAULT CHARACTER SET utf8mb4;`
2. 在 1Panel 应用参数中将 `ENABLE_MYSQL` 切换为「启用」
3. 填入 `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DB_NAME`
4. 重建容器,容器启动后会自动建表

## 升级方式

本应用采用**变量型镜像**(`${IMAGE}:${APP_VERSION}`),不参与仓库的 hardcode 自动更新流程。升级方式:

1. 在仓库内编辑 `music-tag-web/2.7.7/data.yml` 中的 `APP_VERSION` 默认值(如 `2.7.8`)
2. 提交并推送到 GitHub
3. 由 1Panel 计划任务拉取最新仓库,触发本地应用同步
4. 在 1Panel UI 中对该应用执行「升级」,容器将拉取新 tag

> 若上游发布大版本且端口/卷结构发生变化,建议新增版本目录(如 `2.8.0/`)而非就地改 `2.7.7`,以便历史部署保留原行为。

## 部署

参考 [`AGENTS.md`](../AGENTS.md) 的 *Deployment* 章节:本地修改 compose 或 data.yml → `git commit` & `git push` → 1Panel 计划任务拉取最新仓库 → 1Panel UI 重新部署应用。

## 许可与合规

- 上游代码遵循 **GPL-3.0** 协议,并附项目自定义补充条款**禁止任何形式的商业用途**
- 本仓库仅作为集成与镜像封装,所有权利归原作者 [`xhongc`](https://github.com/xhongc) 所有
- 部署此应用即视为同意上游许可条款;**禁止** 将其用于商业场景或二次销售
