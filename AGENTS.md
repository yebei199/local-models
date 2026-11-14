# AGENTS.md

## 项目目的

把一张消费级 GPU 上的语音合成、语音转文字、翻译、生图和生视频做成普通命令行工具，主要服务个人 Anki 制卡，也给公开视频配音、给 winnow 补视频字幕。
推理只在一台模型主机上跑，其他机器用同样的命令远程调用。显存放不下所有模型，所以服务按需启动、
空闲退出、互相避让。语音按用途和语言路由到不同模型，同一时间只有一个模型在显存里。

本仓库含命令、语音网关、模型适配脚本、systemd 单元、模型安装和测试。ComfyUI 和各语音模型装什么由本仓库钉死：
`src/manifest.ts` 写上游代码的提交、`locks/` 写冻结的 Python 环境、权重写 Hugging Face 仓库的提交，`src/install.ts`
按它装到 `models` 目录（默认 `~/.local/share/local-models/models`）。上游源码和权重本身不进仓库，只进钉住的版本。
它于 2026-11 从 nixos_config 迁出，之后不再用 nix：每台主机克隆一份检出，`bun run setup` 按本机的 config.json
装模型、服务和命令。nixos_config 只引用 `skills/`；explore 仓库不再参与部署。

命令用法、模型主机准备和安装配置见 [README.md](README.md)，这里不重复。TTS 模型试听结论见 [docs/tts-models.md](docs/tts-models.md)，翻译模型的见 [docs/translation-models.md](docs/translation-models.md)，语音转文字的见 [docs/asr-models.md](docs/asr-models.md)，音乐模型的见 [docs/music-models.md](docs/music-models.md)（音乐不进本仓库的命令，只在 pc3 上试跑）。

## 使用场景

设计取舍以这些实际用法为准，不为没有的场景加复杂度。

| 场景 | 用法 | 对设计的要求 |
|---|---|---|
| Anki 制卡 | 一种语言连续做几十分钟（比如先英文，再日语），期间不快速换语言。卡片一张一张做，每张之间隔 2 到 10 分钟，用来和 AI 讨论这张卡 | 模型要撑过卡片之间的间隔；换语言时冷切换一次可以接受 |
| 公开视频口播 | 写好整篇稿子，一次性批量生成多句 | `tts batch` 整批完成；不需要实时或流式 |
| 字幕转录 | winnow 的工人（在 pc1）对下不到字幕的视频调 `asr transcribe`，每天几个到几十个，单个几分钟到两小时，串行排队 | 同步阻塞即可；中英日混说要逐段判断语言；和语音、翻译轮流占显存 |
| 翻译 | 截图 OCR 出的短文本在各主机的 Dialect 里翻译，量大；偶尔整篇文档或字幕用 `translate` | 优先质量；和语音模型轮流占显存，切换代价可以接受 |
| 生图 | 平时用 Codex 生图，没额度时才用本地模型 | 备用路径，保持可用即可，不为它常驻显存 |
| 生视频 | 很少用，暂无明确用途 | 保留现有功能，不扩展也不删除 |

由此得出：语音模型之间不做常驻共存或权重驻留内存，冷切换加批量分组已经够用。真正影响制卡体验的是
空闲回收：两张卡之间的间隔超过 `idleTime`，下一张就要重新加载模型。所以 `idleTime` 默认 30 分钟，
给最长 10 分钟的间隔留出余量，不要调到 10 分钟以下。

## 运行结构

```text
任意主机                          模型主机（systemd --user）
tts、asr ── ssh -L unix socket ─► tts.socket 127.0.0.1:8290
                                    └ tts.service（socket-proxyd）
                                        └ tts-backend.service :8291（model-gate，语音和语音转文字）
Dialect、translate ── tailnet HTTPS :18098 ► Caddy ► translate.socket 127.0.0.1:8098
                                    └ translate.service（socket-proxyd）
                                        └ 同一个 tts-backend.service :8293（model-gate，LibreTranslate 接口）
                                            └ 当前模型 :8292（Breeze、Ming、Irodori、Qwen、Qwen3-ASR 或 llama-server）

scene-image/video ─── HTTP(S) ► comfyui.socket 127.0.0.1:8088
  │                                 └ comfyui.service（socket-proxyd）
  │                                     └ comfyui-backend.service :8089（ComfyUI）
  └── ssh systemctl stop ───────► tts-backend.service（开工前腾显存）

scene-narrate、scene-show         在调用方本机运行，只用 ffmpeg 和 mpv

浏览器 ── tailnet HTTPS :18096 ──► Caddy ──► local-models-web.service 127.0.0.1:8096（model-web）
                                               └ 页面目录：每个试听一个 .html，或一个带 audition.json / index.html 的目录
```

