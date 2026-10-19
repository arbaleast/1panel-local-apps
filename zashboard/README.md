# zashboard Clash / sing-box 面板

Clash / sing-box 代理面板，连接 mihomo 或 sing-box 后端 API，提供节点管理、流量统计和速度测试。

## 访问

- Web UI: http://192.168.98.246:8080

## 首次配置

首次打开会引导填入后端地址：
- 后端地址：`http://192.168.98.1:9090`（mihomo 监听地址）
- 密钥：mihomo 配置中的 `secret` 字段

## 用途

- 可视化管理 Clash / sing-box 代理节点
- 查看流量和连接状态
- 速度测试和延迟测试

## 运行用户 UID / GID

安装参数 `UID` / `GID` 通过 compose 的 `user:` 指定容器内进程身份，默认 `99` / `100`。

⚠️ **首次部署前必须把数据目录属主改到同一 UID / GID**，否则容器无权写入、启动即失败：

```bash
# 以应用实际安装目录为准（1Panel → 应用 → zashboard → 详情 → 路径）
sudo chown -R 99:100 <应用安装目录>/data
```

需要 chown 的目录（相对于应用安装目录）：`./data`

- 想以 root 运行：把 `UID` / `GID` 都填 `0`
- 升级到新版本目录后要**重新 chown 一次**（新目录下的 `data` 为空、属主是 root）
- 容器内所有新文件都以该 UID / GID 创建，宿主机上看到属主是 99:100 属正常现象
