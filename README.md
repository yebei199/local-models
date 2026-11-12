# local-models

一台 GPU 主机上的本地生图、生视频、语音和翻译命令。推理只在模型主机上跑，其他机器经 ssh 调用；
服务按需启动，空闲退出，显存互相避让。

| 命令 | 作用 |
|---|---|
| `tts synth --text T --output F --lang L [--use U]` | 合成一句，写 WAV |
| `tts batch --batch-file F` | JSONL 批量合成，每行 `{"text","output","lang","use"}`，路径相对清单文件 |
| `scene-image SCENE -o F` | ComfyUI 生图 |
| `scene-video SCENE -o F [--image FRAME]` | ComfyUI 生视频 |
| `scene-narrate VIDEO SENTENCE WORD OUT` | 给视频配「整句 → 半秒 → 单词」旁白 |
| `scene-show FILE`、`scene-show --clear` | 开窗口看产物、关掉这些窗口 |
| `translate --to L [--from L] TEXT` | 翻译一段文字，译文写到标准输出；不给 TEXT 时读标准输入 |
| `translate --to L -i F -o F` | 翻译整篇文档（按段落）或字幕（`.srt`、`.vtt`，按条，保留编号和时间轴） |

`--lang` 必填，取 `en`、`ja`、`zh`；`--use` 是 `anki`（默认）或 `video`，两者决定用哪个模型。语言不自动
检测：`学校` 这样的短词无法判断，猜错不会报错，只会读错：

| 用途 | 英语 | 中文 | 日语 |
|---|---|---|---|
| `anki` | Breeze | Breeze | Irodori |
| `video` | Ming | Ming tiny | Ming |

音色默认用 `tts.voices` 里该用途、该语言的参考。`tts synth` 可加 `--voice WAV --voice-text 文字稿`（两个必须同时给，文字稿要与
音频一字不差）临时替换，也可加 `--instruction`、`--seed`。选型结论见 [docs/tts-models.md](docs/tts-models.md)。

## 翻译

模型主机在 tailnet 上提供 LibreTranslate 兼容的接口，`https://模型主机:18098`，不鉴权。Dialect 选 LibreTranslate、
填这个地址即可；`translate` 命令也走它。语言只有 `en`、`ja`、`zh`，`source` 可以是 `auto`。单条上限 3000 字符，
长文用 `translate -i` 自动按段切开。

模型是 Hy-MT2-7B（Q8_0 GGUF，Apache 2.0），由 llama.cpp 的 `llama-server` 运行，选型见
[docs/translation-models.md](docs/translation-models.md)。它约占 10 GiB 显存，放不进语音模型旁边，所以和 TTS
共用一个网关、轮流上卡：语音之后第一次翻译要等模型加载几秒，翻译之后第一句 TTS 要重新冷启动。

## 服务

ComfyUI 和 TTS 结构相同：socket 收到第一个请求时拉起 `systemd-socket-proxyd` 和后端，空闲
`idleTime`（默认 30 分钟）后一起退出，显存还回去。

- TTS 后端是 `model-gate`：它串行处理请求，同一时间只让一个模型留在显存里，换模型时先停旧的。
  `tts batch` 按模型分组，每个模型只加载一次。
- 语音模型和 ComfyUI 不能同时在显存里。`scene-*` 开工前先停 `tts-backend.service`，模型随网关退出。
- 反方向不杀任务：网关启动模型前查空闲显存，等 30 秒仍不够就拒绝请求。等待是因为 ComfyUI 的 `/free`
  先返回，权重几秒后才离开显存。
- 服务只绑回环。远程的 `tts` 用 `ssh -L` 把私有 unix socket 转发到服务端口。

RTX 5080 上的实测：冷启动约 35 秒，之后实时率约 0.8。不需要 flash-attn，上游的 `api.py`
写死了 eager 注意力。不要用 `--fast-all`，它要 14.4 GiB。

试听页由 `local-models-web.service` 发布，页面由 `web/` 的 React 前端渲染：只绑回环的 8096，Caddy 提供 tailnet 上的 HTTPS 入口 18096。把一个
`.html`，或带 `audition.json` / `index.html` 的目录放进 `web.directory`（默认 `~/.local/share/local-models/web`），
首页就会列出它。盲听的答案不要放进去，目录里的文件 tailnet 上都能读到。

## 模型主机准备

不用手工准备。`bun run setup` 先按 [`src/manifest.ts`](src/manifest.ts) 装这台主机要跑的组件，再写服务：

| 组件 | 代码 | Python | 权重 |
|---|---|---|---|
| `comfyui` | ComfyUI v0.45.0、ComfyUI-GGUF | 3.12，cu130 | Flux2 Klein 9B（GGUF）、MiniMax H3 |
| `breeze` | breeze-tts | 3.12 | Breeze-TTS-2 |
| `qwen` | 无，`qwen-tts` 包 | 3.12，cu130 | Qwen3-TTS 1.7B Base |
| `irodori` | Irodori-TTS | 3.10，cu128 | Irodori-TTS v4.1 Small、Semantic-DACVAE |
| `ming` | Ming-3.0-tts | 3.10，cu128 | Ming-3.0-tts 0.5B |
| `ming-tiny` | 与 Ming 共用检出和 venv | 另装 x-transformers、fla-core | Ming-3.0-tts tiny |
| `translator` | llama.cpp b12317 CUDA 13 预编译包 | 无 | Hy-MT2-7B Q8_0 GGUF |

