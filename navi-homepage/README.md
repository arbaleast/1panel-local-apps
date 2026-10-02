# Navi Homepage

[DamiSunshine](https://github.com/DamiSunshine) 开发的轻量级个人导航站：**前端可视化编辑 + 零依赖 Node 后端**的 All-in-One Docker 镜像，开箱即用。当前 v1.2.0 包含 19 个测试套件 / 981 项断言 / 0 失败。

- **GitHub**: <https://github.com/DamiSunshine/navi-homepage>
- **License**: MIT
- **上游镜像**: `ghcr.io/damisunshine/navi-homepage`（GHCR，多架构 `linux/amd64` + `linux/arm64`）
- **目录结构**: `v1.2.0/` 版本目录（与上游 tag `v1.2.0` 对齐）

## 功能要点

- **可视化编辑模式**（类 sun-panel）：点击右上角「编辑」进入编辑模式 ——
  - 卡片拖拽排序，支持跨分组拖动
  - **分组整体拖动**：按住分组标题栏把整组卡片一并拖到新位置
  - **拖链接建卡**：把书签 / 聊天窗口里的链接直接拖到页面上，自动预填地址与标题
  - 添加 / 修改 / 删除卡片（弹窗表单：名称、描述、外网地址、内网地址、在线图标、本地图床 Logo）
  - 分组添加 / 重命名 / 删除
  - 「保存」通过 API 直接写回服务器 `config.json`；「备份」下载结构化备份；「导入」校验后一键恢复
- **首次使用引导**：配置里一张卡片都没有时，给一个可跳过的新手向导，并在末尾提醒公网部署务必设访问密码
- **数据备份与恢复**：一键导出含 SHA-256 校验和的结构化备份，`.json`（仅配置）或 `.zip`（配置 + 图床库全部图片）
- **首页系统状态板**：首页顶部一行 Widget 显示容器运行数 / CPU / 内存 / 磁盘水位，30 秒轮询
  - **降级是一等公民**：没挂 Docker socket、非 Linux、接口不存在时对应项显示「不可用」而不是 0
  - 内存优先读 cgroup，其次 `/proc/meminfo`；磁盘用 `fs.statfs` 直接量数据盘
  - 页面切到后台即**暂停轮询**，切回时若数据陈旧立刻补一次
  - 可用 `NAVI_STATUS_BOARD=0`（关）或本表单的状态板开关（关）整体停用
- **卡片 Logo 本地上传**：导航项可上传本地图片（PNG / JPEG / GIF / WebP）作为 Logo，服务器按文件头魔数校验真实类型
- **本地图床库**：上传过的图片进入图床库，可被任意卡片重复选用 ——
  - **批量上传**：一次可选多张，单张上限 3MB，逐张独立校验
  - **引用保护**：删除仍被卡片引用的图片时默认拒绝，需二次确认
- **内外网切换（全局三态 + 卡片级策略）**：
  - 全局开关三态循环：**自动 → 只用内网 → 只用外网**
  - 每张卡片还可单独指定 `netMode`（`auto` / `lan` / `wan`），**卡片级优先**
  - 「自动」模式下对每张卡片的内网地址做**异步可达性探测**（2 秒超时）
- **IPv4 / IPv6 双栈**：服务绑定 `::`，同时接受 IPv4 与 IPv6 连接
- **图标本地优先**：`public/icons/` 内置 **227 个常用图标**（含国内站点），解析顺序「本地 → 公共 CDN → 首字母回退」，内网 / 断网也能出图
- **Docker 服务发现**（可选）：挂载 `/var/run/docker.sock` 后自动识别宿主机容器并生成卡片
- **访问密码保护**：`NAVI_PASSWORD` 强制校验，留空会拒绝启动（1Panel 端表单 `required: true` 也会拦截）

## 目录结构

```
navi-homepage/
├── data.yml                 # 根元数据（跨版本共享）
├── logo.png                 # 应用图标
├── README.md                # 本说明
└── v1.2.0/                  # 当前版本（与上游 tag v1.2.0 对齐）
    ├── data.yml             # 版本元数据 + formFields
    ├── docker-compose.yml
    ├── data/                # 持久化占位（.gitkeep）
    │   ├── config.json      # ← 首次启动由 init.sh 从镜像复制
    │   └── uploads/         # 本地图床库目录
    └── scripts/
        └── init.sh          # 首次安装初始化（1Panel 调起）
```

## 安装

1. 1Panel → 应用商店 → 本地应用 → 选择 `navi-homepage`
2. 选择版本 `v1.2.0`
3. 主机侧 HTTP 端口默认 `48090`（容器内 `80`）
4. **访问密码**（必填）：建议首次安装填一个临时密码，登录后通过 UI 修改
5. **登录用户名**（可选）：留空则仅用密码；填了则用户名 + 密码同时校验
6. **会话有效期** 默认 72 小时
7. **站点标题 / 副标题** 默认 `Navi` / `个人导航站`
8. **内网 / 外网地址**（可选）：如 `192.168.1.10` / `nav.example.com`，不填则 Navi 自动探测
9. **状态板** 默认启用
10. **Docker 服务发现** 默认禁用（启用需手动在 1Panel UI 编排里添加 socket 挂载，见下文）
11. 提交安装
12. 浏览器访问 `http://<1Panel 主机 IP>:<HTTP 端口>`，用上面设置的密码登录

> ⚠️ **首次启动行为**：`scripts/init.sh` 在 1Panel 调起 `docker compose up -d` 之前执行 —— 若主机侧 `./data/config.json` 不存在，从镜像内 `public/config.example.json` 复制示例配置。**不会**覆盖已存在的配置。

## 配置

### 表单字段

| 字段 | 默认值 | 必填 | 说明 |
|------|--------|------|------|
| 镜像 | `ghcr.io/damisunshine/navi-homepage` | 是 | 1Panel 自动按 `linux/amd64` 或 `linux/arm64` 拉取多架构镜像 |
| 版本 | `v1.2.0` | 是 | 上游 GitHub tag，建议跟随上游稳定版 |
| HTTP 端口 | `48090` | 是 | 主机侧端口，映射到容器内 `80` |
| 访问密码 | `navi-homepage` | 是 | **首次安装后立即改！** 默认值仅供首次登录，**暴露公网前必须设强密码** |
| 登录用户名 | _空_ | 否 | 留空则仅用密码；填了则用户名 + 密码同时校验 |
| 会话有效期 | `72` | 是 | 单位：小时，过期需重新登录 |
| 站点标题 | `Navi` | 否 | 展示层生效，不写回 config.json |
| 站点副标题 | `个人导航站` | 否 | 展示层生效，不写回 config.json |
| 内网地址 | _空_ | 否 | 形如 `192.168.1.10`（不含协议头），不填则 Navi 自动探测 |
| 外网地址 | _空_ | 否 | 形如 `nav.example.com`（不含协议头），不填则降级用内网地址 |
| 状态板 | `启用` | 是 | 首页顶部状态板开关，禁用后整块静默隐藏 |
| Docker 服务发现 | `禁用` | 是 | 启用需先在 1Panel UI 编排里挂载 socket（见下文） |
| 时区 | `UTC` | 否 | 影响日志时间戳 |

### Docker 服务发现

启用 Navi 的「Docker 服务发现」功能（首页显示所有容器并支持一键转卡片）需要把宿主机的 Docker Socket 暴露给容器：

1. 1Panel → 应用 → `navi-homepage` → 「编排」
2. 切换到「编辑模式」（YAML 视图）
3. 在 `navi-homepage` service 的 `volumes` 列表里添加：
   ```yaml
   - /var/run/docker.sock:/var/run/docker.sock:ro
   ```
4. 保存（1Panel 会重新创建容器）
5. 在「参数」页把 **Docker 服务发现** 切到「启用」
6. 重启容器

> ⚠️ **安全提示**：Docker socket 让容器拥有等价于宿主机 root 的 Docker 控制权。仅在可信环境启用；多租户 / 公网部署请保持禁用。

## 数据持久化

| 容器内路径 | 主机侧路径 | 用途 |
|------------|------------|------|
| `/app/data` | `./data` | **整目录挂载**（关键！） —— 包含 `config.json` + `uploads/` |
| `/app/data/config.json` | `./data/config.json` | Navi 的全部配置（卡片、分组、设置） |
| `/app/data/uploads/` | `./data/uploads/` | 本地图床库（用户上传的 Logo） |

> ⚠️ **关于整目录挂载**：上游 README 强调单文件挂载下写配置会走"跨挂载点 rename"，在部分平台（如飞牛 NAS）触发 `EBUSY/EXDEV` 保存失败；**整目录挂载**让 rename 发生在同一挂载点内，天然规避此问题。**请勿**改成 `config.json` 单文件挂载。

## 备份与恢复

Navi 自身提供两种备份形态（在网页 UI「编辑 → 备份」处触发）：

- **`.json`**：仅配置（卡片 + 分组 + 设置），体积小，可直接打开查看
- **`.zip`**（推荐）：配置 + 图床库全部图片，包内逐项 SHA-256 + 长度校验

**主机侧备份**也很简单（直接复制 `./data/` 即可）：

```bash
# 完整备份
cp -a /opt/1panel/apps/navi-homepage/v1.2.0/data/ /backup/navi-homepage-$(date +%Y%m%d)/

# 恢复
cp -a /backup/navi-homepage-20260101/* /opt/1panel/apps/navi-homepage/v1.2.0/data/
# 然后在 1Panel UI 重启 navi-homepage 容器
```

## 升级

### 跟随上游 release 升级

上游每个 GitHub release 都会自动构建并推送镜像到 GHCR。本仓：

1. 把镜像 tag 拉成最新上游 release（参考上游 [releases](https://github.com/DamiSunshine/navi-homepage/releases)）
2. 在 1Panel UI 修改 `navi-homepage` 应用的「版本」字段
3. 提交升级（1Panel 会拉新镜像并重启容器）
4. 主机侧 `./data/config.json` 自动保留（整目录挂载），**配置不丢**

### 升级注意事项

- 主机侧 `./data/config.json` 是兼容历史版本的。**不要**在升级时删除它
- 如需切换到上游最新开发版，把 `APP_VERSION` 字段改为对应 tag（如 `v1.3.0`）
- 上游 schema 变更时（罕见），Navi 启动器会自动迁移 config.json；如迁移失败会回退到示例配置（**用户编辑会丢**，请先备份）

## 镜像更新

本应用使用 `ghcr.io/damisunshine/navi-homepage`（多架构 GHCR manifest），不在本仓 `.github/workflows/auto-update.yml` 的 hardcode 检测范围（compose 用 `${IMAGE}` / `${APP_VERSION}` 变量，详见 [AGENTS.md](../AGENTS.md) 「Automation」一节）。

手动拉取最新镜像：

```bash
docker pull ghcr.io/damisunshine/navi-homepage:v1.2.0
# 1Panel UI → 应用 → navi-homepage → 重启
```

## 参考

- [Navi Homepage 上游仓库](https://github.com/DamiSunshine/navi-homepage)
- [Navi Homepage 镜像部署指南](https://github.com/DamiSunshine/navi-homepage/blob/main/docs/image-deploy-guide.html)
- [Navi Homepage 飞牛 fnOS 一键安装包](https://github.com/DamiSunshine/navi-homepage/releases)（`.fpk` 格式）
- [上游 Dockerfile 与构建流程](https://github.com/DamiSunshine/navi-homepage/tree/main/.github/workflows)
- [上游 CHANGELOG](https://github.com/DamiSunshine/navi-homepage/blob/main/CHANGELOG.md)