- 第一个连接触发 socket，front 依赖 backend，`model-wait` 等端口绑定后 front 才开始转发。
- 空闲 `idleTime` 后 proxyd 退出，backend 随 `StopWhenUnneeded` 停止，显存归还。
- model-gate 按 `use` 和 `language` 选模型，串行处理请求；换模型时先停旧的，查过显存再启动新的。
  网关退出时带走模型，所以空闲回收和 `scene-*` 的避让都只需要停 `tts-backend.service`。
- 翻译和语音共用这个网关和队列：翻译模型放不进语音模型旁边，轮流是唯一不杀任务的做法。单元名仍叫 `tts-*`，
  改名要在模型主机上手动停旧单元，代价大于收益。两个前端各有空闲计时，都退出后网关才停。
- 翻译接口单独一个端口（8293，前端 8098）：只有它经 Caddy 进 tailnet，语音端口仍只在回环、走 ssh。
  接口照 LibreTranslate 的形状（`/translate`、`/languages`、`/detect`、`/spec`、`/frontend/settings`），
  因为客户端是 Dialect，只能填实例地址。tailnet 内不鉴权，和 ComfyUI、试听页一样。
- 所有语音模型都讲 Breeze 的协议：multipart 的 `text`、`ref_text`、`ref_audio`，返回裸 PCM 和
  `X-Sample-Rate`。`engines/` 把 Qwen、Irodori 和 Ming 包成这个协议，网关才不用区分模型。
- 语音转文字也走这个网关和语音端口（`POST /v1/audio/transcriptions`，multipart 的 `file` 和可选 `language`），
  因为调用方和 `tts` 一样在别的主机经 ssh 来，不进 tailnet。网关先把整个上传读完再排队：排队期间让连接挂着，
  调用方的上传会卡住。音频由引擎用 ffmpeg 从临时文件解码，yt-dlp 的 m4a 可能把索引放在末尾，管道读不到。
- 固定音色在模型主机上，按 `use` 和 `language` 各配一条同语言参考，由网关补进请求，调用方不必携带音频。
  克隆会照搬参考的语气，所以视频用讲故事的参考，制卡用安静的参考。
- TTS 只绑回环，远程必须走 ssh 转发。ComfyUI 不走 ssh：客户端访问 `COMFYUI_URL`，backend 额外
  监听 Tailscale 地址，取不到地址时退回只绑回环。
- `isLocal(host)` 决定走本机还是 ssh：空字符串和模型主机自己的主机名都算本机。
- 试听结果通过 web 服务交付，不让用户开本地 HTML。把页面放进 `web.directory` 就发布了，首页自动列出，
  服务不用重启。它不碰模型和显存，所以常驻，不走 socket 和空闲回收。

## 文件架构

