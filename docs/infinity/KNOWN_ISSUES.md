# 已知问题与解决方案

## 1. flash-attn 装不上

**现象**：构建或启动时 `pip install flash-attn` 失败，或报 ABI 不兼容。

**原因**：`flash-attn` 官方 wheel 与 `torch 2.6` 的 C++ ABI 不匹配（torch 2.6 变更了 ABI），源码编译又需要匹配的 CUDA 工具链，在容器内现场编译极易失败。

**解决**：
- 不安装 flash-attn。Infinity 对常见 embedding 模型（bge / e5 / qwen3-emb）在无 flash-attn 时仍可用 `xformers` 或原生 PyTorch attention 路径。
- 本镜像默认不引入 flash-attn 依赖，若上游默认安装，构建时移除或用 `FAISS_CPU` / `XFORMERS` 回退。

## 2. bitsandbytes int8 在 Pascal 上能跑

**现象**：GTX 10 系（sm_61 / CC 6.1）担心 int8 量化不可用。

**结论**：**能用**。bitsandbytes（bnb）支持 CC 6.1（sm_61），Pascal 上 int8 量化路径可用。

**注意**：
- 仅当 `DTYPE=int8` 且模型通过 bnb 量化加载时才走该路径。
- 更老的 Kepler / Maxwell（CC < 6.0）不在本镜像支持范围。

## 3. 默认 dtype=int8 是 Pascal 兼容性最佳选择

**背景**：镜像目标最低架构为 Pascal（sm_61）。

**结论**：
- `DTYPE` 默认 `int8`：显存占用最低、Pascal 兼容性最好，是默认值与推荐值。
- `float16` / `bfloat16` 在 Pascal 上可用但收益有限且显存翻倍；Ampere / Hopper 上可用 `float16` / `bfloat16` 获得更好效果。
- 不确定时保持 `int8`，或 `auto` 让框架选择。

## 4. 数据集加载 HuggingFace 失败

**现象**：容器启动拉取模型 / 数据集时报连接超时、TLS 错误或 403。

**原因**：HuggingFace 在部分网络环境下不可达。

**解决**（在 1Panel 主机上）：
1. 给容器或主机设置代理：

```bash
# 在 1Panel 容器环境变量中增加
HTTP_PROXY=http://<proxy-host>:<port>
HTTPS_PROXY=http://<proxy-host>:<port>
```

2. 或换用 HuggingFace 镜像源（在容器环境变量中设置）：

```bash
HF_ENDPOINT=https://hf-mirror.com
```

3. 也可在 1Panel 的容器运行时/宿主机全局代理中配置；拉取完成后可移除代理以恢复直连。
