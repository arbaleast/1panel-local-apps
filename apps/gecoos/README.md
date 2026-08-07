# Gecoos 集客 AC

> 无线接入点（AP）集中管理系统

## 简介

Gecoos AC（Access Controller）是开源的无线网络控制器，基于 OpenWrt Gecoos AC 项目构建。专为中小企业设计的无线网络解决方案，支持对 Gecoos/AP 设备的集中管理与控制。

## 主要功能

- **AP 发现与管理**：自动发现网络中的 AP 设备并集中管理
- **配置管理**：批量配置 AP 参数（SSID、信道、功率等）
- **固件升级**：支持 AP 固件批量升级与回滚
- **状态监控**：实时监控 AP 在线状态与流量统计
- **中文界面**：支持中文/英文 Web 管理界面

## 默认信息

| 项目 | 默认值 |
|------|--------|
| Web 管理端口 | `8080` |
| 控制端口 | `60650`（UDP） |
| 默认账号 | `admin` |
| 默认密码 | `admin` |
| 数据目录 | `./data` |

## 目录结构

```
gecoos/
├── data.yml              # 根元数据
├── logo.png              # 应用图标
├── README.md             # 本说明文档
└── v2.2/                 # 版本目录
    ├── data.yml          # 版本配置（formFields）
    ├── docker-compose.yml
    └── data/             # 持久化数据目录
        └── .gitkeep
```

## 部署说明

### 前置要求

- 宿主机需有独立的网络接口（用于 AP 发现）
- 容器使用 **host 网络模式**（必需）
- 容器需要 **privileged 权限**（必需）

### 部署步骤

1. 在 1Panel 应用商店搜索"gecoos"并安装
2. 配置 Web 管理端口（默认 8080）
3. 选择界面语言（默认中文）
4. 启动容器后访问 `http://<宿主机IP>:8080`

### 关键参数说明

| 参数 | 说明 |
|------|------|
| `PANEL_APP_PORT_WEB` | Web 管理界面端口 |
| `LANG` | 界面语言：`zh` 或 `en` |
| `IS_ONLY_ONE_PROT` | 是否单一协议模式 |
| `SHOW_TIP` | 是否显示界面提示 |
| `HTTPS_ENABLED` | 是否启用 HTTPS |

## 注意事项

### 网络模式

⚠️ **必须使用 host 网络模式**：AC 控制器需要通过 UDP 60650 端口广播发现网络中的 AP，bridge 网络模式下容器无法直接发送广播包。

⚠️ **必须使用 privileged 模式**：AC 控制器需要创建虚拟网络接口（VLAN/TAP），需要 `CAP_SYS_ADMIN` 权限。

### 安全建议

⚠️ **首次部署后请立即修改默认密码**：默认账号密码为 `admin`/`admin`，存在安全风险。

### 端口占用

部署前请确认以下端口未被占用：

- `8080`（Web 管理界面）
- `60650/udp`（AP 发现/控制端口）

## 升级与回滚

### 升级

在 1Panel 中删除旧版本容器（保留 `./data` 目录），重新部署新版本即可。配置与数据存储在 `./data` 目录中，不会丢失。

### 回滚

如需回滚到旧版本：

1. 停止当前容器
2. 修改版本目录中的 `docker-compose.yml` 的镜像 tag
3. 重新启动容器

## 参考链接

- Gecoos AC 项目：https://github.com/zfgeng/openwrt-gecoosac
- 路由器之家（cnrouter）：https://www.cnrouter.com/
- 1Panel 应用商店：https://1panel.cn/

---

*本应用由 1Panel 本地应用仓库维护*
