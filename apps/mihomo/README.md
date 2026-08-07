# Mihomo (glash) — 1Panel 本地应用

基于 [gangz1o/clash4docker](https://github.com/gangz1o/clash4docker) `gangz1o/glash` 镜像：
- 最新 Mihomo (Clash Meta) 内核
- 内置 [MetacubexD](https://github.com/MetaCubeX/metacubexd) Dashboard（无需单独部署）
- 预打包 GeoIP / GeoSite / Country.mmdb
- **订阅自动下载 + 定时更新**（核心卖点）
- 可选 TUN 模式（透明代理）

## 端口

| 端口 | 用途 |
|------|------|
| 7890 | HTTP 代理 |
| 7891 | SOCKS5 代理 |
| 7892 | 混合代理（HTTP + SOCKS） |
| 9090 | REST API + Dashboard |

## 快速开始（订阅模式 — 推荐）

1. 1Panel 应用商店 → 本地 → 找到 **Mihomo (glash)** → 安装
2. 安装表单：
   - **Subscription URL**：填你的机场订阅链接（Clash / clash.meta 格式）
   - **Dashboard Secret**：填一个强密码（访问 Dashboard 时用）
   - **Subscription Cron**：默认 `0 */6 * * *`（每 6 小时自动更新订阅）
   - 其他默认即可
3. 启动后访问 `http://<host>:9090/ui/`，后端填 `http://<host>:9090`，密钥填你设的 SECRET

## 订阅模式工作逻辑

容器启动时 `start.sh` 会：

1. 如果 `DATA_PATH`（默认 `./data`）已有 `config.yaml` → 用本地配置启动
2. 否则用 `SUB_URL` 下载订阅配置
3. 把 `SECRET`、`ALLOW_LAN`、`AUTHENTICATION` 自动写入配置
4. 如果设了 `SUB_CRON`，按 cron 定时重新下载并热重启

> **重要**：使用订阅时，**配置目录必须可写**（不能挂 `:ro` 单文件）。

## 本地配置模式

如果不填 `SUB_URL`，需要自己提供 `config.yaml`：

```bash
# 在 1Panel 实例目录下创建 config.yaml
cat > /opt/1panel/apps/local/mihomo/mihomo/data/config.yaml << 'EOF'
mixed-port: 7892
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

## TUN 模式（透明代理）

TUN 模式让容器内**所有流量**走代理，无需客户端配置。

- 镜像本身已支持 `NET_ADMIN` + `/dev/net/tun` 设备（compose 已包含）
- 1Panel UI 表单里把 **Enable TUN** 改为"启用"并重启
- 验证：`docker exec <container> cat /proc/sys/net/ipv4/ip_forward`

## 镜像拉取

默认 `gangz1o/glash:latest`（Mihomo v1.19.x + MetacubexD v1.26x）。如果 .246 加速器不包含 gangz1o：

```bash
# 用项目 README 里的任一加速器手动拉
docker pull docker.1ms.run/gangz1o/glash:latest
docker tag docker.1ms.run/gangz1o/glash:latest gangz1o/glash:latest
```

## 常见问题

**Q：Dashboard Mixed Content 错误？**
用 HTTPS 反代整个 9090 端口，或直接用 `http://<host>:9090/ui/`。

**Q：订阅下载失败？**
```bash
docker logs <container>                 # 看 start.sh 日志
docker exec <container> cat /var/log/subscription.log   # 订阅专项日志
```

**Q：怎么加节点？**
订阅模式下节点来自订阅链接，本地 `config.yaml` 会被覆盖。改订阅或关闭订阅。

## 文件

```
mihomo/
├── data.yml           # 根元数据 + 全 formFields
├── logo.png           # clash.png 图标
├── README.md          # 本文件
├── README_en.md
└── latest/
    ├── data.yml       # 安装表单（16 个字段）
    └── docker-compose.yml
```
