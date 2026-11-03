# local-models

一台 GPU 主机上的本地生图、生视频和语音命令。推理只在模型主机上跑，其他机器经 ssh 调用；
服务按需启动，空闲退出，显存互相避让。

| 命令 | 作用 |
|---|---|
| `tts synth --text T --output F` | Breeze-TTS-2 合成一句，写 WAV |
| `tts batch --batch-file F` | JSONL 批量合成，每行 `{"text","output"}`，路径相对清单文件 |
| `scene-image SCENE -o F` | ComfyUI 生图 |
| `scene-video SCENE -o F [--image FRAME]` | ComfyUI 生视频 |
| `scene-narrate VIDEO SENTENCE WORD OUT` | 给视频配「整句 → 半秒 → 单词」旁白 |
| `scene-show FILE`、`scene-show --clear` | 开窗口看产物、关掉这些窗口 |

`tts synth` 可加 `--voice WAV --voice-text 文字稿`（两个必须同时给，文字稿要与音频一字不差）、
`--instruction`、`--seed`。

## 服务

ComfyUI 和 TTS 结构相同：socket 收到第一个请求时拉起 `systemd-socket-proxyd` 和后端，空闲
`idleTime`（默认 15 分钟）后一起退出，显存还回去。

- TTS 常驻约 8 GiB，和 ComfyUI 不能同时在显存里。`scene-*` 开工前先停 `tts-backend.service`。
- 反方向不杀任务：TTS 启动前查空闲显存，等 30 秒仍低于 `tts.requiredVram` 就拒绝启动。等待是因为
  ComfyUI 的 `/free` 先返回，权重几秒后才离开显存。
- 服务只绑回环。远程的 `tts` 用 `ssh -L` 把私有 unix socket 转发到服务端口。

RTX 5080 上的实测：冷启动约 35 秒，之后实时率约 0.8。不需要 flash-attn，上游的 `api.py`
写死了 eager 注意力。不要用 `--fast-all`，它要 14.4 GiB。

## 模型主机准备

模型代码和权重不进 flake，放在模块选项指定的目录：

```bash
git clone https://github.com/breezeblue-ai/breeze-tts.git ~/projects/breeze-tts
cd ~/projects/breeze-tts
uv venv -p 3.12 .venv
uv pip install -p .venv/bin/python -r requirements.txt
hf download BreezeBlue/Breeze-TTS-2 --local-dir ~/projects/breeze-tts-2
```

测试过的上游提交是 `daa6cb2`。

## Home Manager

```nix
imports = [ inputs.local-models.homeManagerModules.default ];
services.local-models = {
  enable = true;
  host = "gpu-host";
  comfyui = {
    directory = "/home/me/comfy";
    url = "https://gpu-host.example:18088";
  };
  tts = {
    directory = "/home/me/projects/breeze-tts";
    modelDirectory = "/home/me/projects/breeze-tts-2";
    voice = "${./voice.wav}";
    voiceText = "参考音频的准确文字稿";
  };
};
```

`host` 留空表示本机。包装脚本里的默认值可以用环境变量覆盖，显式设空的 `TTS_HOST` 表示本机。

## 开发

```bash
nix develop
bun install
bun run check
nix flake check
```

测试把外部程序（ssh、systemctl、mpv、nvidia-smi、模型服务）换成假的，真实地跑子进程和文件，
不需要 GPU。

## 许可

本仓库代码是 MIT。Breeze-TTS-2 的代码是 Apache 2.0，**权重和生成的音频仅限研究和非商业用途**，
本仓库不含权重。
