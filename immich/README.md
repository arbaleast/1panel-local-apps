# Immich 照片视频管理

Google Photos 自托管替代品，ML 人脸/物体识别。

## 访问
- Web: https://immich.arbaleast.top
- iOS/Android App: 同 URL，扫码添加服务器

## 用户
- admin@test.com / 见 .env IMMICH_ADMIN_PASSWORD
- guest@immich / 见 .env (只读浏览)
- sysadmin@immich / 见 .env (系统管理员)

## 用户隔离
- admin 和 guest 互相不可见
- sysadmin 是第三方管理员

## 数据
- 上传目录: /mnt/user/media/photos/immich/upload
- 应用数据: /mnt/user/appdata/immich/
- 缩略图 / 备份: 同 appdata 目录

## 依赖
- PostgreSQL (immich 专用库)
- Redis (无密码)

## 运行用户 UID / GID

安装参数 `UID` / `GID` 通过 compose 的 `user:` 指定容器内进程身份，默认 `99` / `100`。

⚠️ **首次部署前必须把数据目录属主改到同一 UID / GID**，否则容器无权写入、启动即失败：

```bash
# 以应用实际安装目录为准（1Panel → 应用 → immich → 详情 → 路径）
sudo chown -R 99:100 <应用安装目录>/data
```

需要 chown 的目录（相对于应用安装目录）：`./data/model-cache`

另外这些宿主机绝对路径也会被挂载进去，只需保证 uid 99 **可读**（需要写入时再单独 chown）：

- `/mnt/nfs/media/photos/immich/upload`

- 想以 root 运行：把 `UID` / `GID` 都填 `0`
- 升级到新版本目录后要**重新 chown 一次**（新目录下的 `data` 为空、属主是 root）
- 容器内所有新文件都以该 UID / GID 创建，宿主机上看到属主是 99:100 属正常现象
