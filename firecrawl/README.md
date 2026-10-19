# Firecrawl 网页爬虫

将任意网站转为 LLM-ready markdown/结构化数据。

## 访问
- API: http://192.168.98.246:3002
- Playwright UI: http://192.168.98.246:3003

## API 端点
- POST /v0/scrape - 抓取单个 URL
- POST /v0/crawl - 递归爬取整站
- POST /v0/extract - LLM 提取结构化数据

## 凭证
- FIRECRAWL_API_KEY: 见 .env 文件

## 依赖
- Redis (1Panel-redis-wd53) - BullMQ 任务队列
- PostgreSQL - 元数据存储

## 运行用户 UID / GID

安装参数 `UID` / `GID` 通过 compose 的 `user:` 指定容器内进程身份，默认 `99` / `100`。

本应用没有需要 chown 的持久化数据目录（无宿主机 bind mount），可直接安装。

- 想以 root 运行：把 `UID` / `GID` 都填 `0`
- 升级到新版本目录后要**重新 chown 一次**（新目录下的 `data` 为空、属主是 root）
- 容器内所有新文件都以该 UID / GID 创建，宿主机上看到属主是 99:100 属正常现象
