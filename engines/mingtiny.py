"""Ming-3.0-tts-tiny: a cloned voice that follows a spoken direction, on a card its weights overflow."""

import glob
import os
from dataclasses import replace

import common
import numpy as np
import torch
import torch.nn.functional as F
from safetensors import safe_open
from torch import nn

GROUP = 64
LANGUAGES = {"en": "English", "zh": "Chinese"}


class QLinear(nn.Module):
    """Weight-only quantized expert projection.

    The routed experts hold 7 of the 9 billion parameters but each token uses
    8 of 128, so dequantizing a projection when it is used costs little while
    the bf16 checkpoint alone would not fit in 16 GB.
    """

    def __init__(self, inputs, outputs, bits, device):
        super().__init__()
        self.inputs, self.outputs, self.bits = inputs, outputs, bits
        width = inputs // 2 if bits == 4 else inputs
        dtype = torch.uint8 if bits == 4 else torch.int8
        self.register_buffer("q", torch.empty(outputs, width, dtype=dtype, device=device))
        self.register_buffer(
            "s", torch.empty(outputs, inputs // GROUP, dtype=torch.bfloat16, device=device)
        )

    def fill(self, weight):
        weight = weight.to(self.q.device, torch.float32).view(self.outputs, -1, GROUP)
        top = (1 << (self.bits - 1)) - 1
        scale = (weight.abs().amax(-1, keepdim=True) / top).clamp_min(1e-8)
        scale = scale.to(torch.bfloat16).float()
        q = (weight / scale).round().clamp(-top, top).view(self.outputs, self.inputs)
        if self.bits == 4:
            u = (q + 8).to(torch.uint8)
            self.q.copy_(u[:, 0::2] | (u[:, 1::2] << 4))
        else:
            self.q.copy_(q.to(torch.int8))
        self.s.copy_(scale.squeeze(-1).to(torch.bfloat16))

    def forward(self, x):
        if self.bits == 4:
            w = torch.stack((self.q & 15, self.q >> 4), -1).view(self.outputs, -1, GROUP)
            w = w.to(x.dtype) - 8
        else:
            w = self.q.view(self.outputs, -1, GROUP).to(x.dtype)
        w = (w * self.s.to(x.dtype).unsqueeze(-1)).view(self.outputs, self.inputs)
        return F.linear(x, w)


def install(bits, device="cuda:0"):
    """Build experts as quantized buffers and stream the checkpoint into them.

    The release loader reads all 18 GB into host memory before moving it; the
    model host has neither that much free RAM nor that much VRAM.
    """
    from ming_tiny import modeling_bailing_moe_v3 as moe
    from ming_tiny import modeling_lingv3_tts as tts
    from transformers.modeling_utils import no_init_weights

    plain = moe.BailingMoeV3MLP.__init__

    def mlp(self, config, intermediate_size):
        if intermediate_size != config.moe_intermediate_size:
            return plain(self, config, intermediate_size)
        nn.Module.__init__(self)
        self.config = config
        self.hidden_size, self.intermediate_size = config.hidden_size, intermediate_size
        self.gate_proj = QLinear(self.hidden_size, intermediate_size, bits, device)
        self.up_proj = QLinear(self.hidden_size, intermediate_size, bits, device)
        self.down_proj = QLinear(intermediate_size, self.hidden_size, bits, device)
        self.act_fn = moe.ACT2FN[config.hidden_act]

    moe.BailingMoeV3MLP.__init__ = mlp
    cls = tts.LingV3TTSForConditionalGeneration

    def load(model_dir, config=None, torch_dtype=None, **_):
        old = torch.get_default_dtype()
        torch.set_default_dtype(torch_dtype)
        with no_init_weights(_enable=True):
            model = cls(config)
        torch.set_default_dtype(old)
        modules = dict(model.named_modules())
        state = dict(model.state_dict())
        seen = set()
        for path in sorted(glob.glob(os.path.join(str(model_dir), "*.safetensors"))):
            with safe_open(path, "pt", device="cpu") as tensors:
                for key in tensors.keys():
                    owner = key.rsplit(".", 1)[0]
                    if isinstance(modules.get(owner), QLinear) and key.endswith(".weight"):
                        modules[owner].fill(tensors.get_tensor(key))
                        seen.update((owner + ".q", owner + ".s"))
                    elif key in state:
                        state[key].copy_(tensors.get_tensor(key))
                        seen.add(key)
        missing = [key for key in state if key not in seen]
        if missing:
            raise RuntimeError(f"checkpoint lacks {len(missing)} tensors, first {missing[:3]}")
        return model

    cls.from_pretrained = staticmethod(load)


def directed(model, text, reference, transcript, instruction, seed):
    """Clone the whole reference as acoustic history and follow the direction on top.

    The release API only pairs a direction with a speaker embedding, which
    fixes who speaks but not their register, so separate requests drift apart.
    Every request here starts from the same real recording instead, and none
    starts from audio the model produced itself.
    """
    from ming_tiny import api
    from ming_tiny.task_protocol import resolve_task_request

    request = resolve_task_request(
        "freeform", text=text, prompt_wav=reference, instruction=instruction
    )
    request = replace(
        request,
        prompt_wav=reference,
        prompt_text=transcript,
        conditioning="prompt_latent",
    )
    output = model.engine.synthesize(
        request.text,
        instruction=request.instruction,
        prompt_wav=request.prompt_wav,
        prompt_text=request.prompt_text,
        target_language=request.target_language,
        include_target_language=request.include_target_language,
        conditioning=request.conditioning,
        assistant_instruction=request.assistant_instruction,
        allow_mixed_rml=request.allow_mixed_rml,
        decode_alignment_override=None,
        seed=seed,
        cfg_scale=api.FORMAL_CFG,
        flow_steps=api.FORMAL_FLOW_STEPS,
        sigma=api.FORMAL_SIGMA,
        temperature=api.FORMAL_TEMPERATURE,
        min_decode_steps=None,
        max_decode_steps=None,
        stop_threshold=None,
        log_every_n_steps=0,
    )
    return api.trim_trailing_silence(output.waveform, model.sample_rate)


def main():
    args = common.arguments("--model", "--bits")
    bits = int(args.bits)
    if bits not in (4, 8):
        raise SystemExit("--bits must be 4 or 8")
    install(bits)
    from ming_tiny import MingTinyTTS

    model = MingTinyTTS.from_pretrained(args.model, text_normalization=False)

    def synthesize(form, reference):
        code = common.text(form, "language")
        if code not in LANGUAGES:
            raise ValueError(f"ming-tiny does not speak {code}")
        language = LANGUAGES[code]
        text = common.text(form, "text")
        transcript = common.text(form, "ref_text")
        instruction = common.text(form, "instruction")
        seed = common.seed(form) or 1234
        with torch.inference_mode():
            if instruction:
                wave = directed(model, text, reference, transcript, instruction, seed)
            else:
                wave = model.generate(
                    task="seed",
                    text=text,
                    prompt_wav=reference,
                    prompt_text=transcript,
                    target_language=language,
                    seed=seed,
                    raw_text=True,
                ).waveform
        audio = wave.squeeze().float().cpu().numpy()
        # The float output can pass full scale, which 16-bit PCM would clip.
        peak = float(np.abs(audio).max()) if audio.size else 0.0
        return (audio / peak * 0.98 if peak > 0.98 else audio), model.sample_rate

    common.serve(args.port, synthesize)


if __name__ == "__main__":
    main()
