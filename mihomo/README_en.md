# Mihomo — 1Panel Local App

Wraps the [daitcl/mihomo](https://github.com/daitcl/mihomo) image (version dir `v1.19.33` = image tag `v1.19.33`):
- Mihomo (Clash Meta) kernel + pre-packaged GeoIP / GeoSite
- Bundled [MetacubexD](https://github.com/MetaCubeX/metacubexd) Dashboard, served by Caddy inside the image
- `config.yaml` generated from your subscription URL on first start (subscription mode)
- TUN transparent proxy on by default (image config template)
- **amd64 only** (the upstream image publishes amd64 only)

The old `v1.19.18` version (gangz1o/glash image, with arm64) is kept as an archived snapshot, unmaintained.

## Ports

| Container port | Purpose |
|------|------|
| 7890 | Mixed proxy (HTTP + SOCKS) |
| 7891 | SOCKS5 proxy |
| 7892 | HTTP proxy |
| 9090 | REST API (external-controller) |
| 8080 | MetacubexD Dashboard (Caddy) |

> Port semantics differ from v1.19.18: there 7890 was HTTP and 7892 mixed; here (upstream template) 7890 is mixed and 7892 is HTTP.

## Install form

| Field | Meaning |
|------|------|
| Mixed / SOCKS / HTTP proxy ports | Host-side port mappings, default 7890 / 7891 / 7892 |
| Controller port | REST API (9090) |
| Dashboard port | MetacubexD web UI (8080) |
| Config folder path | Default `./data`, persistence directory |
| Timezone | Default `Asia/Shanghai` |
| Subscription URL | Clash / clash.meta subscription link; leave empty to supply your own `config.yaml` (see below) |
| Subscription Name | Proxy-provider name, default `default`, alphanumeric only |
| Dashboard Secret | REST API / Dashboard login secret; empty disables auth |
| Log Level | `info` / `silent`, default `info` |

## First-start behavior (important)

The entrypoint generates a config from the install params **only when `./data/config.yaml` does not exist**. Afterwards the env vars no longer take effect:

- To change the subscription URL / secret / log level, **delete `./data/config.yaml` and restart** (or edit the file directly and restart).
- Subscription refresh is driven by Mihomo's own `proxy-providers` interval (default 86400 s = once a day; edit `interval` in `config.yaml`). There is no extra cron inside the image.
- If the subscription URL is empty **and** `./data/config.yaml` doesn't exist, the generated config has an empty provider URL and Mihomo fails to start (restart loop). Pick one: fill in the subscription URL, or place your own `config.yaml` before starting.

## Subscription mode (recommended)

1. 1Panel App Store → Local → find **Mihomo** → Install
2. Fill in **Subscription URL** (Clash / clash.meta format); set a **Dashboard Secret** too
3. Open `http://<host>:8080` (Dashboard), backend = `http://<host>:9090`, secret = your Dashboard Secret

Nodes in subscription mode are managed by `proxy-providers`; manual `proxies` edits get overwritten. To hand-edit nodes, edit `./data/config.yaml` directly.

## Local-config mode

If you don't fill in a subscription URL, place your own `config.yaml` in `./data` **before** starting — the entrypoint will use it as-is:

```bash
cat > /opt/1panel/apps/local/mihomo/mihomo/v1.19.33/data/config.yaml << 'EOF'
mixed-port: 7890
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

## TUN mode (on by default)

The image template defaults to `tun.enable: true`; compose already grants `NET_ADMIN` and maps `/dev/net/tun`.
The host must provide `/dev/net/tun` (present on most Linux hosts). To disable TUN, edit `./data/config.yaml`,
set `tun.enable: false` and restart.

## Data persistence

`./data` (under the app install dir) → `/root/.config/mihomo` in the container: `config.yaml`, cache and geo files live here.
The image runs as root (no `user:` mapping) — **no** chown needed and there are no UID / GID install params.

## Upgrading from v1.19.18

- The `data/` directory is kept across versions; an existing `config.yaml` keeps being used as-is → the new install params (subscription URL etc.) will not take effect. To switch subscriptions, delete the old `config.yaml` and restart.
- Port semantics changed (see table above): if external scripts / reverse proxies assumed 7890 = HTTP, point them at mixed (7890) or HTTP (7892) instead.
- UID / GID params are gone (the image runs as root); previous ownership of the data dir does not affect operation.
- v1.19.18 used the gangz1o/glash image — a different upstream repo. Rollback = switch back to version `v1.19.18` in 1Panel.

## Image pull

```bash
docker pull ghcr.io/daitcl/mihomo:v1.19.33
```

If your mirror doesn't carry ghcr/daitcl, pull via any ghcr accelerator from the upstream README and retag.

## Troubleshooting

**Q: Dashboard won't open / Mixed Content error?**
The dashboard is plain HTTP on 8080; front it with HTTPS by reverse-proxying the whole port, or use `http://<host>:8080` directly. Connect it to the backend `http://<host>:9090` + your secret.

**Q: Install-param change has no effect?**
See "First-start behavior": delete `./data/config.yaml` and restart the app (back up your custom edits first).

**Q: Subscription download fails?**
`docker logs <container>` for entrypoint and Mihomo logs; make sure the subscription URL is reachable from inside the container (the provider is fetched by the Mihomo kernel itself).

## Files

```
mihomo/
├── data.yml           # Root metadata
├── logo.png
├── README.md          # Chinese
├── README_en.md       # this file
├── v1.19.33/          # current version (daitcl/mihomo)
│   ├── data.yml       # Install form (11 fields)
│   ├── docker-compose.yml
│   └── data/          # persistence
└── v1.19.18/          # archived (gangz1o/glash, with arm64)
```
