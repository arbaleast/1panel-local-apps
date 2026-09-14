# Ani-RSS 自动追番订阅

基于 RSS 的自动追番工具，按番剧更新自动下载到 qBittorrent。

## 访问
- Web UI: http://192.168.98.246:27789

## 功能
- 按番剧 RSS 自动检测更新
- 自动推送到 qBittorrent 下载
- 自动整理到媒体库目录
- Web UI 手动添加/管理订阅

## 数据
- 配置: ./data/config
- 媒体: ./data/media

## 权限与挂载（重要）

容器进程以 `USER_ID:GROUP_ID`（默认 `1000:1000`）运行。`${CONFIG_PATH}` 挂载到容器内 `${CONFIG}`（默认 `/config`）。

**首次部署或挂载点变更后**，如果宿主机目录 owner 不是 1000，容器会反复崩溃并报：

```
cn.hutool.core.io.IORuntimeException: IOException: Permission denied
  at ani.rss.util.other.ConfigUtil.load(ConfigUtil.java:286)
```

在 1Panel 宿主机终端执行（一次性）：

```bash
# 找到 ani-rss 实际的 config 挂载源
CONFIG_SRC=$(docker inspect 1Panel-localanirss-<后缀> \
  --format '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Source}}{{end}}{{end}}')
sudo chown -R 1000:1000 "$CONFIG_SRC"
docker restart 1Panel-localanirss-<后缀>
```

如果挂载点 owner 必须保留为其他用户（如 NAS 的 99:100），在 1Panel 面板 → 应用参数里把 `USER_ID` / `GROUP_ID` 改成对应值后重新部署。

## 关联
- qBittorrent (anirss 添加任务 → qB 下载)
- MoviePilot (媒体库整理)