```text
package.json            依赖和脚本：check、build、setup（install.ts 再 setup.ts）、verify
locks/                  各组件 venv 的 uv pip freeze，在模型主机上验证过的环境
comfyui/
  workflows/            界面格式工作流，是真源；install 把 ComfyUI 侧栏的工作流目录链接到这里，biome 不格式化它
engines/
  common.py             Breeze 协议的 HTTP 服务，只用标准库和 numpy
  qwen.py、irodori.py、ming.py  各模型的加载和合成，跑在模型自己的 .venv 里
                        翻译模型不在这里：llama-server 本身讲 OpenAI chat 协议，网关直接调用
  asr.py                Qwen3-ASR：fsmn-vad 切段、逐段识别和判语言、对齐器按句末切行；收上传音频，回 JSON
  mingtiny.py           Ming tiny：专家权重流式量化到 int8；文件名不能叫 ming_tiny.py，会遮住上游同名包
skills/
  local-models/SKILL.md 给 AI 用的命令说明，由 nixos_config 链接安装；改命令或路由时同步更新
  model-weights/SKILL.md 权重下载来源的实测结论和核对方法，同样由 nixos_config 安装
docs/
  tts-models.md         TTS 模型试听结论和当前选择
  translation-models.md 翻译模型的对比、实测和当前选择
  asr-models.md         语音转文字模型的对比、浏览器路线结论和接口
  music-models.md       音乐模型试听和测量记录，以及云端服务的调查
  comfyui.md            浏览器里用 ComfyUI：节点、参数、五个工作流、自己搭图
audition/
  index.html            音色对比页；清单和音频留在模型主机，不进仓库
src/
  host.ts               isLocal：本机与 ssh 的唯一判定
  endpoint.ts           connect：本机直连网关前端，其他主机经 ssh 转发 unix socket；tts 和 asr 共用
  tts.ts                tts 命令：synth 和 batch，batch 按模型分组
  asr.ts                asr 命令：上传音频，收齐整个 JSON 才写文件
  gate.ts               model-gate：路由、串行队列、模型启停；语音和翻译各一个端口
  libre.ts              网关的 LibreTranslate 接口：校验、语言检测、Hy-MT2 的提示词
  translate.ts          translate 命令：文本、文档按段、字幕按条，整篇译完才写文件
  wav.ts                给模型返回的裸 PCM 加 WAV 头
  scene.ts              scene-image、scene-video：提交 ComfyUI 工作流、取回产物、释放权重
  workflows.json        冻结的 image（Flux2 Klein GGUF）、video（MiniMax H3）节点图及风格前缀，由 klein_t2i、h3_i2v 导出
  narrate.ts            scene-narrate：用 ffmpeg 拼环境声、整句、单词旁白
  show.ts               scene-show：开 mpv 窗口，只关自己记录过的进程组
  backend.ts            单元用的 start（启动 ComfyUI）、wait（等端口）、vram（显存守卫）
  config.ts             config.json 的类型、校验和路径，install 和 setup 共用；旧的路径键按名字报错
  manifest.ts           每个组件钉住的代码、环境、权重，以及它们在 models 下的位置（paths）
  install.ts            按 manifest 检出代码、同步 venv、下载并校验权重；跳过后端正在运行的组件
  setup.ts              读 config.json，写出 systemd 单元、网关配置 gate.json 和 ~/.local/bin 下的命令
  web.ts                model-web：托管前端构建产物和 /api，发布页面目录、读机器状态、支持 Range
  audition.ts           audition.json 和 /api 的类型，服务端和前端共用
web/                    前端：React 19、TanStack Router 和 Query、Tailwind 4，Vite 构建
  src/components/       player.tsx 是全站唯一的播放器；ui/ 照 meow_web 的 cva 写法
  src/routes/           首页和试听页
  tests/                组件测试，happy-dom
tests/
  helpers.ts            黑盒工具：真实子进程和临时目录，fakeTool 在 PATH 上放假程序
  *.test.ts             与 src 入口一一对应；wav 和 host 经 tts、scene 覆盖
```

`setup.ts` 的入口映射：命令 `translate` 是 `translate.ts`，命令 `asr` 是 `asr.ts`；命令 `scene-image`、`scene-video` 都是 `scene.ts`；单元直接用 bun 跑
`backend.ts start`、`backend.ts wait`、`gate.ts`、`web.ts`，这些不进用户 PATH。各模型的启动命令也由 `setup.ts`
写进网关配置 `GATE_CONFIG`，路径全由 `manifest.ts` 的 `paths` 推出，config.json 只列这台主机跑哪些引擎。

## 验证

```bash
bun run check   # biome、tsc、bun test，不需要 GPU
bun run build   # 前端构建到 web/dist；开发时 cd web && bunx vite，/api 代理到本机 8096
```

