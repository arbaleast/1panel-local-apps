# Photopea

在线图像编辑器,免安装的 Photoshop 替代品,支持 PSD、XCF、Sketch、XD、Figma 等多种格式。

## 特性

- 完整支持 PSD(Photoshop)、XCF(GIMP)、Sketch、XD、Figma、AI 等格式
- 图层、蒙版、滤镜、调整、笔刷等专业功能
- 纯浏览器运行,无需注册或登录
- 支持本地打开与导出文件

## 访问

部署完成后,通过浏览器访问 `http://<服务器IP>:<端口>` 即可使用(默认端口 8887)。

## 官方地址

- 官网: https://www.photopea.com/
- Docker 镜像: https://hub.docker.com/r/ramuses/photopea

## 运行用户 UID / GID

安装参数 `UID` / `GID` 通过 compose 的 `user:` 指定容器内进程身份，默认 `99` / `100`。

本应用没有需要 chown 的持久化数据目录（无宿主机 bind mount），可直接安装。

- 想以 root 运行：把 `UID` / `GID` 都填 `0`
- 升级到新版本目录后要**重新 chown 一次**（新目录下的 `data` 为空、属主是 root）
- 容器内所有新文件都以该 UID / GID 创建，宿主机上看到属主是 99:100 属正常现象
