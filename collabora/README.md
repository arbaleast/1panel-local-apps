# Collabora Online (CODE) — 自托管协作在线 Office 套件

基于 LibreOffice 技术的开源在线 Office 套件，可在浏览器中**实时协同编辑** Word / Excel / PowerPoint / ODF 文档，文档全部留在自己的服务器上。

镜像：[`collabora/code`](https://hub.docker.com/r/collabora/code)（官方 CODE / Collabora Online Development Edition）

## 它是什么，不是什么

- ✅ **是**：一个 WOPI 服务端（文档编辑后端）。浏览器里的编辑器界面由它提供，文件内容由 WOPI 主机（WOPI Host）提供。
- ⚠️ **不是**自带网盘的独立办公套件。要真正「打开一个文件并保存回去」，需要一个 WOPI 主机 —— 最常见的是 **Nextcloud / ownCloud**（安装 `Collabora Online` / `Nextcloud Office` 应用后填入本服务地址即可）。
- 💡 想先试用：部署完成后直接访问 `http://<服务器 IP>:<端口>/browser/dist/cool.html`，可以在内置界面里新建并编辑文档，再手动下载；文件不会自动持久化到服务器。

## 访问

| 用途 | 地址 |
|------|------|
| 服务根路径 | `http://<服务器 IP>:<端口>/` |
| 管理控制台 | `http://<服务器 IP>:<端口>/browser/dist/admin/admin.html` |
| WOPI 服务发现 | `http://<服务器 IP>:<端口>/hosting/discovery`（返回 XML） |
| WOPI 能力声明 | `http://<服务器 IP>:<端口>/hosting/capabilities`（返回 JSON） |

- 默认端口 **9980**（容器内固定），可在安装参数里改主机侧端口。
- 默认走**明文 HTTP**（见下方「HTTP / HTTPS」）。若要在容器内启用自签 HTTPS，把「附加参数」清空后用 `https://` 访问，浏览器会提示自签证书不受信任。

> ⏳ **首次启动较慢**：镜像要在容器内初始化 LibreOffice Online 运行时，通常需要 1～5 分钟才能真正开始处理文档，期间容器日志会持续输出初始化信息。健康检查在镜像内已定义（`coolwsd --probe`），初始化完成前容器会一直显示 `starting`。

## 安装参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| HTTP 端口 | `9980` | 主机端口，映射到容器内 9980 |
| 管理控制台账号 | `admin` | 上游环境变量 `username` |
| 管理控制台密码 | `dockercollabora` | 上游环境变量 `password`，**请务必改成自己的强密码** |
| WOPI 允许域名 | `https://cloud.example.com:443` | 上游环境变量 `aliasgroup1`，**改成你的 Nextcloud 域名**（见下） |
| 服务名称 | `localhost` | 上游环境变量 `server_name` |
| 拼写检查词典 | `en_US` | 上游环境变量 `dictionaries`，空格分隔多个 |
| 附加参数 | `--o:ssl.enable=false` | 上游环境变量 `extra_params`，透传给 coolwsd |
| 时区 | `Asia/Shanghai` | 容器时区 |

### WOPI 允许域名（aliasgroup1）

这是最关键的安全项：它决定**哪些网盘可以调用本服务编辑文档**，填错会导致集成后打不开文档。

- 格式照上游示例写全：`https://<域名>:<端口>`，例如 `https://cloud.example.com:443`。
- 域名部分是**正则**，`.` 建议转义成 `\.`，例如 `https://cloud\.example\.com:443`。
- 匹配时只比对**主机名 + 端口**（协议不参与匹配），但协议和端口仍建议写全，避免与上游示例不一致。
- 一个网盘填一个 `aliasgroup`，多个网盘要用 `aliasgroup2` / `aliasgroup3` 追加（`aliasgroup1` 已被本应用占用，额外网盘请在 compose 中自行追加环境变量）。
- 生产环境**不要**用 `https://.*:443` 这种全放行规则。

### 拼写检查词典

上游把 `dictionaries` 写进 coolwsd 的 `allowed_languages` 配置项，所以**填的是 locale 码（不是 2 字母语言码）**，多个用空格分隔。

镜像内置的词典包对应的可用值：

- 上游默认集合（最稳）：`de_DE en_GB en_US es_ES fr_FR it nl pt_BR pt_PT ru`
- 其它已装语言（2 字母码）：`ar bg ca cs da el eo gl he hr hu id is ko lo no oc pl ro sk sl sq sv tr uk vi`

例如 `en_US de_DE`。**镜像不含中文词典**（没有 `zh`），中文用户只能用英文等词典，或自行把中文词典装进容器。启用语言越多，coolwsd 启动越慢，不建议全开。

## 接入 Nextcloud

1. 在 Nextcloud 应用中心安装 **Collabora Online**（新版本叫 **Nextcloud Office**）。
2. 进入 **设置 → 管理 → 协作**（旧版本路径：设置 → 协作）。
3. 填入本服务的地址：
   - 有域名 + 反向代理：`https://office.example.com`（推荐）
   - 仅内网直连：`http://192.168.1.10:9980`
   - 需要带管理控制台账号密码时：`https://admin:你的密码@office.example.com`
4. 「WOPI 允许域名」安装参数填成 Nextcloud 的访问地址（协议 + 端口），保存。
5. 点「检查状态」，显示协作服务器可用即完成。

## 反向代理

推荐用 1Panel 的「网站 → 反向代理」把域名代理到 `http://127.0.0.1:<端口>`。**必须支持 WebSocket**（文档编辑走 `/cool/.../ws` 长连接），1Panel 默认的 OpenResty 代理模板已包含 WebSocket 支持。

如果用的是外部 Nginx，参考：

```nginx
server {
    listen 443 ssl;
    server_name office.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:9980;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
```

在 TLS 由反代终止的场景，建议把「附加参数」改成：

```
--o:ssl.enable=false --o:ssl.termination=true
```

`--o:ssl.termination=true` 告诉 coolwsd「前面的代理已经处理了 TLS」。如果网盘和本服务在不同网段、WOPI 请求被拒，再追加：

```
--o:net.post_allow.host[0]=.+ --o:storage.wopi.host[0]=.+
```

## HTTP / HTTPS

| 场景 | 「附加参数」 | 访问方式 |
|------|--------------|----------|
| 明文直连（默认） | `--o:ssl.enable=false` | `http://ip:9980` |
| 1Panel 反代（反代终止 TLS） | `--o:ssl.enable=false --o:ssl.termination=true` | `https://你的域名` |
| 容器内自签 HTTPS | 留空 | `https://ip:9980`（浏览器提示自签证书） |

## 运行身份

本应用**不提供** `UID` / `GID` 安装参数，也不在 compose 里写 `user:`，与仓库内其他应用的默认口径（99 / 100）不同，原因如下：

- 官方镜像自带 `USER 1001`（nonroot），且 `/opt/cool`、`/etc/coolwsd` 都由该 UID 持有；
- 官方镜像**没有** PUID/PGID 降权 entrypoint，无法通过环境变量换身份；
- 覆盖 `user:` 后，coolwsd 将无法在 `/opt/cool` 下创建 jail / cache 目录，容器会直接启动失败（该目录在镜像内，无法从宿主机 chown）。

因此容器固定以镜像内置的 `1001:1001` 运行，宿主机上看到属主为 `1001` 属正常现象。

## 数据持久化

本应用**没有** bind mount，与上游官方 compose 保持一致：

- 镜像的配置在容器内 `/etc/coolwsd/coolwsd.xml`，管理控制台里手工改的设置保存在那里；
- 把宿主机目录挂到该路径会**遮蔽镜像自带的配置**（coolwsd 将无配置启动），同样 `/opt/collaboraoffice` 内含镜像自带的词典包，也不能遮蔽；
- 容器内的 jail 目录（`child_root_path` = `/opt/cool/child-roots`）要求是**空目录**，持久化它反而可能让 coolwsd 启动失败；
- 因此容器重建后，管理控制台里手工修改过的设置会恢复默认。

**关键配置（管理控制台账号密码、WOPI 允许域名、服务名、词典、附加参数）都已通过安装参数暴露**，重建容器后重新填写安装参数即可恢复。

## 常见问题

| 现象 | 处理 |
|------|------|
| 容器一直 `starting` | 首次启动要初始化运行时，等 1～5 分钟；用 `docker logs <容器名>` 看进度 |
| Nextcloud 里提示「协作服务器不可用」 | 检查「WOPI 允许域名」是否与 Nextcloud 访问地址完全一致（协议 + 端口 + 转义的点） |
| 文档一直加载不出来 | 反代必须支持 WebSocket；检查 `Upgrade` / `Connection` 头 |
| 管理控制台打不开 | 路径是 `/browser/dist/admin/admin.html`；旧版本为 `/loleaflet/dist/admin/admin.html` |
| 内存不足导致退出 | CODE 建议至少 2 GB 内存，可在 1Panel 的容器设置里调整 |
| 拼写检查没反应 | 镜像不含中文词典（无 `zh`），可改用 `en_US` 等其它语言 |

## 官方链接

- 产品主页：https://www.collaboraonline.com/
- CODE 介绍：https://www.collaboraonline.com/code/
- 源码：https://github.com/CollaboraOnline/online
- 镜像：https://hub.docker.com/r/collabora/code
