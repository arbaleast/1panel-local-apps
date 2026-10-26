# Jellyfin 媒体服务器

免费软件媒体系统，流式播放个人媒体库。

## 访问
- Web: https://jellyfin.arbaleast.top

## 数据
- 媒体库: /mnt/user/media/movies /mnt/user/media/tv /mnt/user/media/music
- 应用数据: /mnt/user/appdata/jellyfin/
- 字体目录: /usr/share/fonts (宿主机系统字体，只读挂载到容器 /usr/share/fonts)

## 镜像
- nyanmisaka/jellyfin (中文硬解支持)

## 版本说明
本应用提供以下版本目录，1Panel UI 在「应用 → 详情 → 版本」下拉中选择：

| 目录 | 默认镜像 | 架构 | 备注 |
| --- | --- | --- | --- |
| `10.11.11/` | `jellyfin/jellyfin:10.11.11` | amd64 / arm64 (multi-arch) | 当前推荐；Jellyfin 10.11.x 稳定版 |
| `2026081705-arm64/` | `jellyfin/jellyfin:2026081705-arm64` | arm64 | 历史版本 |
| `2026090709-arm64/` | `jellyfin/jellyfin:2026090709-arm64` | arm64 | 历史版本；启动检查 `/cache` ≥ 2 GiB |
| `2026091410-arm64/` | `jellyfin/jellyfin:2026091410-arm64` | arm64 | 历史版本 |

`10.11.11/` 目录使用 `${IMAGE}` 变量，1Panel UI 中可在「参数」中改写为 `nyanmisaka/jellyfin:<tag>-amd64` 等其他镜像。

## 运行用户 UID / GID

安装参数中的「运行用户 UID / 运行组 GID」默认 **99 / 100**，写入 compose 的 `user: "${UID}:${GID}"`（上游官方文档推荐的写法，官方镜像 `ENTRYPOINT ["/jellyfin/jellyfin"]` 无降权逻辑，只能靠 compose 的 `user:` 指定身份）。

镜像默认以 root 运行；指定 UID/GID 后，容器内所有文件都以该身份创建，**宿主机挂载目录必须对同一属主可写**，否则 Jellyfin 启动即失败（典型报错：`Unable to write to config directory` / `Permission denied`）。

部署前先准备宿主机目录属主：

```bash
# 以应用实际安装目录为准（1Panel → 应用 → Jellyfin → 详情 → 路径）
APP_DIR=/data/dsh/home/日常/1panel-local-apps/jellyfin/10.11.11
sudo chown -R 99:100 "$APP_DIR/data/config"        # 配置库（必需）
sudo chown -R 99:100 /data/dsh/home/日常/1panel-local-apps/jellyfin-cache   # cache 目录
# 媒体库只需可读；若要在媒体目录写入元数据/字幕，同样 chown 99:100
```

要点：

- 媒体库只需**可读**即可正常播放；UID/GID 主要影响 `/config`（数据库）与 `/cache`（转码缓存）的写入。
- 升级或换版本后新目录的 `data/config` 属主会重置为 root，需要重新 `chown -R 99:100`。
- 想要回退到 root 运行：把参数改成 UID=0、GID=0（等价于不写 `user:`），此时目录属主无关。
- 存量部署（已以 root 跑过）直接改 UID/GID 前，先 `chown -R 99:100` 再重启，否则容器起不来。

## 字体（字幕中文显示为方块）

Jellyfin 有两套互不相通的字体机制（官方文档 <https://jellyfin.org/docs/general/administration/configuration/#fonts>）：

- **服务端系统字体（Server Side System Fonts）**：容器内 `/usr/share/fonts` 下能被 fontconfig 识别的字体，用于**烧录（burn-in）字幕**和封面图渲染。宿主机缺中文字体时，烧录进画面的字幕中文会变成方块（tofu）。
- **回退字体（Fallback Fonts）**：Web 端渲染 ASS 字幕时由服务端 `/FallbackFont` 接口下发给浏览器的字体，需要在 Jellyfin 控制台单独开启并指定目录。

