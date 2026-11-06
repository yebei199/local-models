---
name: local-models
description: Generate speech, images or video on the local GPU with the tts and scene-* commands. Load when making audio for Anki cards, voicing a video script, or generating images because Codex is out of quota.
---

# local-models

命令在每台主机上都能用：推理在模型主机上跑，产物写回调用方本机。

## 语音

```bash
tts synth --text T --output F.wav --lang en|ja|zh --use anki|video
tts batch --batch-file F.jsonl   # 每行 {"text","output","lang","use"}，路径相对清单文件
```

| `--use` | 用途 | en、zh | ja |
|---|---|---|---|
| `anki`（默认） | 自用制卡 | Breeze | Irodori |
| `video` | 公开视频 | Qwen3-TTS | Qwen3-TTS |

- `--lang` 默认 `en`，命令不看文本内容。日语不传 `--lang ja` 会交给没有日语的 Breeze，不报错，只是读错。
  纯汉字的日语词最容易漏，要按卡片语言传，不要按字面猜。
- 只要内容会公开发布就用 `--use video`。Breeze 的许可禁止任何变现内容，没有创作者例外。
- 一句话只走一个模型。中日英混排的句子按主语言传，读得不对就拆开分别生成。
- 音色已固定，不用传 `--voice`。传的话必须带逐字一致的 `--voice-text`。不要用声优或角色的声音做公开内容：
  模型许可不覆盖声音权利。
- 整篇口播用 `tts batch`，它按模型分组，每个模型只加载一次。
- 换模型后的第一句要 10 到 30 秒，之后每句 2 到 4 秒。这是正常冷启动，不是卡死；单次请求最多等 10 分钟。
- 转写和原文一致不代表好听，也查不出吞音。音质由用户试听判断。

| 报错 | 含义 | 处理 |
|---|---|---|
| `503` 和 `Only N MiB VRAM free` | 别的任务占着显卡 | 等它结束再试，不要停别人的任务 |
| `400` 和 `no route` | 这台模型主机没配该模型 | 告诉用户，不要换一个 `--use` 绕过 |

## 图和视频

用户平时用 Codex 生图，`scene-image` 只是没额度时的备用。

```bash
scene-image "SCENE" -o F.png [--width W --height H --seed N --raw]
scene-video "SCENE" -o F.mp4 [--image FIRST_FRAME --length N]
scene-narrate VIDEO SENTENCE.wav WORD.wav OUT.mp4   # 环境声后接整句、半秒停顿、单词
scene-show FILE                                     # 开窗口看产物，scene-show --clear 全部关掉
```

- 不加 `--raw` 时会自动套固定风格前缀。
- 视频帧数必须满足 `17k+5` 且不超过 209，默认 124。
- `scene-*` 开工前会停掉语音模型，之后第一句 `tts` 要重新冷启动，所以别把生图和制卡语音穿插着跑。
