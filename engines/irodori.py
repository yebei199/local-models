"""Irodori-TTS: Japanese only, cloned from reference audio without needing its transcript."""

import common
from irodori_tts.inference_runtime import InferenceRuntime, RuntimeKey, SamplingRequest

# Local files from the install; the tokenizer is found beside the checkpoint.
args = common.arguments("--checkpoint", "--codec")
runtime = InferenceRuntime.from_key(
    RuntimeKey(
        checkpoint=args.checkpoint,
        codec_repo=args.codec,
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