前端改动要在浏览器里看过渲染结果；
本地起服务：`PORT=8396 WEB_DIR=目录 WEB_UI=web/dist bun src/web.ts`。测试不碰真实 GPU 和
模型，改动服务行为后要到模型主机上实跑才算验证过。

## 不能破坏的约束

**显存**

- 语音模型不能和 ComfyUI 同时在显存里。`scene-*` 开工前停 `tts-backend.service`，失败只告警。
- 反方向绝不杀任务：网关启动模型前查空闲显存，低于该模型的 `requiredVram` 就拒绝请求。
- 显存检查必须等待而不是查一次：ComfyUI 的 `/free` 先返回，权重几秒后才离开显存。
- 不要给 Breeze 加 `--fast-all`，它要 14.4 GiB。

**systemd 单元**

- `setup` 只 `enable --now`，从不重启或停止模型单元，包括 socket：重启 socket 会经 `Requires` 带停后端，
  正在跑的任务就丢了。定义变了的运行中单元只提示。代价是改端口后要手动重启 socket。网页服务例外，每次都重启。
- 只给 config.json 里写了的服务装单元，主机之间的差别全在 config.json，不在代码里按主机分支。
- `setup` 不覆盖没有它标记行的同名文件：切换期间 Home Manager 的旧单元还在时，宁可报错也不抢。
- 单元里的程序路径写 profile 链接（`/run/current-system/sw/...`、`/etc/profiles/...`），不解析成 `/nix/store`：
  系统升级后链接跟着走，store 路径在 setup 重跑前就可能被回收。
- `SuccessExitStatus=143` 不能删，后端收到 SIGTERM 的退出不是故障。

**端口**

- 翻译前端 8098 有意落在段内，tailnet 入口是 18098，Dialect 填的就是它；网关的翻译端口 8293 在段外。
- 新服务的回环端口要避开 3000-3099、5100-5199、7800-7899、8000-8199：这些段会被 tailnet-https
  自动暴露，对应的 +10000 端口也被它占用。TTS 的 8290/8291 就是因此选的。ComfyUI 的 8088 在段内，
  这是有意的，`url` 示例里的 18088 就是它的 tailnet 入口。web 的 8096 同理，入口是 18096。
- web 服务只绑回环，不要绑 tailnet 地址：常驻服务开机时 tailscaled 可能还没起来，TLS 和 tailnet 入口都交给 Caddy。

**命令与包装**

- 命令和单元里入口后的 `--` 不能省，否则 bun 吞掉第一个 `--`；`tests/helpers.ts` 的 `run` 要
  保持相同调用方式。
- 命令脚本里的环境变量用 `${X-默认}` 导出，显式设空的 `TTS_HOST` 表示本机。不要改成 `:-`，TS 侧也要用 `??`。
- 失败不能留下半截产物：`tts` 收完整个流才写文件；`batch` 全部校验通过后才开始占用 GPU。
- 排队只在网关里做，调用方看不到单 GPU 限制。
- 命令和单元里的 `NO_PROXY` 不能删：bun 的 fetch 会走代理变量，回环请求经代理会得到 502。
- 模型环境要有 `TRITON_LIBCUDA_PATH`：NixOS 没有 `/sbin/ldconfig`，Qwen 首次合成会失败。
- 声音必须同时有音频和逐字一致的文字稿，只给一个是错误。
- `--lang` 必填且不做自动检测：短词无法判断语言，猜错不报错，只会生成读错的音频。
- 视频帧数必须满足 `17k+5` 且不超过 209，这是 H3 解码的限制。
- 翻译的 `charLimit`（3000 字符）和 llama-server 每个槽的 8192 token 是一对：Dialect 按 charLimit 截断输入，
  原文加译文要装进一个槽。改一个就要算另一个。`translate` 命令把长文按段落和行切到这个限度以内。
- 翻译模型不要求 `--lang`：Hy-MT2 的提示词只写目标语言。`source=auto` 时的检测（有假名是日语，纯汉字是中文）
  只用来回报 `detectedLanguage` 和选提示词的语言，猜错不影响译文。
- seed 是任意精度整数，经 `JSON.rawJSON` 发送，不要转成 `Number`。

