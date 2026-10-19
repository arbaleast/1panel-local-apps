# cfnb — Cloudflare CDN 节点优选工具

[![](https://img.shields.io/badge/DockerHub-baizw%2Fcfnb-blue)](https://hub.docker.com/r/baizw/cfnb)
[![](https://img.shields.io/badge/image-baizw%2Fcfnb%3Av1.0.1-blue)](https://hub.docker.com/r/baizw/cfnb/tags)
[![](https://img.shields.io/badge/license-MIT-green)](https://opensource.org/licenses/MIT)

全自动的 Cloudflare CDN 节点优选工具：从多个公开数据源聚合候选节点，依次经过
**TCP 延迟 → IP 可用性 → HTTP 延迟与抖动 → 真实带宽测速** 多重筛选，输出当前网络环境下
速度最快、延迟最低的 Cloudflare 节点列表，并可把结果自动写回 Cloudflare DNS 记录。

镜像 `baizw/cfnb` 是 Go 版实现（单一静态二进制 `cfx`）。同名的 Python 版项目
[xinyitang3/cfnb](https://github.com/xinyitang3/cfnb) 思路一致，但**配置方式完全不同**，见下文
「配置说明」。

## 功能

- 多数据源聚合：内置 3 个公开节点源，自适应解析任意格式（标准代码 / 中文名 / emoji 国旗 / JSON）
- 多重筛选：TCP 延迟 → IP 可用性二次检测 → HTTP 延迟与抖动 → curl 真实带宽测速
- 两种模式：全局最优 TopN / 分国家最优 TopN
- 国家过滤：白名单（限定国家）+ 黑名单（如屏蔽 CN）
- 端口过滤：只保留指定端口（默认 443）
- 定时运行：可配置间隔（默认 1h），启动后立即跑一次
- Cloudflare DNS 自动更新：原子批量替换同名 A / TXT 记录
- 订阅输出：`http://<host>:<port>/ips`（路径可改）与落盘 `ip.txt`

## 架构

| 项 | 值 |
|---|---|
| 镜像 | `baizw/cfnb:v1.0.1` |
| 基础镜像 | `alpine:3.21.7` + 静态 Go 二进制 `/usr/local/bin/cfx` |
| 入口 | `ENTRYPOINT ["cfx"]`，`WORKDIR /app` |
| 多架构 | `linux/amd64`、`linux/arm64` |
| 容器内端口 | `8080`（唯一路由 `${HTTP_PATH}`，默认 `/ips`） |
| 运行身份 | 镜像无 `USER` 指令，用 compose `user:` 指定（默认 99:100） |
| 配置方式 | 仅工作目录下的 `config.yaml`（无 Web UI / 无 CLI 参数 / 不读环境变量） |

## 安装

1. 在 1Panel 应用商店安装 **cfnb**，在「安装参数」里按需调整（下方逐项说明）。
2. 部署完成后，容器会自动跑第一次优选。**首次扫描需要 1～3 分钟**（要拉取节点源、做 TCP 与带宽测速）。
3. 扫描完成后即可取用结果：
   - 订阅地址：`http://<服务器IP>:<HTTP 端口>/ips`（例如 `http://192.168.1.10:8080/ips`）
   - 文件：`<安装目录>/data/ip.txt`
   - 日志：`<安装目录>/data/logs/cfx.info.log`（普通日志）、`cfx.error.log`（错误日志）

> 首次扫描完成前访问 `/ips` 会返回 **404「文件不存在或无法读取」**，这是正常现象，等第一次跑完即可。

## 安装参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| HTTP 端口 | `8080` | 主机端口，映射到容器内 8080 |
| 时区 | `Asia/Shanghai` | 容器内 TZ |
| 运行用户 UID / 组 GID | `99` / `100` | 容器内运行身份 |
| 定时运行 | `true` | `false` = 只在启动时跑一次 |
| 运行间隔 | `1h` | 支持 `30m`、`2h`、`1h30m` 等 Go duration 写法 |
| 优选模式 | `global` | `global` = 全局最优；`country` = 分国家最优 |
| 节点数量 | `50` | 最终保留的节点数（`topn`） |
| 探测次数 | `2` | 每个节点的 TCP 探测次数 |
| 最低成功率 | `0.5` | TCP 探测成功率下限，低于该值的节点被丢弃 |
| 可用性检测 | `true` | 对候选节点再做一次 IP 可用性检测（更准但更慢） |
| 测速大小 | `50` | 单次带宽测速的下载量（MB），越大越准也越费流量 |
| 端口过滤 | `443` | 逗号分隔，如 `443,8443` |
| 屏蔽国家 | `CN` | 逗号分隔的 ISO 国家码，如 `CN,JP`；留空 = 不屏蔽 |
| 限定国家 | 空 | 逗号分隔；**留空 = 不启用白名单**；填 `US` 表示只保留美国节点 |
| DNS 自动更新 | `false` | 开启后把优选结果写回 Cloudflare DNS |
| API Token | 空 | Cloudflare API Token（需要 Zone.DNS 编辑权限） |
| Zone ID | 空 | 目标域名的 Zone ID |
| 记录名称 | 空 | 要更新的记录名，如 `cdn.example.com` |
| TTL | `60` | DNS 记录的 TTL |
| 开启代理 | `false` | 是否把记录设为「已代理」（橙色云） |
| 订阅路径 | `/ips` | HTTP 订阅路径 |

### Cloudflare DNS 自动更新

1. Cloudflare 控制台 → My Profile → API Tokens → Create Token → **Edit zone DNS** 模板，
   限定到目标 Zone，拿到 Token。
2. 目标域名 → Overview → API 找到 **Zone ID**。
3. 填入上表对应参数，把「DNS 自动更新」设为 `true`。
4. 记录名称填主机名（`cdn.example.com`），应用会**原子批量**替换该主机名下的 A / TXT 记录。

开启后每轮优选结束都会执行一次更新；失败会重试 3 次并写进 `cfx.error.log`。

## 配置说明（重要）

该应用**没有 Web UI，也不支持命令行参数与环境变量**，唯一配置入口是容器工作目录
（`/app`）下的 `config.yaml`，由本仓库的 `scripts/init.sh` 在宿主机上按安装参数生成。

更坑的是：镜像里的二进制用 **viper + mapstructure** 解码配置，键名按 **Go 结构体字段名
（小写、无下划线）** 匹配，而不是它自己生成的那份默认 `config.yaml` 里的 snake_case 键名。
也就是说上游默认配置里的 `top_n` / `api_token` / `zone_id` / `dns_record_name` 这些键
**读不进来**（会被静默忽略），真正生效的是：

| 作用 | 生效的键 | 上游默认写法（无效） |
|---|---|---|
| 全局/分国家模式 | `global.enable` | `global.enable`（一致） |
| 保留节点数 | `global.topn` | `global.top_n` |
| 带宽测速候选数 | `global.bandwidthcandidates` | `global.bandwidth_candidates` |
| 结果输出文件 | `global.outputfile` | `global.output_file` |
| 端口过滤 | `filter.ports` | `filter.ports`（一致） |
| 白名单 / 黑名单国家 | `filter.allowedcountries` / `filter.blockedcountries` | `filter.allowed_countries` / `filter.blocked_countries` |
| 国家白名单开关 | `filter.countriesenabled` | `filter.countries_enabled` |
| TCP 探测次数 | `tcp.probes` | `tcp.probes`（一致） |
| 最低成功率 | `tcp.minsuccessrate` | `tcp.min_success_rate` |
| 可用性检测开关 | `availability.enabled` | `availability.enabled`（一致） |
| IPv6 过滤 | `availability.ipv6availability` | `availability.ipv6_availability` |
| 测速文件大小 | `bandwidth.sizemb` | `bandwidth.size_mb` |
| DNS 更新开关 | `dns.enabled` | `dns.enabled`（一致） |
| Cloudflare 开关 | `cloudflare.enabled` | `cloudflare.enabled`（一致） |
| API Token / Zone ID / 记录名 | `cloudflare.apitoken` / `cloudflare.zoneid` / `cloudflare.dnsrecordname` | `cloudflare.api_token` / `zone_id` / `dns_record_name` |
| TTL / 代理 | `cloudflare.ttl` / `cloudflare.proxied` | 一致 |
| HTTP 端口 / 路径 | `http.port` / `http.path` | 一致 |
| 日志目录 | `logger.logdir` | `logger.log_dir` |
| 定时开关 / 间隔 | `schedule.enabled` / `schedule.interval` | 一致 |

想加自定义节点源，直接改 `<安装目录>/data/config.yaml` 的 `additionalsources`（形如
`- url: https://example.com/all.txt` + `enabled: true`），改完重启容器生效。
注意：**在 1Panel 里重新部署会覆盖这个文件**（init.sh 每次都会重新生成），
需要长期保留的自定义内容请在重新部署后补回。

## 运行身份

镜像没有 `USER` 指令，compose 用 `user: "${UID}:${GID}"` 指定运行身份（默认 99:100）。
`scripts/init.sh` 会把 `<安装目录>/data` 的属主改成同一个 UID/GID，所以正常安装后不需要手动处理。
如果手动改过 UID/GID，请确认目录属主：

```bash
chown -R 99:100 /opt/1panel/apps/local/cfnb/cfnb/data
```

## 常见问题

**`/ips` 返回 404「文件不存在或无法读取」**
首次扫描还没跑完。等 `data/logs/cfx.info.log` 出现「结果已保存到 ./ip.txt」即可。

**日志里报 `FATAL 前置端口过滤后无任何节点` / `过滤后无任何节点`**
端口过滤或国家白名单把所有节点都筛掉了。检查「端口过滤」「屏蔽国家」「限定国家」三项。

**DNS 更新报 `code: 7003 Could not route to /client/v4/zones/...`**
Zone ID 填错，或 API Token 没有该 Zone 的 DNS 编辑权限。

**带宽测速很费流量**
把「测速大小」调小（例如 10），或把「节点数量」调小。

**想看更细的日志**
日志固定写在 `<安装目录>/data/logs/`（`cfx.info.log` / `cfx.error.log`），
可用 `docker logs -f <容器名>` 看实时输出。

## 许可与致谢

- 镜像：Docker Hub [`baizw/cfnb`](https://hub.docker.com/r/baizw/cfnb)
- 同名项目与思路来源：[xinyitang3/cfnb](https://github.com/xinyitang3/cfnb)（MIT）
- 节点数据源与检测 API：[cmliussss](https://github.com/cmliussss)
- IP 风险检测 API：[ipapi.is](https://ipapi.is/)
