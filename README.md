# local-models

一台 GPU 主机上的本地生图、生视频和语音命令。推理只在模型主机上跑，其他机器经 ssh 调用；
服务按需启动，空闲退出，显存互相避让。

| 命令 | 作用 |
|---|---|
| `tts synth --text T --output F --lang L [--use U]` | 合成一句，写 WAV |
| `tts batch --batch-file F` | JSONL 批量合成，每行 `{"text","output","lang","use"}`，路径相对清单文件 |
| `scene-image SCENE -o F` | ComfyUI 生图 |
| `scene-video SCENE -o F [--image FRAME]` | ComfyUI 生视频 |
| `scene-narrate VIDEO SENTENCE WORD OUT` | 给视频配「整句 → 半秒 → 单词」旁白 |
| `scene-show FILE`、`scene-show --clear` | 开窗口看产物、关掉这些窗口 |

`--lang` 必填，取 `en`、`ja`、`zh`；`--use` 是 `anki`（默认）或 `video`，两者决定用哪个模型。语言不自动
检测：`学校` 这样的短词无法判断，猜错不会报错，只会读错：

| 用途 | 英语 | 中文 | 日语 |
|---|---|---|---|
| `anki` | Breeze | Breeze | Irodori |
| `video` | Ming | Ming tiny | Ming |

音色默认用 `tts.voices` 里该用途、该语言的参考。`tts synth` 可加 `--voice WAV --voice-text 文字稿`（两个必须同时给，文字稿要与
音频一字不差）临时替换，也可加 `--instruction`、`--seed`。选型结论见 [docs/tts-models.md](docs/tts-models.md)。

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

模型代码和权重不进仓库，放在 `config.json` 指定的目录：

```bash
git clone https://github.com/breezeblue-ai/breeze-tts.git ~/projects/breeze-tts
cd ~/projects/breeze-tts
uv venv -p 3.12 .venv
uv pip install -p .venv/bin/python -r requirements.txt
hf download BreezeBlue/Breeze-TTS-2 --local-dir ~/projects/breeze-tts-2
```

测试过的上游提交是 `daa6cb2`。

Ming、Irodori 和 Qwen3-TTS 可选。Ming 提供 `video` 路由，Irodori 提供日语路由，Qwen 只在 `routes` 指向它时使用：

```bash
uv venv -p 3.12 ~/projects/qwen3-tts/.venv
uv pip install -p ~/projects/qwen3-tts/.venv/bin/python qwen-tts
hf download Qwen/Qwen3-TTS-12Hz-1.7B-Base --local-dir ~/projects/qwen3-tts/weights/1.7B-Base

git clone https://github.com/Aratako/Irodori-TTS.git ~/projects/irodori
cd ~/projects/irodori && uv sync --extra cu128
hf download Aratako/Irodori-TTS-v4.1-Small
hf download Aratako/Semantic-DACVAE-Japanese-32dim
```

Ming tiny（`video` 的中文）和 Ming 共用检出和 `.venv`。它钉死的 `x-transformers` 与 0.5B 冲突，独有的包装进
单独目录，由 `tts.mingTiny.packages` 放在 `PYTHONPATH` 前面。bf16 权重 18 GB，引擎加载时把专家流式量化成 int8，
16 GB 显卡装得下：

```bash
uv pip install --target ~/projects/tts-eval/tiny-extra --no-deps x-transformers==2.7.4 fla-core==0.4.2
uvx --from modelscope modelscope download --model inclusionAI/Ming-3.0-tts-tiny --local_dir ~/projects/tts-eval/ming-tiny-weights
```

## 安装和更新

不用 nix，直接用 bun 跑。主机上要有 bun、ffmpeg、ssh、systemctl；模型主机另要 nvidia-smi、ss、tailscale，
跑 Breeze 还要 sox。setup 开头会检查，缺哪个就报哪个。

每台主机克隆一份专门用来运行的检出，不和开发用的检出混用，改到一半的代码不会影响正在用的命令：

```bash
git clone https://github.com/yebei199/local-models.git ~/.local/share/local-models/src
```

再写本机的 `~/.config/local-models/config.json`，然后安装。以后更新也是这一条：

```bash
cd ~/.local/share/local-models/src && git pull && bun run setup
```

`setup` 先装依赖、构建网页前端，再按配置写出三样东西：`~/.config/systemd/user` 下的服务、
`~/.local/state/local-models/gate.json`（网关配置）、`~/.local/bin` 下的命令。它只启动还没在跑的服务，
从不重启或停止模型服务，正在跑的显卡任务不会被打断；定义变了的运行中服务只提示，空闲时自己重启。
网页服务不占显卡，每次都会重启。不是 setup 写的同名文件它不覆盖，直接报错。

只调用命令的机器只写 `host` 和 ComfyUI 的地址：

```json
{ "host": "gpu-host", "comfyui": { "url": "https://gpu-host.example.ts.net:18088" } }
```

模型主机按自己有的服务写对应的段，没写的服务不装。`host` 写本机名也算本机：

```json
{
  "host": "gpu-host",
  "comfyui": { "directory": "/home/me/projects/explore", "url": "https://gpu-host.example.ts.net:18088" },
  "web": {},
  "tts": {
    "directory": "/home/me/projects/breeze-tts",
    "modelDirectory": "/home/me/projects/breeze-tts-2",
    "voices": {
      "anki": { "en": { "path": "/home/me/voices/quiet_en.wav", "text": "参考音频的准确文字稿" } },
      "video": { "zh": { "path": "/home/me/voices/story_zh.wav", "text": "参考音频的准确文字稿" } }
    },
    "qwen": { "directory": "/home/me/projects/qwen3-tts", "modelDirectory": "/home/me/projects/qwen3-tts/weights/1.7B-Base" },
    "irodori": { "directory": "/home/me/projects/irodori" },
    "ming": { "directory": "/home/me/projects/ming", "modelDirectory": "/home/me/projects/ming/weights" },
    "mingTiny": {
      "directory": "/home/me/projects/ming",
      "packages": "/home/me/projects/tiny-extra",
      "modelDirectory": "/home/me/projects/ming-tiny-weights"
    }
  }
}
```

可选项：`idleTime`（默认 `30min`）、`cudaLibraryPath`（默认 `/run/opengl-driver/lib`）、`web.directory`、
`tts.routes`（默认见上面的路由表）、各引擎的 `requiredVram`（MiB，默认值写在 `src/setup.ts`，来自实测峰值）、
`tts.mingTiny.bits`（4 或 8，默认 8）。

## 开发

```bash
bun install
bun run check   # biome、tsc、bun test，不需要 GPU
bun run build   # 前端构建到 web/dist；cd web && bunx vite 开发，/api 代理到本机 8096
```

测试把外部程序（ssh、systemctl、mpv、nvidia-smi、模型服务）换成假的，真实地跑子进程和文件，
不需要 GPU。

## 许可

本仓库代码是 GPL-3.0。Breeze-TTS-2 的代码是 Apache 2.0，**权重和生成的音频仅限研究和非商业用途**，
本仓库不含权重。
