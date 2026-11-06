"""Qwen3-TTS Base: voice cloning in English, Japanese and Chinese."""

import common
import torch
from qwen_tts import Qwen3TTSModel

LANGUAGES = {"en": "English", "ja": "Japanese", "zh": "Chinese"}

args = common.arguments("--model")
model = Qwen3TTSModel.from_pretrained(
    args.model, device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa"
)


def synthesize(form, reference):
    seed = common.seed(form)
    if seed is not None:
        torch.manual_seed(seed)
    wavs, rate = model.generate_voice_clone(
        text=common.text(form, "text"),
        language=LANGUAGES[common.text(form, "language")],
        ref_audio=reference,
        ref_text=common.text(form, "ref_text"),
    )
    return wavs[0], rate


common.serve(args.port, synthesize)
