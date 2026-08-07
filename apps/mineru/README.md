# MinerU

[MinerU](https://opendatalab.github.io/MinerU/) 是 [OpenDataLab](https://github.com/opendatalab) 开源的文档智能解析工具，专注于从复杂格式的 PDF / DOCX / PPT / XLSX / 图片等文档中提取高质量、可结构化的内容。本应用部署的是 **`mineru-router`** 服务，作为 MinerU 的多服务 / 多 GPU 编排入口，对外暴露与 `mineru-api` 一致的 HTTP API。

- 官方网站：https://opendatalab.github.io/MinerU/
- GitHub 仓库：https://github.com/opendatalab/MinerU
- API 文档：启动后访问 `http://<server_ip>:<API端口>/docs`

## mineru-router 是什么

`mineru-router` 是 MinerU 提供的统一 API 路由/调度组件，适合以下场景：

- **多服务、多 GPU 编排**：通过 `--local-gpus auto` 自动发现并调度本机 GPU，拉起本地 worker 承担解析任务。
- **聚合已有 mineru-api**：通过 `--upstream-url` 聚合多个已部署的 `mineru-api` 服务，对客户端只暴露一个统一入口。
- **统一入口**：对外暴露 `/health`、`/tasks`、`/file_parse`、`/tasks/{task_id}`、`/tasks/{task_id}/result` 等接口，与 `mineru-api` 完全兼容。

详细参数与命令参考官方文档：[Docker 部署 - mineru-router](https://opendatalab.github.io/MinerU/zh/quick_start/docker_deployment/#mineru-router) 与 [基础使用 - mineru-router](https://opendatalab.github.io/MinerU/zh/usage/quick_usage/#minerumineru-router)。

## 镜像说明

- 本应用使用社区维护的 [alexsuntop/mineru](https://hub.docker.com/r/alexsuntop/mineru) 多架构镜像（含 amd64 / arm64 构建，标签 `3.4.2`），便于在 1Panel 上一键部署。
- 官方 `opendatalab/MinerU` 仓库 **不提供** Docker Hub 镜像，需要通过官方 `docker/china/Dockerfile` 本地构建 `mineru:latest` 后再使用，社区镜像已封装好该流程。

## 硬件要求

- 官方基于 `vllm-openai` 基础镜像构建，**必须使用 NVIDIA GPU**（Volta 及更新架构，显存 ≥ 8GB）。
- 宿主机需安装 **NVIDIA 驱动**（默认 CUDA 13.0 兼容；如需 CUDA 12.9 请自行调整镜像）与 [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)。
- 由于 `vllm` 推理框架预分配显存的特性，**同一台机器上请勿同时运行多个 vllm 服务**（如 vlm-openai-server、mineru-api 等），避免显存冲突。
- Windows 仅支持 WSL2 环境；macOS 因 Docker 无法调用 MPS/MLX 加速，不推荐部署。

## 端口

| 用途     | 容器内端口 | 默认对外端口（`PANEL_APP_PORT_API`） |
|----------|-----------|--------------------------------------|
| API      | 8002      | 8002                                 |

启动后访问 `http://<server_ip>:<API端口>/docs` 查看 Swagger 文档，`/health` 返回服务状态。

## 数据持久化

挂载点位于应用目录下的 `latest/data/`：

| 主机路径                  | 容器路径                  | 用途                                         |
|---------------------------|---------------------------|----------------------------------------------|
| `./data/output`           | `/app/output`             | mineru-router 解析任务输出（md/json/zip 等） |
| `./data/models`           | `/root/.cache/mineru`     | MinerU 模型缓存（首次启动自动下载到此处）    |
| `./data/config`           | `/root/.config/mineru`    | `mineru.json` 用户自定义配置                 |

> **模型源切换**：默认 `MINERU_MODEL_SOURCE=local`（使用本地缓存模型）。如首次启动时希望从 HuggingFace / ModelScope 拉取，可临时调整为对应值；模型下载后建议再切回 `local` 以避免重复下载。

## 关键参数

| 变量                         | 默认值               | 说明                                                                  |
|------------------------------|----------------------|-----------------------------------------------------------------------|
| `IMAGE`                      | `alexsuntop/mineru`  | 镜像仓库（支持多架构）                                                |
| `APP_VERSION`                | `3.4.2`              | 镜像标签                                                              |
| `PANEL_APP_PORT_API`         | `8002`               | 容器外暴露的 API 端口                                                 |
| `TZ`                         | `Asia/Shanghai`      | 容器时区                                                              |
| `ENABLE_GPU`                 | `true`               | 是否启用 GPU 直通（关闭时 mineru-router 强制 `--local-gpus none`，且容器不挂载 GPU） |
| `NVIDIA_VISIBLE_DEVICES`     | `all`                | 可见 GPU 设备（仅在 ENABLE_GPU=true 时生效；支持 `all`/`0,1` 等）     |
| `LOCAL_GPUS`                 | `auto`               | mineru-router 管理的 GPU（`auto`/`all`/`0,1`/`none`）                  |
| `MINERU_MODEL_SOURCE`        | `local`              | 模型源：`local` / `huggingface` / `modelscope`                        |
| `ENABLE_VLM_PRELOAD`         | `false`              | 启动时预热 VLM 模型（仅影响本地 worker）                              |
| `ALLOW_PUBLIC_HTTP_CLIENT`   | `false`              | 允许公网 http-client 后端（存在 SSRF 风险）                           |

> 如需聚合上游 `mineru-api` 服务而非启动本地 worker，请将本 compose 中 `mineru-router` 服务的 `command` 追加 `--local-gpus none` 与多条 `--upstream-url http://mineru-api:8000`（可重复多次），保存后重新部署即可。

## 调用示例

提交同步解析任务（兼容 `mineru-api`）：

```bash
curl -X POST "http://<server_ip>:8002/file_parse" \
  -F "files=@/path/to/sample.pdf" \
  -F "return_md=true" \
  -F "response_format_zip=true"
```

提交异步任务并轮询：

```bash
# 提交
TASK_ID=$(curl -s -X POST "http://<server_ip>:8002/tasks" \
  -F "files=@/path/to/sample.pdf" \
  -F "return_md=true" | jq -r .data.task_id)

# 轮询
curl "http://<server_ip>:8002/tasks/${TASK_ID}"

# 拉取结果
curl "http://<server_ip>:8002/tasks/${TASK_ID}/result" -o result.zip
```

健康检查：

```bash
curl "http://<server_ip>:8002/health"
```

## 反向代理

若通过 1Panel 反向代理对外暴露，请将域名指向宿主机 IP + `PANEL_APP_PORT_API`（默认 8002），并关闭 WebSocket 大小限制以兼容大文件上传。

## 许可

- 应用配置：仓库 `LICENSE`。
- MinerU 本身遵循 [MinerU 项目的开源协议](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md)。
