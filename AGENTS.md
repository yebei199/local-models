# AGENTS.md

## 项目目的

把一张消费级 GPU 上的语音合成、生图和生视频做成普通命令行工具，主要服务个人 Anki 制卡，也给公开视频配音。
推理只在一台模型主机上跑，其他机器用同样的命令远程调用。显存放不下所有模型，所以服务按需启动、
空闲退出、互相避让。语音按用途和语言路由到不同模型，同一时间只有一个模型在显存里。

本仓库含命令、语音网关、模型适配脚本、systemd 单元和测试。ComfyUI 和各语音模型的代码、权重在仓库外，
由模块选项指向；ComfyUI 的环境安装、权重下载和工作流原件还在 explore 仓库（`setup_env.sh`、
`download_models.sh`、`workflows/`），Breeze 靠 README 里的手工步骤。它于 2026-11 从 nixos_config 迁出，nixos_config 以 flake input 引用它，只提供宿主相关的输入。

命令用法、模型主机准备和 Home Manager 配置见 [README.md](README.md)，这里不重复。TTS 模型试听结论见 [docs/tts-models.md](docs/tts-models.md)。

## 使用场景

设计取舍以这些实际用法为准，不为没有的场景加复杂度。

| 场景 | 用法 | 对设计的要求 |
|---|---|---|
| Anki 制卡 | 一种语言连续做几十分钟（比如先英文，再日语），期间不快速换语言。卡片一张一张做，每张之间隔 2 到 10 分钟，用来和 AI 讨论这张卡 | 模型要撑过卡片之间的间隔；换语言时冷切换一次可以接受 |
| 公开视频口播 | 写好整篇稿子，一次性批量生成多句 | `tts batch` 整批完成；不需要实时或流式 |
| 生图 | 平时用 Codex 生图，没额度时才用本地模型 | 备用路径，保持可用即可，不为它常驻显存 |
| 生视频 | 很少用，暂无明确用途 | 保留现有功能，不扩展也不删除 |

由此得出：语音模型之间不做常驻共存或权重驻留内存，冷切换加批量分组已经够用。真正影响制卡体验的是
空闲回收：两张卡之间的间隔超过 `idleTime`，下一张就要重新加载模型。所以 `idleTime` 默认 30 分钟，
给最长 10 分钟的间隔留出余量，不要调到 10 分钟以下。

## 运行结构

