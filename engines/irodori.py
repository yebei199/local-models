"""Irodori-TTS: Japanese only, cloned from reference audio without needing its transcript."""

import common
from huggingface_hub import hf_hub_download
from irodori_tts.inference_runtime import InferenceRuntime, RuntimeKey, SamplingRequest

args = common.arguments("--checkpoint")
runtime = InferenceRuntime.from_key(
    RuntimeKey(
        checkpoint=hf_hub_download(args.checkpoint, "model.safetensors"),
        model_device="cuda",
        codec_device="cuda",
    )
)


def synthesize(form, reference):
    result = runtime.synthesize(
        SamplingRequest(
            text=common.text(form, "text"), ref_wav=reference, seed=common.seed(form)
        )
    )
    return result.audio.squeeze().float().cpu().numpy(), result.sample_rate


common.serve(args.port, synthesize)
