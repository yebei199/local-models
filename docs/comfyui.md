# 在浏览器里用 ComfyUI

写给第一次打开 ComfyUI 的人。读完能改参数、看懂节点图、自己搭新工作流。命令行的 `scene-image`、`scene-video`
不需要这些，它们提交的是 `src/workflows.json` 里冻结的图。

地址是 config.json 里的 `comfyui.url`（tailnet 上的 HTTPS 入口）。服务按需启动，第一次打开要等它加载。

## 三分钟跑出第一张图

左侧栏点 **Workflows**，选 `klein_t2i`。找到写着提示词的 `CLIP Text Encode` 节点，换成你想要的画面，
按 **Ctrl+Enter**。约 5 秒出图，文件落在模型主机的 `models/comfyui/data/output/`。

出视频选 `h3_t2v`，约 140 秒，因为是 124 帧而不是 1 帧。

提示词用英文：两个模型的文本编码器都以英文为主，中文能识别但差很多。

## 扩散模型在做什么

生成不是画出来的，是从纯噪声反复去噪得到的。模型学的是加噪的逆过程：给一张带噪的图和一段文字，预测该去掉哪些噪声。
生成时从随机噪声开始，每一步朝更符合文字的方向修一点，步数就是修几次。

所以每张图都要三样东西：随机噪声起点、文字条件、去噪模型。节点图上的每个节点都在为其中之一服务。

模型不在像素上去噪，而在宽高各缩 8 到 16 倍的潜空间里。VAE 负责像素和潜空间之间的翻译，所以工作流的最后几乎总是
`VAE Decode`：采样器吐出的是潜空间张量，不解码看不了。

## 五类节点

| 类 | 节点 | 作用 |
|---|---|---|
| 加载器 | `Load Diffusion Model`、`Load CLIP`、`Load VAE`、`Unet Loader (GGUF)` | 读权重，图的起点 |
| 条件 | `CLIP Text Encode`、`Conditioning Zero Out`、`Reference Latent` | 文字或参考图变成条件 |
| 采样准备 | `Random Noise`、`KSampler Select`、`Basic Scheduler` / `Flux2 Scheduler`、`Empty ... Latent`、`CFG Guider` / `Basic Guider` | 噪声、算法、步数表、画布尺寸、引导器 |
| 采样 | `Sampler Custom Advanced` | 唯一真正耗时的节点 |
| 输出 | `VAE Decode`、`Save Image`、`Create Video` + `Save Video` | 还原像素并存盘 |

ComfyUI 按类型连线，类型不对连不上。但类型对不代表能用：**文本编码器和 VAE 必须和扩散模型同源**。Klein 的编码器是
Qwen3-8B，H3 的是 Qwen3-VL-32B，两者都是 CLIP 类型，连得上，混用只会出噪声。

## 五个工作流

| 工作流 | 做什么 | 耗时 |
|---|---|---|
| `klein_t2i` | 文字出图 1024×1024 | 约 5 秒 |
| `klein_edit` | 一张图加文字描述，改成新样子 | 约 8 秒 |
| `h3_t2v` | 文字出视频 864×480，5 秒，带音轨 | 约 140 秒 |
| `h3_i2v` | 给首帧，让画面动起来 | 约 135 秒 |
| `h3_ref2v` | 给参考图，生成风格一致的视频 | 约 150 秒 |

要用自己的图，放进 `models/comfyui/data/input/`，再在 `Load Image` 的下拉框里选。

## 可以动的参数

- **提示词**：主要的创作入口。具体的名词和光线描述比形容词有效。
- **尺寸**：`Empty ... Latent` 的宽高，必须是 32 的倍数。Klein 在 1024×1024 附近最稳；H3 原生短边 768，864×480
  是显存和质量的折中。
- **种子**：`Random Noise` 的 `noise_seed`。种子和参数都相同就得到同一张，想复现就固定它。
- **视频长度**：`length`，单位帧，24fps，只接受 17k+5（5、22、39……124）。训练范围从 124 起，更短会掉质量。

## 不要动的参数

- **Klein 的 cfg 保持 1、步数保持 4。** 这是引导蒸馏版，几步出图且不需要负面引导；套 base 版的 cfg 5、20 步会过曝，
  还白烧十倍算力。`CFG Guider` 的 cfg 是 1、负面接 `Conditioning Zero Out`，就是蒸馏版的配置。
- **H3 帧数不超过 209。** 超过后采样跑完、解码时爆显存，前面几分钟白费。
- **采样器和调度器保持原样。** Klein 用 `euler`，H3 用 `res_multistep`，都是官方模板的选择。

## 出错了

- 节点套红框：点它看错误文字。
- `Prompt outputs failed validation`：下拉框选了不存在的文件，多半是权重没装全，在模型主机上重跑 `bun run setup`。
- 显存不足：调小尺寸或帧数，并确认没有别的任务占着显卡。H3 的两份权重加起来 28 GB。
- 采样跑完才失败：几乎都是解码阶段爆显存，见上面的帧数。

服务端日志比网页有用：`journalctl --user -u comfyui-backend -f`。

## 自己搭工作流

从复制一个最接近的开始（侧栏右键 Duplicate），按这个顺序想：

1. 输出是图还是视频，决定最后接 `Save Image` 还是 `Create Video` + `Save Video`。
2. 条件从哪来：纯文字是一个 `CLIP Text Encode`；参考图加 `Load Image` + `VAE Encode` + `Reference Latent`；
   视频首帧接到 `MiniMax H3 Image to Video` 的 `first_frame`。
3. 扩散模型、文本编码器、VAE 是否同源。
4. 采样那五个节点的接法在所有工作流里都一样，基本不用改。

侧栏的工作流目录链接到运行检出的 `comfyui/workflows/`，界面里保存就是改仓库文件，`git diff` 看得见。界面格式是真源：
它能在浏览器里编辑，侧栏也只认这种格式；API 格式只能在浏览器里手动导出，所以它是产物。

`klein_t2i`、`h3_i2v` 还是 `scene-image`、`scene-video` 的来源。改了它们就 `Workflow > Export (API)`，
把结果按 AGENTS.md 的工作流规则放回 `src/workflows.json`；`bun run check` 会指出两边哪里不一致。
界面和命令共用一个服务和一块显卡，不要同时提交大任务。
