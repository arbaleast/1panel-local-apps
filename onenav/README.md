# OneNav

[xiaoz](https://github.com/helloxz) 开发的开源免费书签 / 导航管理器：**PHP + SQLite 3** 单文件数据库，**一处部署、随处访问**，适合作为个人 / 家庭 / 团队的浏览器书签集中仓库。

- **GitHub**: <https://github.com/helloxz/onenav>
- **Docker 镜像仓库**: <https://github.com/helloxz/docker-onenav>
- **License**: Apache-2.0
- **官方镜像**: `helloz/onenav`（Docker Hub，多架构 `linux/amd64` + `linux/arm64`）
- **当前版本目录**: `1.2.4/`（与上游 [GitHub release tag](https://github.com/helloxz/onenav/releases/tag/1.2.4) 对齐）

## 功能要点

- **集中式书签管理**：浏览器书签一处存储，跨设备 / 跨平台 / 跨浏览器无缝访问
- **多种主题风格**：默认内置 `default` / `default2` / `minima` / `universal` 等主题；`default2` 支持前台可视化编辑（拖拽排序、弹窗 CRUD）
- **链接拖拽排序**：`default2` 主题登录用户可在前台拖拽链接快速重排
- **链接信息自动识别**：添加 URL 时自动抓取标题 / 描述 / 图标
- **批量检测死链**：后台一键扫描所有链接可用性
- **AI 检索**：将关键词交给 AI，智能匹配 OneNav 中相关链接
- **Chrome / Firefox / Edge 书签批量导入**：内置浏览器书签导入向导
- **二级分类管理**：分类下可嵌套子分类 + 标签
- **私有链接**：可对指定链接设置密码访问
- **链接备用地址**：内网 IP / 外网域名双地址自动切换（`default2` 右键菜单「打开备用链接」）
- **底部工具栏**：访客隐藏，仅管理员登录后可见（添加链接 / 返回顶部 / 订阅管理 / 系统状态 / 后台管理）
- **API + PWA**：完整的 API 接口支持第三方应用接入；支持作为 PWA 应用安装
- **手机版后台**：移动端可登录管理后台
- **后台一键在线升级**：OneNav 后台「设置 → 在线升级」可一键升级到上游最新版本
- **Docker 部署**：官方 Docker 镜像基于 Alpine 3.12 + PHP 7 + Nginx，单文件 SQLite 数据库，零外部数据库

## 目录结构

```
onenav/
├── data.yml                 # 根元数据（跨版本共享）
├── logo.png                 # 应用图标（取自官方站 https://www.onenav.top/images/onenav_150.png）
├── README.md                # 本说明
└── 1.2.4/                   # 当前版本（与上游 GitHub release tag 1.2.4 对齐）
    ├── data.yml             # 版本元数据 + formFields
    ├── docker-compose.yml
    ├── data/                # 持久化占位（.gitkeep）
    │   └── config.php       # ← 首次启动由 init.sh 从镜像复制并填入管理员账号
    └── scripts/
        └── init.sh          # 首次安装初始化（1Panel 调起）
```

## 安装

1. 1Panel → 应用商店 → 本地应用 → 选择 `OneNav`
2. 选择版本 `1.2.4`
3. 主机侧 HTTP 端口默认 `48080`（容器内 `80`）
4. **管理员用户名**（必填）：默认 `admin`
6. **管理员密码**（必填）：默认 `onenav123`（首次登录后请立即修改）
7. **站点标题**：默认 `OneNav`（仅展示，写入 `config.php`）
8. **时区**：默认 `Asia/Shanghai`
9. 提交安装
10. 浏览器访问 `http://<1Panel 主机 IP>:<HTTP 端口>`，用上面设置的管理员账号登录后台

> ⚠️ **首次启动行为**：`scripts/init.sh` 在 1Panel 调起 `docker compose up -d` 之前执行 ——
> - 若主机侧 `./data/config.php` 不存在：从镜像内 `/data/wwwroot/default/config.simple.php` 复制示例配置，并用表单填入的 `ONENAV_USER` / `ONENAV_PASSWORD` 计算 `ENCRYPTED_PASSWORD = md5(USER.PASSWORD)`（与上游 `controller/login.php` 加密方式一致）替换占位符。
> - 若已存在：保留用户历史编辑（不覆盖）。
> - 容器启动后，run.sh 自动把 `/data/wwwroot/default/favicon.ico` 复制到 `./data/favicon.ico`（首次）；php-fpm + nginx 监听容器 80 端口。

## 配置

### 表单字段

| 字段 | 默认值 | 必填 | 说明 |
|------|--------|------|------|
| 镜像 | `helloz/onenav` | 是 | Docker Hub 官方镜像，1Panel 自动按 `linux/amd64` 或 `linux/arm64` 拉取多架构镜像 |
| 版本 | `1.2.4` | 是 | 上游 GitHub release tag（如未来要跟随上游 `1.2.5` release，先确认 Docker Hub 是否真的推了 `1.2.5` tag） |
| HTTP 端口 | `48080` | 是 | 主机侧端口（容器内固定 80） |
| 管理员用户名 | `admin` | 是 | 仅支持字母数字 . - _，长度 2-64 |
| 管理员密码 | `onenav123` | 是 | 复杂度校验，首次登录后请在「后台 → 设置」修改 |
| 站点标题 | `OneNav` | 否 | 仅展示，写入 `config.php` |
| 时区 | `Asia/Shanghai` | 否 | 镜像内默认时区与上游 `install.sh` 一致 |

### 高级配置（手动）

要替换为关键，只能直接编辑主机侧 `./data/config.php`：

```php
<?php
require 'class/Medoo.php';
use Medoo\Medoo;

$db = new medoo([
    'database_type' => 'sqlite',
    'database_file' => 'data/onenav.db3'
]);

// 用户名
define('USER','admin');
// 加密后的密码 = md5(USER.PASSWORD)
define('ENCRYPTED_PASSWORD','<md5-pt-32-char>');
// 邮箱（用于 Gravatar 头像，可选）
define('EMAIL','');
// 主题（0.9.18 已废弃，通过后台设置）
define('TEMPLATE','default');

// 站点信息
$site_setting = [];
$site_setting['title']          = 'OneNav';
$site_setting['logo']           = 'OneNav';
$site_setting['keywords']       = 'OneNav,OneNav导航,OneNav书签,开源导航,开源书签,简洁导航,云链接,个人导航,个人书签';
$site_setting['description']    = 'OneNav是一款使用PHP + SQLite3开发的简约导航/书签管理器，免费开源。';

$site_setting['user']           = USER;
$site_setting['password']       = ENCRYPTED_PASSWORD;
```

### 环境变量（compose 内）

| 变量 | 来源 | 说明 |
|------|------|------|
| `CONTAINER_NAME` | 1Panel 自动 | 容器名 |
| `HOST_IP` | 1Panel 自动 | 主机 IP |
| `PANEL_APP_PORT_HTTP` | 1Panel 表单 | HTTP 主机端口 |
| `USER` | `${ONENAV_USER}` | 管理员用户名（保留上游环境变量名以便组合镜像直接拉取时不破坏） |
| `PASSWORD` | `${ONENAV_PASSWORD}` | 管理员密码（明文） |
| `TZ` | `${TZ}` | 时区 |

> **注意**：上游镜像并未直接读取 `USER` / `PASSWORD` 环境变量写入 config.php ——
> `install.sh` 只负责 git clone 源码，admin 账号密码在 Web 引导页由用户填写。
> 本仓通过 `scripts/init.sh` 在 1Panel 调起 `docker compose up -d` 之前从镜像
> 提取 `config.simple.php` 并用环境变量写入 `config.php`，绕开 Web 引导页。

## 升级

### 跟随上游 release（跨版本升级）

1. 修改 `onenav/<new-version>/docker-compose.yml` 镜像 tag（如 `1.2.4` → `1.2.5`）
2. 在 `onenav/<new-version>/data.yml` 中把 `APP_VERSION` 默认值同步改成 `1.2.5`
3. 提交并推送
4. 由 1Panel 计划任务拉取最新仓库 → 用户在 1Panel UI 选择新版本重新部署

### 容器内源码升级（不重建容器）

OneNav 后台「设置 → 在线升级」可一键升级容器内 `git clone` 下来的 helloxz/onenav 源码，无需重建容器。该机制由上游 OneNav 维护，与本仓版本目录无关。

## 反向代理

如需在 80/443 公网入口后挂 OneNav：

- **Nginx**：`proxy_pass http://127.0.0.1:48080/;`，注意 OneNav 的 `rewrite` 规则（`/click/(.*)` → `index.php?c=click&id=$1` 等）不需要在反代侧实现，容器内 nginx 已处理。
- **Cloudflare Tunnel / FRP**：同样透传即可，OneNav 仅用 HTTP 协议。

## 故障排查

- **首次访问跳转到 `/index.php?c=login` 但提示「配置文件已存在，无需再次初始化」**：正常行为。说明 `init.sh` 已经成功写入 `config.php`（带管理员账号），用表单填入的账号登录即可。
- **登录提示密码错误**：
  1. 检查 1Panel 表单中 `ONENAV_PASSWORD` 是否被 trim（参数含空格/换行会导致 md5 计算错位）
  2. 主机端删除 `./data/config.php` 后重新触发「安装」，让 `init.sh` 重写
  3. 容器内 `/data/wwwroot/default/data/config.php` 中的 `ENCRYPTED_PASSWORD` 应为 `md5(USER.PASSWORD)` 的 32 位小写 hex
- **首页 502 / 白屏**：运行容器端口 80 未起来，等 `start_period: 30s`；查看容器日志 `docker logs <container>`，常见 `php-fpm7` 启动失败
- **死链误判**：OneNav 后台「链接管理 → 批量检测」对部分企业内网链接判定为不可用是正常现象，curl 设置了 `CURLOPT_FAILONERROR` + `CURLOPT_TIMEOUT=10`
- **SQLite 锁等待**：高频并发写入场景下 SQLite 可能锁等待，OneNav 默认用 `Medoo` + `journal_mode=WAL`，单用户 / 家庭场景不构成瓶颈

## 参考

- [上游 OneNav README](https://github.com/helloxz/onenav/blob/main/README.md)
- [上游 docker-onenav README](https://github.com/helloxz/docker-onenav/blob/main/README.md)
- [OneNav 帮助文档](https://www.yuque.com/helloz/onenav)
- [OneNav 官方演示站](http://demo.onenav.top)（`xiaoz` / `xiaoz.me`）