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
