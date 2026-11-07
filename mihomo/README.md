# Mihomo — 1Panel 本地应用

基于 [daitcl/mihomo](https://github.com/daitcl/mihomo) 镜像（版本目录 `v1.19.33` 对应镜像 tag `v1.19.33`）：
- Mihomo (Clash Meta) 内核 + 预打包 GeoIP / GeoSite
- 内置 [MetacubexD](https://github.com/MetaCubeX/metacubexd) Dashboard，由镜像内 Caddy 托管
- 首次启动按订阅链接生成 `config.yaml`（订阅模式）
- TUN 透明代理默认开启（镜像配置模板）
- **仅 amd64**（该镜像上游只发布 amd64 架构）

历史版本 `v1.19.18`（gangz1o/glash 镜像，含 arm64）保留为归档，不再维护。

## 端口

| 容器端口 | 用途 |
|------|------|
| 7890 | 混合代理（HTTP + SOCKS） |
| 7891 | SOCKS5 代理 |
| 7892 | HTTP 代理 |
| 9090 | REST API（external-controller） |
| 8080 | MetacubexD Dashboard（Caddy 托管） |

> 注意与旧版 v1.19.18 的端口语义不同：旧版 7890 是 HTTP、7892 是混合；本版按上游模板 7890 是混合、7892 是 HTTP。

## 安装参数

| 参数 | 说明 |
|------|------|
| 混合代理端口 / SOCKS 端口 / HTTP 端口 | 宿主机侧端口映射，默认 7890 / 7891 / 7892 |
| Controller 端口 | REST API（9090） |
| Dashboard 端口 | MetacubexD 页面（8080） |
| 配置文件夹路径 | 默认 `./data`，持久化目录 |
| 时区 | 默认 `Asia/Shanghai` |
| 订阅链接 | Clash / clash.meta 格式订阅 URL；留空则需自备 `config.yaml`（见下） |
| 订阅名称 | 代理提供程序名，默认 `default`，仅允许字母数字 |
| Dashboard 密钥 | REST API / Dashboard 登录密钥，留空表示不启用鉴权 |
| 日志级别 | `info` / `silent`，默认 `info` |

## 首次启动行为（重要）

容器入口脚本只在 **`./data/config.yaml` 不存在时**，才根据安装参数生成一份配置并启动：
生成后环境变量即不再参与运行。因此：

- **改订阅链接 / 密钥 / 日志级别后，必须删除 `./data/config.yaml` 再重启**（或直接编辑该文件后重启），否则参数改动不生效。
- 订阅的定时刷新由 Mihomo 自身的 `proxy-providers` 间隔控制（默认 86400 秒 = 每天一次，可在 `config.yaml` 里改 `interval`）；镜像内没有额外的订阅 cron。
- 既没有订阅链接、`./data` 里也没有 `config.yaml` 时，生成的配置里 provider URL 为空，Mihomo 会启动失败并反复重启。二选一：填订阅链接；或启动前先放好自己的 `config.yaml`。

## 订阅模式（推荐）

1. 1Panel 应用商店 → 本地 → 找到 **Mihomo** → 安装
2. 安装表单填 **订阅链接**（Clash / clash.meta 格式），建议同时填 **Dashboard 密钥**
3. 启动后打开 `http://<host>:8080`（Dashboard），后端地址填 `http://<host>:9090`，密钥填你设的 **Dashboard 密钥**

订阅模式下的节点由 `proxy-providers` 管理，本地修改 `proxies` 会被覆盖；想手改节点直接编辑 `./data/config.yaml`。

## 本地配置模式

不填订阅链接时，先在 `./data/config.yaml` 放好自己的配置再启动，入口脚本会直接使用它：

```bash
cat > /opt/1panel/apps/local/mihomo/mihomo/v1.19.33/data/config.yaml << 'EOF'
mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
external-controller: 0.0.0.0:9090
secret: "your-password"
proxies: []
proxy-groups:
  - name: PROXY
    type: select
    proxies: []
rules:
  - GEOIP,private,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
EOF
```

## TUN 模式（默认开启）

镜像配置模板默认 `tun.enable: true`，compose 已带 `NET_ADMIN` capability 与 `/dev/net/tun` 设备。
宿主机必须能提供 `/dev/net/tun`（大多数 Linux 默认有）。不想用 TUN：编辑 `./data/config.yaml`
把 `tun.enable` 改为 `false` 后重启。

## 数据持久化

`./data`（应用安装目录下）→ 容器内 `/root/.config/mihomo`：`config.yaml`、cache、UA/规则缓存等都在这里。
镜像以 root 运行（无 `user:` 映射），**不需要** chown 数据目录，也没有 UID / GID 安装参数。

## 从 v1.19.18 升级

- `data/` 目录随应用保留，旧 `config.yaml` 会原样继续使用 → 新版安装参数（订阅链接等）不会生效，需要换订阅就删掉旧 `config.yaml` 再重启。
- 端口语义变化见上表：如果外部脚本 / 反代按旧语义引用 7890（HTTP），要改成混合（7890）或 HTTP（7892）。
- 新版不再有 UID / GID 参数（镜像以 root 运行），旧目录里 chown 过的属主不影响运行。
- `v1.19.18` 用的 gangz1o/glash 镜像与新版 daitcl/mihomo 是不同的上游仓库，回滚 = 在 1Panel 里切回版本 `v1.19.18`。

## 镜像拉取

```bash
docker pull ghcr.io/daitcl/mihomo:v1.19.33
```

加速器不包含 ghcr/daitcl 时，用项目 README 里的任一 ghcr 加速器手动拉取并 retag。

## 常见问题

**Q：Dashboard 打不开 / Mixed Content 报错？**
Dashboard 是 8080 端口的 HTTP 页面；要 HTTPS 访问就对 8080 整体反代，或直接用 `http://<host>:8080`。
Dashboard 连接后端时填 `http://<host>:9090` + 密钥。

**Q：改了安装参数没生效？**
见「首次启动行为」：删除 `./data/config.yaml` 后重启应用（注意先备份自定义改动）。

**Q：订阅下载失败？**
`docker logs <container>` 看入口脚本与 Mihomo 日志；确认订阅 URL 可从容器内访问（`proxy-providers` 由 Mihomo 内核自己拉取）。

## 文件

```
mihomo/
├── data.yml           # 根元数据
├── logo.png
├── README.md          # 本文件
├── README_en.md
├── v1.19.33/          # 当前版本（daitcl/mihomo）
│   ├── data.yml       # 安装表单（11 个字段）
│   ├── docker-compose.yml
│   └── data/          # 持久化目录
└── v1.19.18/          # 历史归档（gangz1o/glash，含 arm64）
```
