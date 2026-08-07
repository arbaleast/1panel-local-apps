# Mihomo (glash) — 1Panel Local App

Wraps the [gangz1o/clash4docker](https://github.com/gangz1o/clash4docker) `gangz1o/glash` image:
- Latest Mihomo (Clash Meta) kernel
- Bundled [MetacubexD](https://github.com/MetaCubeX/metacubexd) Dashboard (no separate UI deploy needed)
- Pre-packaged GeoIP / GeoSite / Country.mmdb
- **Subscription auto-download + scheduled update** (the main draw)
- Optional TUN mode (transparent proxy)

## Ports

| Port | Purpose |
|------|---------|
| 7890 | HTTP proxy |
| 7891 | SOCKS5 proxy |
| 7892 | Mixed (HTTP + SOCKS) |
| 9090 | REST API + Dashboard |

## Quick start (Subscription mode — recommended)

1. 1Panel App Store → Local → find **Mihomo (glash)** → Install
2. Install form:
   - **Subscription URL**: your Clash / clash.meta subscription link
   - **Dashboard Secret**: a strong password (for Dashboard login)
   - **Subscription Cron**: default `0 */6 * * *` (update every 6 hours)
   - Other fields can stay at default
3. Visit `http://<host>:9090/ui/`, backend URL = `http://<host>:9090`, secret = your SECRET

## How subscription mode works

`start.sh` on container boot:

1. If `DATA_PATH` (default `./data`) already has `config.yaml` → use local config
2. Otherwise download from `SUB_URL`
3. Inject `SECRET`, `ALLOW_LAN`, `AUTHENTICATION` into config
4. If `SUB_CRON` is set, schedule auto-update + hot-restart

> **Important:** With subscription mode, the config dir **must be writable** (don't bind-mount a single file as `:ro`).

## Local-config mode

If you don't set `SUB_URL`, you need to provide a `config.yaml` yourself:

```bash
cat > /opt/1panel/apps/local/mihomo/mihomo/data/config.yaml << 'EOF'
mixed-port: 7892
allow-lan: true
mode: rule
log-level: info
external-controller: 0.0.0.0:9090
secret: "your-password"
proxies: []
proxy-groups:
  - name: PROXY
    type: select
    proxies: []
rules:
  - GEOIP,private,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
EOF
```

## TUN mode (transparent proxy)

TUN mode makes **all traffic inside the container** go through the proxy — no client config needed.

- The image supports `NET_ADMIN` + `/dev/net/tun` (already declared in compose)
- Set **Enable TUN** = "启用" in the 1Panel UI form and restart
- Verify: `docker exec <container> cat /proc/sys/net/ipv4/ip_forward`

## Image pull

Default `gangz1o/glash:latest` (Mihomo v1.19.x + MetacubexD v1.26x). If .246 mirror doesn't include gangz1o:

```bash
# Use any mirror from the upstream README
docker pull docker.1ms.run/gangz1o/glash:latest
docker tag docker.1ms.run/gangz1o/glash:latest gangz1o/glash:latest
```

## Troubleshooting

**Q: Dashboard Mixed Content error?**
Reverse-proxy the entire 9090 port with HTTPS, or use `http://<host>:9090/ui/` directly.

**Q: Subscription download fails?**
```bash
docker logs <container>                 # start.sh output
docker exec <container> cat /var/log/subscription.log   # subscription-specific log
```

**Q: How do I add nodes?**
In subscription mode, nodes come from the subscription URL — the local `config.yaml` gets overwritten. Change your subscription URL or disable subscription mode.

## Files

```
mihomo/
├── data.yml           # Root metadata + full formFields
├── logo.png           # clash.png icon
├── README.md          # this file (zh)
├── README_en.md       # English
└── latest/
    ├── data.yml       # Install form (16 fields)
    └── docker-compose.yml
```