```text
任意主机                          模型主机（systemd --user）
tts ── ssh -L unix socket ──────► tts.socket 127.0.0.1:8290
                                    └ tts.service（socket-proxyd）
                                        └ tts-backend.service :8291（model-gate）
                                            └ 当前模型 :8292（Breeze、Ming、Irodori 或 Qwen）

scene-image/video ── HTTP(S) ───► comfyui.socket 127.0.0.1:8088
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
- 所有模型都讲 Breeze 的协议：multipart 的 `text`、`ref_text`、`ref_audio`，返回裸 PCM 和
  `X-Sample-Rate`。`engines/` 把 Qwen、Irodori 和 Ming 包成这个协议，网关才不用区分模型。
- 固定音色在模型主机上，每种语言一条同语言参考，由网关按 `language` 补进请求，调用方不必携带音频。
- TTS 只绑回环，远程必须走 ssh 转发。ComfyUI 不走 ssh：客户端访问 `COMFYUI_URL`，backend 额外
  监听 Tailscale 地址，取不到地址时退回只绑回环。
- `isLocal(host)` 决定走本机还是 ssh：空字符串和模型主机自己的主机名都算本机。
- 试听结果通过 web 服务交付，不让用户开本地 HTML。把页面放进 `web.directory` 就发布了，首页自动列出，
  服务不用重启。它不碰模型和显存，所以常驻，不走 socket 和空闲回收。

## 文件架构

```text
flake.nix               包、Home Manager 模块、checks、formatter、devShell 的入口
nix/
  package.nix           把 src/*.ts 包成 bun 命令；注入环境变量默认值和运行时 PATH
  home-module.nix       services.local-models 选项；socket、front、backend 三层用户单元
  checks.nix            nix flake check 的门禁：format、lint、types、test
engines/
  common.py             Breeze 协议的 HTTP 服务，只用标准库和 numpy
  qwen.py、irodori.py、ming.py  各模型的加载和合成，跑在模型自己的 .venv 里
skills/
  local-models/SKILL.md 给 AI 用的命令说明，由 Home Manager 模块安装；改命令或路由时同步更新
  model-weights/SKILL.md 权重下载来源的实测结论和核对方法，同样由模块安装
docs/
  tts-models.md         模型试听结论和当前选择
audition/
  index.html            音色对比页；清单和音频留在模型主机，不进仓库
src/
  host.ts               isLocal：本机与 ssh 的唯一判定
  tts.ts                tts 命令：连接网关、synth 和 batch，batch 按模型分组
  gate.ts               model-gate：路由、串行队列、模型启停
  wav.ts                给模型返回的裸 PCM 加 WAV 头
  scene.ts              scene-image、scene-video：提交 ComfyUI 工作流、取回产物、释放权重
  workflows.json        冻结的 image（Flux2 Klein GGUF）和 video（MiniMax H3）节点图及风格前缀
  narrate.ts            scene-narrate：用 ffmpeg 拼环境声、整句、单词旁白
  show.ts               scene-show：开 mpv 窗口，只关自己记录过的进程组
  backend.ts            单元用的 start（启动 ComfyUI）、wait（等端口）、vram（显存守卫）
  web.ts                model-web：发布页面目录、读机器状态、支持 Range
  pages.ts              首页和试听页的渲染，定义 audition.json 的结构
  web/                  page.css 和 player.js，所有生成页共用
tests/
  helpers.ts            黑盒工具：真实子进程和临时目录，fakeTool 在 PATH 上放假程序
  *.test.ts             与 src 入口一一对应；wav 和 host 经 tts、scene 覆盖
```

`package.nix` 的入口映射：`scene-image` 和 `scene-video` 都是 `scene.ts`，`comfyui-backend`、
`model-wait` 都是 `backend.ts`，`model-gate` 是 `gate.ts`，`model-web` 是 `web.ts`，这四个通过 `passthru.service` 只给单元用，
不进用户 PATH。模型的启动命令由 `home-module.nix` 写进网关配置 `GATE_CONFIG`。

## 验证

```bash
nix develop -c bun run check   # biome、tsc、bun test，不需要 GPU
nix flake check                # 沙箱门禁，额外检查 nixfmt
```

flake 只看 git 已跟踪的文件，新文件要先 `git add` 才进 `nix flake check`。测试不碰真实 GPU 和
模型，改动服务行为后要到模型主机上实跑才算验证过。

## 不能破坏的约束

**显存**

- 语音模型不能和 ComfyUI 同时在显存里。`scene-*` 开工前停 `tts-backend.service`，失败只告警。
- 反方向绝不杀任务：网关启动模型前查空闲显存，低于该模型的 `requiredVram` 就拒绝请求。
- 显存检查必须等待而不是查一次：ComfyUI 的 `/free` 先返回，权重几秒后才离开显存。
- 不要给 Breeze 加 `--fast-all`，它要 14.4 GiB。

**systemd 单元**

- 所有单元都带 `X-SwitchMethod = "keep-old"`，包括 socket：重启 socket 会经 `Requires` 带停后端，
  部署会杀掉正在跑的任务。代价是改端口后要手动重启 socket。
- 每台主机声明同样的单元，没装模型的主机靠 `Condition*` 跳过。不要改成按主机分支。
- `SuccessExitStatus = [ 143 ]` 不能删，后端收到 SIGTERM 的退出不是故障。

**端口**

- 新服务的回环端口要避开 3000-3099、5100-5199、7800-7899、8000-8199：这些段会被 tailnet-https
  自动暴露，对应的 +10000 端口也被它占用。TTS 的 8290/8291 就是因此选的。ComfyUI 的 8088 在段内，
  这是有意的，`url` 示例里的 18088 就是它的 tailnet 入口。web 的 8096 同理，入口是 18096。
- web 服务只绑回环，不要绑 tailnet 地址：常驻服务开机时 tailscaled 可能还没起来，TLS 和 tailnet 入口都交给 Caddy。

**命令与包装**

- `package.nix` 里入口后的 `--` 不能省，否则 bun 吞掉第一个 `--`；`tests/helpers.ts` 的 `run` 要
  保持相同调用方式。
- 环境变量用 `${X-默认}` 导出，显式设空的 `TTS_HOST` 表示本机。不要改成 `:-`，TS 侧也要用 `??`。
- 失败不能留下半截产物：`tts` 收完整个流才写文件；`batch` 全部校验通过后才开始占用 GPU。
- 排队只在网关里做，调用方看不到单 GPU 限制。
- `package.nix` 的 `NO_PROXY` 不能删：bun 的 fetch 会走代理变量，回环请求经代理会得到 502。
- 模型环境要有 `TRITON_LIBCUDA_PATH`：NixOS 没有 `/sbin/ldconfig`，Qwen 首次合成会失败。
- 声音必须同时有音频和逐字一致的文字稿，只给一个是错误。
- `--lang` 必填且不做自动检测：短词无法判断语言，猜错不报错，只会生成读错的音频。
- 视频帧数必须满足 `17k+5` 且不超过 209，这是 H3 解码的限制。
- seed 是任意精度整数，经 `JSON.rawJSON` 发送，不要转成 `Number`。

**工作流**

- `workflows.json` 是冻结数据，只由 `scene.ts` 的 `workflow` 改写固定节点：`10` 的 seed；image 的
  `4`、`6`、`7`；video 的 `6`，以及带首帧时注入的 `5`。改图时节点 id 要同步。

**许可与内容**

- 代码是 GPL-3.0-only。Breeze 权重和输出仅限研究和非商业用途，所以 `video` 路由不能指向它。
- 音频和参考声音不进仓库。

**web 页面**

- 所有页面共用这一个端口，不为新页面另开端口或临时 HTTP 服务。
- 新的对比试听写 `audition.json` 让服务渲染，不要手写 HTML：共用播放器保证一次只响一段，同一行切版本时保持进度。
- 页面目录里的文件 tailnet 上都读得到。盲听的版本对应表和量测数据放在目录外，点开头的路径只是兜底。
- 音频必须支持 Range 并返回 `Cache-Control: no-cache`，否则浏览器不能拖动，改过的页面也会读到旧缓存。
- 单元是 `keep-old`，改了 `web.ts` 部署后要手动重启 `local-models-web.service`。

## 代码约定

- 目前没有运行时依赖，这是现状不是规则，需要时直接引入。`nix/package.nix` 现在只打包 `src`，加运行时依赖时
  要让包带上 `node_modules`。
- 改 `bun.lock` 后要更新 `nix/checks.nix` 里的 `outputHash`。
- biome 把警告当错误，认知复杂度上限 15，行宽 100。Nix 用 nixfmt。
- 每个 `src` 文件首行用一句话写用途，函数的 `/** */` 写为什么这样做，不复述代码。TS 注释用英文，
  Nix 注释用中文。
- 外部程序都以子进程调用，测试才能在 PATH 上替换。新增外部依赖时同步加入 `package.nix` 的 `path`，
  只测试用的工具加入 `flake.nix` 的 devShell 和 `checks.nix`。
- 具体主机的选项值（主机名、目录、参考音频）在 nixos_config，不进本仓库。