**安装**

- 不碰正在运行的组件：`comfyui-backend` 或 `tts-backend` 在跑时，`install` 跳过对应组件，空闲后重跑 setup。
  在运行中的进程下面换代码或 venv，跑着的任务会断。
- 改钉住的版本（提交、lock、权重 revision）后，要在模型主机上实跑对应的命令才算验证过；lock 用
  `uv pip freeze` 从验证过的 venv 导出，不手写。
- 目标文件只放校验过的下载：先写 `.part` 续传，哈希对上才改名。`bun run verify` 重算全部哈希。
- 权重按大小判断已有，不每次重算几十 GB 的哈希。下载地址走 `HF_ENDPOINT`，源和代理路径按模型主机实测选择，不从用户或 VPS 所在地推断。
- llama.cpp 用官方发布的 CUDA 13 预编译包（`manifest.ts` 的 `release`，钉 sha256），靠模型主机的 nix-ld 运行；
  在 NixOS 上编译要 nvcc，主机上没有。包里自带 cudart 和 cuBLAS，驱动来自 `cudaLibraryPath`。
- ComfyUI 用 `--base-directory`：`code/` 是纯净的上游检出，`data/` 放模型、自定义节点、输入输出和用户数据，换版本不动数据。
- 检出有本地改动时 install 报错停下，不覆盖。

**工作流**

- `workflows.json` 是冻结数据，只由 `scene.ts` 的 `workflow` 改写固定节点：`10` 的 seed；image 的
  `4`、`6`、`7`；video 的 `6`，以及带首帧时注入的 `5`。
  改图时节点 id 要同步。
- `comfyui/workflows/` 的界面格式是真源，`tests/workflows.test.ts` 检查 `workflows.json` 和它的节点、连线、固定参数一致。
  改了界面格式就在浏览器里重新导出 API 格式，再按上面的规则改回 `workflows.json`。

**许可与内容**

- 代码是 GPL-3.0-only。Breeze 权重和输出仅限研究和非商业用途，所以 `video` 路由不能指向它。
- 音频和参考声音不进仓库。

**web 页面**

- 所有页面共用这一个端口，不为新页面另开端口或临时 HTTP 服务。
- 新的对比试听写 `audition.json` 让服务渲染，不要手写 HTML；歌曲试听把歌词和中文翻译写进 `lyrics`。共用播放器保证一次只响一段。一行是一个对象和它实际有的版本，
  缺的版本不写，不留占位。已删除的模型不留在页面上。
- 切换版本总是从头播放，不要加进度同步：同一句的两个版本语速和停顿不同，同步过去的位置落在别处，反而没法对比重读。
- 页面目录里的文件 tailnet 上都读得到。盲听的版本对应表和量测数据放在目录外，点开头的路径只是兜底。
- 音频必须支持 Range 并返回 `Cache-Control: no-cache`，否则浏览器不能拖动，改过的页面也会读到旧缓存。
- 改了 `web.ts` 或 `web/` 后重跑 `bun run setup`，它会重新构建前端并重启网页服务。
- 试听目录的地址就是它在页面目录里的路径（`/voices/`），服务端发前端外壳，前端从 `/api/auditions/voices`
  取数据。音频路径相对这个地址解析，所以目录要带结尾斜杠。`/api/` 和 `/assets/` 归服务本身，页面目录里同名的路径读不到。

## 代码约定

- 前端依赖只在构建时用。服务端（`src/`）仍然没有运行时依赖，这是现状不是规则。
- bun 和外部程序用主机上装好的，版本不由仓库锁定；靠 `bun run check` 发现差异。
- biome 把警告当错误，认知复杂度上限 15，行宽 100。
- 每个 `src` 文件首行用一句话写用途，函数的 `/** */` 写为什么这样做，不复述代码。TS 注释用英文。
- 外部程序都以子进程调用，测试才能在 PATH 上替换。服务端新用到的外部程序要加进 `setup.ts`（安装用的加进 `install.ts`）的前置检查，
  它也决定单元的 PATH。
- 具体主机的值（主机名、目录、参考音频）在各主机的 config.json，不进本仓库。
