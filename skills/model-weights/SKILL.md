---
name: model-weights
description: Download model weights onto the model host and compare available sources on its actual network path. Load before fetching Hugging Face weights or trying a new local model.
---

# model-weights

local-models 的命令用到的权重不手工下载：写进那个仓库的 `src/manifest.ts`（仓库加 revision），
`bun run setup` 会下载并核对哈希，下载地址走 `HF_ENDPOINT`。下面的手工下载只用于试新模型。

用户所在地、模型主机位置和下载出口是三件事，代理或深圳 VPS 配置不能证明模型主机在哪。
下面是旧链路的测速记录，执行地点未核实；此前标为“新加坡实测”没有充分依据。
先在实际模型主机上比较 Hugging Face、ModelScope 和 hf-mirror 的下载速度，记录是否经代理，
再决定用哪个源。hf-mirror 的入口是 `HF_ENDPOINT=https://hf-mirror.com`。

| 来源（2026-11-07 记录，执行地点未核实） | 速度 |
|---|---|
| ModelScope，模型主机直连 | 40 MB/s |
| ModelScope，其他主机直连 | 9 MB/s |
| Hugging Face，其他主机经代理 | 平均 3 MB/s，之后停在 0 |
| hf-mirror，模型主机直连 | 21 MB/s |
| Hugging Face，模型主机经代理（2026-11-03） | 0 |

清华 TUNA 没有 Hugging Face 镜像（`hugging-face-models` 返回 404），它的 PyPI 能用。

```bash
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
uvx --index-url https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple --from modelscope \
  modelscope download --model ORG/NAME --local_dir DIR
```

ModelScope 上的同名仓库可能是别人转传的，也可能版本落后，下载前核对。下面在 bash 里运行，没有输出就是所有 LFS
文件都和 Hugging Face 一致。这里的 API 请求很小，经代理也能查 Hugging Face：

```bash
repo=ORG/NAME
comm -23 \
  <(curl -s "https://huggingface.co/api/models/$repo/tree/main?recursive=true" |
    jq -r '.[]|select(.lfs)|"\(.lfs.oid) \(.path)"' | sort) \
  <(curl -s --noproxy '*' "https://modelscope.cn/api/v1/models/$repo/repo/files?Recursive=true" |
    jq -r '.Data.Files[]|"\(.Sha256) \(.Path)"' | sort)
```

- Hugging Face 的门控仓库会把哈希遮成星号，上面的命令会报全部不一致，这时只能比大小。门控条款要用户本人同意，不要绕到
  ModelScope 的转传上下载。
- 判断下载是否卡住要看网卡收包速率。`hf download` 的 `du` 和 `.incomplete` 文件大小长时间不动不代表停了。
- 仓库不在 ModelScope 时比较 Hugging Face 与 hf-mirror，在实际模型主机上验证可达性和速度。
- 大模型的依赖用 `UV_CONCURRENT_DOWNLOADS=2`，否则镜像返回 429。
