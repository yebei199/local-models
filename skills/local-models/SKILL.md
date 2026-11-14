---
name: local-models
description: Generate speech, transcripts, translations, images or video on the local GPU with the tts, asr, translate and scene-* commands. Load when making audio for Anki cards, voicing a video script, transcribing audio into timed subtitles, translating zh/ja/en text, documents or subtitles locally, or generating images because Codex is out of quota.
---

# local-models

命令在每台主机上都能用：推理在模型主机上跑，产物写回调用方本机。

## 语音

```bash
tts synth --text T --output F.wav --lang en|ja|zh --use anki|video
tts batch --batch-file F.jsonl   # 每行 {"text","output","lang","use"}，可选 "instruction"、"seed"（字符串）；路径相对清单文件
```

| `--use` | 用途 | en、zh | ja |
|---|---|---|---|
| `anki`（默认） | 自用制卡 | Breeze | Irodori |
| `video` | 公开视频 | en：Ming，zh：Ming tiny | Ming |

- `--lang` 必填，命令不检测语言。按卡片或稿子的语言传，不要按字面猜：`学校` 这样的纯汉字词字面上分不出日语和中文。
- 只要内容会公开发布就用 `--use video`。Breeze 的许可禁止任何变现内容，没有创作者例外。
- 一句话只走一个模型，`--lang` 传主语言。这些实测不用切分：中文夹英文和缩写、日语夹英文缩写和常见外来语、
  单词或短语单独生成。
- 日语里的生僻英文词 Irodori 会读错（`resilient`），写成片假名（`レジリエント`）就对了。
- 英语或中文句子里夹日语、英语句子里夹中文读不准，要拆开，单词放到卡片自己的字段里分别生成。
- 不到一秒的单词音频最不稳：Qwen 曾把单独的 `図書館` 读错。这类音频要让用户听一下。
- 音色已按用途和语言固定，不用传 `--voice`。传的话必须带逐字一致的 `--voice-text`。不要用声优或角色的声音做公开内容：
  模型许可不覆盖声音权利。
- 整篇口播用 `tts batch`，它按模型分组，每个模型只加载一次。
- 视频中文口播每行带同一条表演指令，例如 `像给朋友讲一个有转折的故事，有快有慢，句子之间节奏变化明显，关键词加重。`
  指令只写语气和节奏，不写音色、音区或年龄：音色来自固定参考，写了会把表演压平。不带指令时只照搬参考的语气。
- 每行是一个文件，也是模型一次看到的全部上下文。要语气连贯的两三句放在同一行，不要整段放一行：太长会超出模型上限。
- 不要把模型自己的输出当参考喂回去续写，前后会变成不同的人或出现恐怖谷。
- 换模型后的第一句要 10 到 30 秒，之后每句 2 到 4 秒。Ming tiny 的冷启动要 1 到 2 分钟，之后每秒音频约 1.3 秒。
  这是正常冷启动，不是卡死；单次请求最多等 10 分钟。
- 转写和原文一致不代表好听，也查不出吞音。音质由用户试听判断。
- 试听交付给 URL，不要给文件路径，也不要用 `xdg-open`（这里只弹应用选择器）。把一个 `.html` 或带 `index.html` 的目录放进模型主机的
  `~/.local/share/local-models/web`，不用重启，地址是模型主机 tailnet 域名的 `https://…:18096/`。交付前 `curl` 确认能访问。
- 这个目录全部可读：盲听的版本对应表和量测数据放在目录外，页面里只留匿名标签。

| 报错 | 含义 | 处理 |
|---|---|---|
| `503` 和 `Only N MiB VRAM free` | 别的任务占着显卡 | 等它结束再试，不要停别人的任务 |
| `400` 和 `no route` | 这台模型主机没配该模型 | 告诉用户，不要换一个 `--use` 绕过 |

## 翻译

```bash
translate --to en|ja|zh [--from auto|en|ja|zh] "TEXT"   # 译文到标准输出；不给 TEXT 读标准输入
translate --to zh -i IN.srt -o OUT.srt                  # 文档按段落、.srt/.vtt 按条，整篇译完才写文件
```

- 模型是 Hy-MT2-7B，只开放中日英三种语言。`--from` 默认 `auto`，不影响译文，提示词只写目标语言。
- 和 TTS 共用显卡、轮流加载：翻译后第一句 `tts` 要重新冷启动，制卡时成批翻译、成批配音比交替快。
- 单段超过 3000 字符会按行切；单行超过 3000 字符直接报错，先自己断句。
- 字幕逐条翻译，条与条之间没有上下文，代词和省略可能译偏，公开发布前要人看。
- 用户的 Dialect 走同一个接口（`https://模型主机:18098`，LibreTranslate 格式），报 `503 Only N MiB` 是 ComfyUI
  占着卡，不要停它。

## 语音转文字

```bash
asr transcribe AUDIO -o OUT.json [--lang en|ja|zh]   # 任意 ffmpeg 能读的音频；整段转完才写文件
```

- 输出 `{lang, model, duration, segments:[{from, to, text, lang}]}`，秒为单位，句末断行，每行最长 15 秒。
- 不给 `--lang` 就逐段自动判断语言，混说的视频直接交给它；给了就强制按该语言转写。
- 没有人声时 `segments` 为空、退出码 0；失败非零退出，不留文件。
- 模型是 Qwen3-ASR，数字常写成汉字（「六十帧」），游戏、专业名词偶有同音错字，要发布的字幕需人看。
- 和 TTS、翻译轮流用显卡，`503 Only N MiB` 的处理同上。

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
- `scene-video` 的产物不进公开视频：MiniMax H3 的许可排除美国、欧盟、英国、韩国，并禁止在这些地区展示生成结果。
- `scene-image` 的 flux-2-klein-9b 在 Hugging Face 标为非商用许可，全文要登录才能读，还没核对过。
  公开内容出图用 Codex；要用 `scene-image` 出公开内容，先读许可全文。
