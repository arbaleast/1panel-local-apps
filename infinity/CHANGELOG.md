# Changelog

本项目所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-08-02

### Added

- 1Panel 本地应用骨架：根元数据 `data.yml`、版本目录 `latest/` 与版本元数据。
- 应用图标 `logo.png`（来源见仓库 README）。
- Apache 2.0 `LICENSE`（版权方 Infinity Contributors，与上游 michaelf34/infinity 一致）。
- 应用级 `.gitignore` 与 Git LFS 配置 `.gitattributes`（`wheels/` 下 `.whl` / `.tar.gz` 走 LFS）。
- `wheels/`、`data/`、`scripts/` 目录占位（`.gitkeep`）。

### Changed

- 采用 `latest/` 作为唯一版本目录，版本参数即目录名。
- `docker-compose.yml` 主服务 `container_name` 使用 `${CONTAINER_NAME}`，接入 `1panel-network` 外部网络。
- 对外端口通过 `PANEL_APP_PORT_HTTP` 声明，容器内端口 `INFINITY_PORT` 默认 7997。

### Deprecated

- 无。

### Removed

- 无。

### Fixed

- 无。

### Security

- 无。
