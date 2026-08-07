# FastNet — 1Panel 本地应用

FastNet 是一款网络诊断与测速工具，提供 Web UI + API。由 [linkease（易有云）](https://www.linkease.com) 团队开发。

- GitHub: [linkease/docker_fastnet](https://github.com/linkease/docker_fastnet)
- Docker 镜像: [linkease/fastnet](https://hub.docker.com/r/linkease/fastnet)
- 社区讨论: [KoolCenter 论坛](https://www.koolcenter.com/t/topic/9148)

## 访问

- Web UI: `http://<主机IP>:<端口>`（默认端口 3200）
- 健康检查: `http://<主机IP>:<端口>/api/health`

## 功能特性

- 🩺 **快速体检（Quick）**— 一键检测网络连通性
- 🌐 **NAT 类型测试**— 检测 NAT 类型（FullCone / Restricted / Symmetric）
- 📡 **IPv6 测试**— 含分阶段结果的 IPv6 可达性检测
- ⬇️ **外网测速（多源下载）**— 从多个 CDN 节点并发下载测速
- ⚡ **SpeedTest.net**— 集成 SpeedTest 协议测速
- 🏠 **内网测速（Homebox / LAN）**— 局域网内带宽测试

## 配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TZ` | 时区 | `Asia/Shanghai` |
| `FASTNET_TOKEN` | 访问令牌（可选，公网暴露建议开启） | 空 |

> 容器默认以 `fastnet web --addr 0.0.0.0:3200 --no-open` 启动。

## 安全说明

如果需要在公网暴露 FastNet，**强烈建议设置 `FASTNET_TOKEN`**：

```bash
# 使用 Bearer Token 访问
curl -H "Authorization: Bearer <token>" http://<host>:<port>/

# 或通过 URL 参数
http://<host>:<port>/?token=<token>
```

## 文件

```
fastnet/
├── data.yml           # 根元数据
├── logo.png           # 应用图标
├── README.md          # 本文件
└── latest/
    ├── data.yml       # 版本配置 + formFields
    └── docker-compose.yml
```
