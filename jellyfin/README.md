# Jellyfin 媒体服务器

免费软件媒体系统，流式播放个人媒体库。

## 访问
- Web: https://jellyfin.arbaleast.top

## 数据
- 媒体库: /mnt/user/media/movies /mnt/user/media/tv /mnt/user/media/music
- 应用数据: /mnt/user/appdata/jellyfin/
- 字体目录: ~/.local/share/fonts/ (以只读方式挂载到容器的 /usr/share/fonts/fonts)

## 镜像
- nyanmisaka/jellyfin (中文硬解支持)

## 版本说明
本应用提供以下版本目录，1Panel UI 在「应用 → 详情 → 版本」下拉中选择：

| 目录 | 默认镜像 | 架构 | 备注 |
| --- | --- | --- | --- |
| `10.11.11/` | `jellyfin/jellyfin:10.11.11` | amd64 / arm64 (multi-arch) | 当前推荐；Jellyfin 10.11.x 稳定版 |
| `2026081705-arm64/` | `jellyfin/jellyfin:2026081705-arm64` | arm64 | 历史版本 |
| `2026090709-arm64/` | `jellyfin/jellyfin:2026090709-arm64` | arm64 | 历史版本；启动检查 `/cache` ≥ 2 GiB |

`10.11.11/` 目录使用 `${IMAGE}` 变量，1Panel UI 中可在「参数」中改写为 `nyanmisaka/jellyfin:<tag>-amd64` 等其他镜像。

## 从 2026090709-arm64 切到 10.11.11
原 `2026090709-arm64` 在 `/dev/shm` 满载时启动失败（`Unhandled exception: The path '/cache' has insufficient free space. Available: 0B, Required: 2GiB`），切换步骤：

1. 1Panel → 应用 → Jellyfin → 卸载（**先备份** `/data/dsh/home/日常/1panel-local-apps/jellyfin/2026090709-arm64/data/config/`）
2. 1Panel → 应用商店 → Jellyfin → 安装 → 版本选 `jellyfin 10.11.11`
3. 安装参数中的「Cache folder path」保持默认 `/data/dsh/home/日常/1panel-local-apps/jellyfin-cache`（目录已建好，177 GiB 可用）
4. 启动后用备份的 config 覆盖 `/data/dsh/home/日常/1panel-local-apps/jellyfin/10.11.11/data/config/`
5. 触发「扫描媒体库」让 Jellyfin 重新识别 `/media/movies/` 下整理好的条目

## Cache 路径说明
1Panel UI 默认 cache 挂载为 `/dev/shm`，但宿主机 `/dev/shm` 是 tmpfs（默认 7.8 GiB），其他容器吃满后 Jellyfin 启动会因 ≥ 2 GiB 空间检查失败。`10.11.11/` 目录的 default 改为 `/data/dsh/home/日常/1panel-local-apps/jellyfin-cache`（宿主磁盘，171 GiB 可用），新装直接生效；旧版本目录的 default 仍是 `/dev/shm`，需手动在「参数」中改写。
