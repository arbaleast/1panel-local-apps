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