本应用默认把宿主机 `/usr/share/fonts` **只读**挂载到容器 `/usr/share/fonts`（等价于 `-v /usr/share/fonts:/usr/share/fonts:ro`），安装后容器直接复用宿主机已装字体，解决烧录字幕的中文方块问题。对应安装参数「宿主机字体目录 / Host fonts directory」（`FONTS_FOLDER_PATH`）。

### 宿主机准备中文字体

宿主机没有中文字体时先装字体包，再**重新部署**（bind mount 只在容器启动时生效）：

```bash
# Debian / Ubuntu
sudo apt install -y fonts-noto-cjk        # 思源黑体，简繁日韩全覆盖
# 或更小的文泉驿：sudo apt install -y fonts-wqy-zenhei
# RHEL / CentOS / Rocky
sudo dnf install -y google-noto-sans-cjk-ttc-fonts
# Alpine
sudo apk add font-noto-cjk
```

验证宿主机与容器内都能看到中文字体：

```bash
fc-list :lang=zh | head                            # 宿主机
docker exec -it <容器名> fc-list :lang=zh | head    # 容器内
```

### 装好字体后仍有方块？

- **Web 端 ASS 字幕**走「回退字体」链路，与系统字体无关：控制台 → 播放（Playback）→ 转码（Transcoding）设置页，勾选「启用回退字体」并把「回退字体路径」指向**直接包含字体文件**的目录（服务端只读取该目录第一层、不递归子目录），例如 `/usr/share/fonts/truetype/wqy`。官方限制回退字体总大小 20 MB（会全部预加载进浏览器），建议放 `woff2`。
- **烧录字幕**走 ffmpeg + libass + fontconfig，会递归扫描 `/usr/share/fonts` 下所有子目录，宿主机字体包装在哪一层都能识别。

### 自定义字体目录 / 存量安装注意

- 参数「宿主机字体目录」可改成任意含字体文件的宿主机**绝对路径**（如 `/mnt/user/fonts`），同样挂载到容器的 `/usr/share/fonts`。
- **存量安装**：旧版默认值是 `~/.local/share/fonts/`（不是绝对路径、通常是空目录，等于没挂任何字体）。升级/重新部署后请在应用「参数」里改成 `/usr/share/fonts`（或实际字体目录）再重新部署——否则挂载的是空目录，反而会遮蔽镜像自带字体。
- 若宿主机确实没有 `/usr/share/fonts` 目录，Docker 会自动创建空目录并覆盖镜像字体：这种情况请先装字体包，或把参数指向其它含字体的目录。

## 从 2026090709-arm64 切到 10.11.11
原 `2026090709-arm64` 在 `/dev/shm` 满载时启动失败（`Unhandled exception: The path '/cache' has insufficient free space. Available: 0B, Required: 2GiB`），切换步骤：

1. 1Panel → 应用 → Jellyfin → 卸载（**先备份** `/data/dsh/home/日常/1panel-local-apps/jellyfin/2026090709-arm64/data/config/`）
2. 1Panel → 应用商店 → Jellyfin → 安装 → 版本选 `jellyfin 10.11.11`
3. 安装参数中的「Cache folder path」保持默认 `/data/dsh/home/日常/1panel-local-apps/jellyfin-cache`（目录已建好，177 GiB 可用）
4. 启动后用备份的 config 覆盖 `/data/dsh/home/日常/1panel-local-apps/jellyfin/10.11.11/data/config/`
5. `chown -R 99:100` 上述 config 目录（UID/GID 默认为 99/100，容器以该身份运行）
6. 触发「扫描媒体库」让 Jellyfin 重新识别 `/media/movies/` 下整理好的条目

## Cache 路径说明
1Panel UI 默认 cache 挂载为 `/dev/shm`，但宿主机 `/dev/shm` 是 tmpfs（默认 7.8 GiB），其他容器吃满后 Jellyfin 启动会因 ≥ 2 GiB 空间检查失败。`10.11.11/` 目录的 default 改为 `/data/dsh/home/日常/1panel-local-apps/jellyfin-cache`（宿主磁盘，171 GiB 可用），新装直接生效；旧版本目录的 default 仍是 `/dev/shm`，需手动在「参数」中改写。
