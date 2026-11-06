"""Ming-3.0-tts: voice cloning in English, Japanese and Chinese."""

import common
import torch
from ming_tts import MingTTS

args = common.arguments("--model")
# Every request arrives as a fresh temporary file, so a prompt cache could only grow.
model = MingTTS(args.model, text_normalization=False, cache_prompts=False)


def synthesize(form, reference):
    seed = common.seed(form)
    if seed is not None:
        torch.manual_seed(seed)
    wave = model.synthesize(
        task="TTS",
        text=common.text(form, "text"),
        language_id=common.text(form, "language"),
        prompt_wav_path=reference,
        prompt_text=common.text(form, "ref_text"),
        use_spk_emb=True,
    )
    return wave.squeeze().float().cpu().numpy(), model.sample_rate


common.serve(args.port, synthesize)