代码钉在提交上，venv 由 `uv pip sync` 照 `locks/` 里冻结的环境建，权重钉在 Hugging Face 仓库的提交上，
下载支持续传，下完核对 sha256 才落盘。全部装在 `models` 目录下，每个组件一个子目录：

```text
models/
  comfyui/  code/（上游检出） venv/  data/（models、custom_nodes、input、output、user）
  breeze/   code/  venv/  weights/
  ming-tiny/  packages/  weights/        # 代码和 venv 用 ming/ 的
```

下载源按模型主机的实际链路测速选择；hf-mirror 可用 `HF_ENDPOINT=https://hf-mirror.com` 指定，
是否绕过代理也以该主机的对照测试为准。重跑只补缺的文件；正在运行的组件会被跳过，
空闲后再跑一次。怀疑权重损坏时 `bun run verify` 重算所有哈希，坏的重新下载。

ComfyUI 侧栏里的工作流就是本仓库 `comfyui/workflows/` 的文件，在网页里保存会直接改动检出。
`src/workflows.json` 是命令用的 API 格式，`bun run check` 会发现它和界面格式不一致。在浏览器里怎么用见
[docs/comfyui.md](docs/comfyui.md)。

## 安装和更新

不用 nix，直接用 bun 跑。主机上要有 bun、ffmpeg、ssh、systemctl；模型主机另要 nvidia-smi、ss、tailscale、git、uv、curl，
跑 Breeze 还要 sox。setup 开头会检查，缺哪个就报哪个。

每台主机克隆一份专门用来运行的检出，不和开发用的检出混用，改到一半的代码不会影响正在用的命令：

```bash
git clone https://github.com/yebei199/local-models.git ~/.local/share/local-models/src
```

再写本机的 `~/.config/local-models/config.json`，然后安装。以后更新也是这一条：

```bash
cd ~/.local/share/local-models/src && git pull && bun run setup
```

`setup` 先装依赖、构建网页前端、装模型（见上一节），再按配置写出三样东西：`~/.config/systemd/user` 下的服务、
`~/.local/state/local-models/gate.json`（网关配置）、`~/.local/bin` 下的命令。它只启动还没在跑的服务，
从不重启或停止模型服务，正在跑的显卡任务不会被打断；定义变了的运行中服务只提示，空闲时自己重启。
网页服务不占显卡，每次都会重启。不是 setup 写的同名文件它不覆盖，直接报错。

只调用命令的机器只写 `host`、ComfyUI 和翻译的地址：

```json
{
  "host": "gpu-host",
  "comfyui": { "url": "https://gpu-host.example.ts.net:18088" },
  "translate": { "url": "https://gpu-host.example.ts.net:18098" }
}
```

模型主机按自己有的服务写对应的段，没写的服务不装。`comfyui.serve` 表示这台主机跑 ComfyUI，`tts.engines`
列出要装的语音引擎，`translate.serve` 表示这台主机跑翻译模型。`host` 写本机名也算本机：

```json
{
  "host": "gpu-host",
  "comfyui": { "url": "https://gpu-host.example.ts.net:18088", "serve": true },
  "web": {},
  "translate": { "url": "https://gpu-host.example.ts.net:18098", "serve": true },
  "tts": {
    "voices": {
      "anki": { "en": { "path": "/home/me/voices/quiet_en.wav", "text": "参考音频的准确文字稿" } },
      "video": { "zh": { "path": "/home/me/voices/story_zh.wav", "text": "参考音频的准确文字稿" } }
    },
    "engines": { "breeze": {}, "qwen": {}, "irodori": {}, "ming": {}, "ming-tiny": { "bits": 8 } }
  }
}
```

可选项：`models`（安装目录，默认 `~/.local/share/local-models/models`）、`idleTime`（默认 `30min`）、
`cudaLibraryPath`（默认 `/run/opengl-driver/lib`）、`web.directory`、`tts.routes`（默认见上面的路由表）、
各引擎和 `translate` 的 `requiredVram`（MiB，默认值写在 `src/setup.ts`，来自实测峰值）、`ming-tiny` 的 `bits`（4 或 8，默认 8）。
旧版配置里的 `comfyui.directory`、`tts.directory` 等路径键已经去掉，留着会报错。

## 开发

```bash
bun install
bun run check   # biome、tsc、bun test，不需要 GPU
bun run build   # 前端构建到 web/dist；cd web && bunx vite 开发，/api 代理到本机 8096
```

测试把外部程序（ssh、systemctl、mpv、nvidia-smi、模型服务）换成假的，真实地跑子进程和文件，
不需要 GPU。

## 许可

本仓库代码是 GPL-3.0。Hy-MT2 的权重是 Apache 2.0，llama.cpp 是 MIT。Breeze-TTS-2 的代码是 Apache 2.0，**权重和生成的音频仅限研究和非商业用途**，
本仓库不含权重。
