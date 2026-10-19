# MoviePilot 影视自动整理

对接 qBittorrent/Emby/Jellyfin，PT 订阅、搜刮、整理、推送全自动。

## 访问
- Web: https://moviepilot.arbaleast.top

## API
- 手动整理: POST /api/v1/transfer/manual?background=true
- 凭证: API_TOKEN 见 .env

## 关联
- qBittorrent (下载完成后自动整理)
- Jellyfin (媒体库更新)
- PT 站 (RSS 订阅)

## 运行用户 UID / GID

安装参数 `PUID` / `PGID` 指定容器内进程的用户 / 组身份，默认 `99` / `100`。

镜像的启动脚本会以 root 身份先 `chown` 自己的数据目录、再降权运行，
**不需要手工 chown 宿主机目录**。

- 改这两个值 → 容器内新建文件的属主随之改变（镜像会自动把数据目录 chown 到该 UID/GID）
- 想以 root 运行：把 `PUID` / `PGID` 都填 `0`
- 宿主机挂载的外部目录（媒体库等）不在镜像的 chown 范围内，需保证该 UID/GID 可读
