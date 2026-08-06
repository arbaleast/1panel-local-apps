# 从源码构建 Infinity 镜像

本文档说明 `infinity-pascal:cu124` 镜像如何在本地从源码构建，以及 wheel 文件（PyTorch cu124 构建）如何准备和分发。

## 为什么需要 wheels

Infinity 依赖 PyTorch，而默认 Docker 镜像的目标 GPU 架构是较新的 Ampere / Hopper。本仓库的镜像目标是最低兼容 **Pascal（sm_61，GTX 10 系）**：

- 官方 PyTorch `cu124` 构建默认不包含 Pascal 的 `sm_61` 内核，需自行重装包含 `sm_61` 的 torch wheel；
- 在容器内现场编译或下载会不稳定、慢且容易失败；
- 因此约定：**wheel 文件（`torch==2.6.0+cu124` 与 `torchvision==0.21.0+cu124`，cp310，Linux x86_64）预先下载并随仓库分发**，构建时直接 `pip install`，保证构建可复现。

> 上游源码：见 [项目主页](<!-- TODO: 由协调者填入 -->)。拼写以协调者最终确认为准。

## 策略 A: Git LFS(推荐)

将 wheel 文件存进仓库并启用 Git LFS，避免大文件撑爆 Git 仓库：

```bash
# 在仓库根目录执行一次
git lfs install
git lfs track "cu124/wheels/*.whl"

# 提交 .gitattributes 与 wheel 文件
git add .gitattributes cu124/wheels/
git commit -m "chore: track cu124 wheels via git lfs"
```

- wheel 文件放在构建上下文 `infinity/cu124/wheels/` 目录（本仓库已预留该目录；旧位置 `infinity/wheels/` 已迁移至此，避免与 Dockerfile `COPY wheels/` 的上下文错位）。
- 每次用 [scripts/download_wheels.sh](../scripts/infinity/download_wheels.sh) 下载或更新后，重新 commit 即可。
- 构建侧：克隆仓库时自动拉取 LFS 对象；Dockerfile 中 `COPY wheels/ /tmp/wheels/`（相对于构建上下文 `cu124/`）后 `pip install`。

## 策略 B: GitHub Release 附件

不把大文件放进 Git 历史，而是作为 Release 附件发布，Dockerfile 构建时用 `wget` 下载：

```dockerfile
# 示例：构建时从 Release 附件下载 wheel（URL 占位，由协调者确定最终地址）
RUN wget -q -O /tmp/torch.whl \
    "<!-- TODO: 由协调者填入 -->" \
    && pip install /tmp/torch.whl
```

- 优点：Git 仓库保持轻量，wheel 更新只需重新发布 Release。
- 缺点：构建时机依赖外网可达性（如被墙需配置镜像或代理）。

## 策略 C: 外部下载源（HF / ModelScope）

不在构建时固定 wheel，而是由 Dockerfile 在**容器启动时**（entrypoint）从外部源下载：

- 优点：镜像小、wheel 更新不需要重建镜像。
- 缺点：每次启动依赖外网，下载慢、失败率高；与“本地应用”离线部署的定位冲突。

> **建议**：本仓库默认采用 **策略 A（Git LFS）**，策略 B / C 作为备选。

## 本地准备 wheels

在 Linux x86_64 主机（Pascal / Ampere / Hopper 均适用）上运行：

```bash
# 先赋予执行权限（如需）
chmod +x scripts/infinity/download_wheels.sh

# 下载 torch 2.6.0+cu124 / torchvision 0.21.0+cu124 的 cp310 wheel 到 infinity/cu124/wheels/
bash scripts/infinity/download_wheels.sh
```

脚本会将 wheel 下载到 `infinity/cu124/wheels/`（文件名带时间戳后缀，避免覆盖旧文件），并打印下载结果。Windows / macOS 会被跳过并提示（需要 Linux 环境，或在 Docker 内跑）。

> wheel 来自 PyTorch 官方 index：`https://download.pytorch.org/whl/cu124`，适配 Linux x86_64（cp310）。

## 触发 build

有两种方式构建：

1. **1Panel 部署时自动构建**：安装表单的 Docker 镜像默认填 `infinity-pascal:cu124`，compose 中对应服务为 `build: .` 指向 `infinity/cu124/`。1Panel 检测到本地不存在该 tag 时触发 `docker build`。
2. **命令行手动构建**：

```bash
bash scripts/infinity/build.sh          # 等价于 docker build -t infinity-pascal:cu124 infinity/cu124/
bash scripts/infinity/build.sh --no-cache   # 禁用层缓存，全量重建
```

构建完成后，1Panel 安装表单中 `IMAGE` 填 `infinity-pascal:cu124` 即可直接使用本地镜像。
