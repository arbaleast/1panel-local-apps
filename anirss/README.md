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

## 关联
- qBittorrent (anirss 添加任务 → qB 下载)
- MoviePilot (媒体库整理)

## 运行用户 UID / GID

安装参数 `PUID` / `PGID` 指定容器内进程的用户 / 组身份，默认 `99` / `100`。

镜像的启动脚本会以 root 身份先 `chown` 自己的数据目录、再降权运行，
**不需要手工 chown 宿主机目录**。

- 改这两个值 → 容器内新建文件的属主随之改变（镜像会自动把数据目录 chown 到该 UID/GID）
- 想以 root 运行：把 `PUID` / `PGID` 都填 `0`
- 宿主机挂载的外部目录（媒体库等）不在镜像的 chown 范围内，需保证该 UID/GID 可读
