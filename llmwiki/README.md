# LLM Wiki（占位应用）

> ⚠️ **风险提示 / 占位说明**
>
> - 本条目是**占位应用**，仅作为 1Panel 应用商店的元数据条目。
> - 所用第三方 Docker 镜像 [`041002/llm_wiki:latest`](https://hub.docker.com/r/041002/llm_wiki) **不是** headless 服务：
>   - 镜像内仅 1 个文件 `llm_wiki.AppImage`，无 EXPOSE 端口
>   - `CMD=/bin/sh`，无 Entrypoint，**容器启动后无任何进程监听 19828**
>   - 设置 `LLM_WIKI_BIND_HOST`/`LLM_WIKI_API_TOKEN`/`LLM_WIKI_ALLOW_LAN` 等环境变量**不会**让 API 自动启动
> - 官方仓库 [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) 是 Tauri 桌面应用（GUI），需要图形运行环境（WebKit2GTK/xvfb），headless 支持仍为 [issue #231](https://github.com/nashsu/llm_wiki/issues/231) **未实现**
> - 本仓库维护者**不保证**该条目能产生可用的 1Panel 服务
>
> 部署后请检查容器日志；若 19828 端口未监听，请将"网络"页"外部访问"开关关闭以避免反复重启失败。

## 简介
LLM Wiki 是基于 LLM 的本地知识库工具，支持将本地文档构建为可搜索、可问答的 Wiki。

## 配置
| 项 | 默认值 | 说明 |
|----|--------|------|
| 容器名称 | llmwiki | 1Panel 内部容器名 |
| API 端口 | 19828 | 容器内 API 端口（镜像实际未监听，参见上方风险） |
| `LLM_WIKI_BIND_HOST` | 127.0.0.1 | API 监听地址（仅占位，不会生效） |
| `LLM_WIKI_API_TOKEN` | （留空） | API Token（仅占位） |
| `LLM_WIKI_ALLOW_LAN` | false | 是否允许 LAN 访问（仅占位） |
| 数据持久化 | `./data` | 容器内 `/data` 占位挂载 |

## 参考
- 官方仓库：<https://github.com/nashsu/llm_wiki>
- 第三方镜像：<https://hub.docker.com/r/041002/llm_wiki>
