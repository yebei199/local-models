# 翻译模型选型

用途是中日英互译：截图 OCR 出的短文本为主，偶尔整篇文档或字幕。要求质量优先，跑在 RTX 5080（16 GiB，
桌面程序常占 3.5 到 4 GiB）上，用户在美国，以后回新加坡。

## 当前选择

Hy-MT2-7B，Q8_0 GGUF（`tencent/Hy-MT2-7B-GGUF`），llama.cpp b12317 运行。许可是 Apache 2.0，没有地域限制。

| 项目 | 实测（2026-11-12，pc3） |
|---|---|
| 显存峰值 | 约 9.1 GiB（`-c 16384 -np 2 -fa on`，KV q8_0），`requiredVram` 取 10500 MiB |
| 加载 | 5.7 到 8 秒（权重在页缓存里） |
| 31 句逐条串行 | 合计 8.1 秒，短句 0.1 到 0.3 秒 |
| 16 条并发短句 | 1.9 秒 |

放不进 Breeze（9 GiB）旁边，所以和语音模型共用网关、轮流上卡。用户选了 7B 加轮流，没选能常驻共存的 1.8B。

## 对比

候选是同期两个翻译专用模型。TranslateGemma 12B 比 7B、8B 大，又被这两家各自的发布材料比下去，没进实测。

| 模型 | 许可 | 本地格式 | 显存 |
|---|---|---|---|
| Hy-MT2-7B（2026-05） | Apache 2.0 | Q8_0 GGUF 8.0 GB | 约 9.1 GiB |
| PLaMo 3 Translate 8B（2026-11-05） | PLaMo 社区许可，个人免费，商用有营收门槛 | GGUF 最高只发 Q4_K_M，5.3 GB | 约 5.5 GiB |

同一组 31 句（中日英六个方向，含 OCR 断行、俚语、敬语、成语、字幕、技术段落），各自用官方推荐的提示和采样，
交给 Codex 盲评（A/B 随机）：

| 结果 | Hy-MT2 | PLaMo |
|---|---|---|
| 胜 | 7 | 10 |
| 其中对方是严重错误 | 4 | 2 |
| 平 | 14 | 14 |

PLaMo 赢在语气和口语感（ツンデレ的结巴、`ビビリ`、`パクチー`、`press time`），多是小差别；它输的是意思：
把「検討させていただけますか」译成请对方考虑、把「内卷」译成社会分层、把「画蛇添足」直译成标题、把「明知还让我们
走进陷阱」译成主动设陷阱。Hy-MT2 的严重错误是把「猫の手も借りたい」直译、把 long tail 译成难题。质量优先先看意思，
所以选 Hy-MT2。

两者都没译对 `it's not not your fault` 的双重否定。样本只有 31 句，评委是另一个模型，结论只说明两者接近、
Hy-MT2 意思出错更少，不是定论。用户觉得哪类文本译得不好，再拿那类文本重比。

## 运行方式

- llama.cpp 用官方 CUDA 13 预编译包，经 nix-ld 在 NixOS 上运行。vLLM 能跑 FP8 版，但启动慢、按比例预占显存，
  对按需加载、空闲退出的服务不合适。
- 提示词照 Hy-MT2 模型卡：涉及中文时用中文提示，否则用英文提示，只写目标语言。所以不需要源语言，
  `auto` 的检测只用来回报。采样用官方推荐的 temperature 0.7、top_p 0.6、top_k 20、repetition_penalty 1.05。
- 两个槽、每槽 8192 token：批量时两条并行，单条装得下 3000 字符的原文加译文。

## 来源

- [Hy-MT2 模型卡](https://huggingface.co/tencent/Hy-MT2-7B-GGUF)，[报告](https://arxiv.org/abs/2605.22064)
- [PLaMo 3 Translate 8B GGUF 模型卡](https://huggingface.co/pfnet/plamo-3-translate-8b-GGUF)，[PFN 博客](https://www.preferred.jp/en/blog/tech/plamo-3-translate-weight-release)
- [TranslateGemma 技术报告](https://arxiv.org/abs/2601.09012)
