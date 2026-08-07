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
