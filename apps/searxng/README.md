# SearXNG 元搜索引擎

聚合 70+ 搜索引擎，无追踪、无广告。

## 访问
- Web: https://searxng.arbaleast.top

## 配置
- 引擎启用/禁用: ./data/settings.yml
- 限制: JSON 输出格式

## Redis 缓存（可选）

SearXNG 默认使用内置的 filecache 进行缓存，无需额外配置即可正常运行。

如需接入外部 Redis 缓存服务以提升性能或实现多实例共享缓存，请按以下步骤操作：

1. 在 1Panel 应用商店部署一个 Redis 应用（如 `redis`、`valkey`），或使用已有的外部 Redis 服务。
2. 部署 SearXNG 时，在 1Panel 的「额外环境变量」中手动添加：
   ```
   SEARXNG_REDIS_URL=redis://:password@host:6379/0
   ```
3. 安装表单中的 `REDIS_URL` 字段可用于复制或拼接连接串，该字段本身不会直接注入容器环境变量。

留空不添加 `SEARXNG_REDIS_URL` 环境变量时，SearXNG 将继续使用默认的 filecache，无需任何额外配置。
