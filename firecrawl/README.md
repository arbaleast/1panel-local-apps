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
