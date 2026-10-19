# Traefik v3 反向代理

Traefik v3 edge router + Let's Encrypt DNS-01 通配符证书 + Docker provider 动态配置。

## 访问
- Dashboard: http://192.168.98.246:8082 (无鉴权，仅 LAN)
- API: http://192.168.98.246:8082/api

## 路由
- *.arbaleast.top 自动从 Docker 容器 label 发现
- 证书: 通配符 *.arbaleast.top (Let's Encrypt DNS-01)

## 配置
- 静态配置: /opt/1panel/apps/local/traefik/traefik/data/traefik.yml
- 动态配置: /opt/1panel/apps/local/traefik/traefik/data/dynamic/
- 日志: /opt/1panel/apps/local/traefik/traefik/data/logs/

## 关联
- 1Panel nginx: 入站 80/443 → Traefik
- certbot DNS-01 续期: 见 dynamic/certificates.yml

## 添加新服务
- Docker label:
  - "traefik.enable=true"
  - "traefik.http.routers.<name>.rule=Host(`<sub>.arbaleast.top`)"
  - "traefik.http.routers.<name>.tls.certresolver=letsencrypt"

## 运行用户 UID / GID

安装参数 `UID` / `GID` 通过 compose 的 `user:` 指定容器内进程身份，默认 `99` / `100`。

本应用没有需要 chown 的持久化数据目录（无宿主机 bind mount），可直接安装。

另外这些宿主机绝对路径也会被挂载进去，只需保证 uid 99 **可读**（需要写入时再单独 chown）：

- `/home/al/.acme.sh/arbaleast.top_ecc/arbaleast.top.key`
- `/home/al/.acme.sh/arbaleast.top_ecc/fullchain.cer`
- `/home/al/workspace/traefik/dynamic.yml`
- `/home/al/workspace/traefik/traefik.yml`

- 想以 root 运行：把 `UID` / `GID` 都填 `0`
- 升级到新版本目录后要**重新 chown 一次**（新目录下的 `data` 为空、属主是 root）
- 容器内所有新文件都以该 UID / GID 创建，宿主机上看到属主是 99:100 属正常现象
