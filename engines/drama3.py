"""Fish Audio Drama 3 through audio.cpp's C library: cloned speech, tone set by [tags] in the text."""

import ctypes
import subprocess

import numpy as np

import common

# The codec runs at this rate; decoding the reference straight to it skips a resample inside.
RATE = 44100


class Backend(ctypes.Structure):
    _fields_ = [("backend", ctypes.c_char_p), ("device", ctypes.c_int), ("threads", ctypes.c_int)]


class AudioCpp:
    """The few calls a clone needs; every status is checked so a failure carries the library's words."""

    def __init__(self, path):
        self.lib = lib = ctypes.CDLL(path)
        pointer = ctypes.c_void_p
        lib.audiocpp_last_error.restype = ctypes.c_char_p
        lib.audiocpp_options_create.restype = pointer
        lib.audiocpp_options_set.argtypes = [pointer, ctypes.c_char_p, ctypes.c_char_p]
        lib.audiocpp_request_create.restype = pointer
        lib.audiocpp_request_free.argtypes = [pointer]
        lib.audiocpp_request_set_text.argtypes = [pointer, ctypes.c_char_p, ctypes.c_char_p]
        lib.audiocpp_request_set_option.argtypes = [pointer, ctypes.c_char_p, ctypes.c_char_p]
        lib.audiocpp_request_set_voice_audio.argtypes = [
            pointer,
            ctypes.POINTER(ctypes.c_float),
            ctypes.c_size_t,
            ctypes.c_int,
            ctypes.c_int,
        ]
        lib.audiocpp_session_run.argtypes = [pointer, pointer, ctypes.POINTER(pointer)]
        lib.audiocpp_result_free.argtypes = [pointer]

    def check(self, status, what):
        if status:
            raise RuntimeError(f"{what}: {self.lib.audiocpp_last_error().decode()}")

    def session(self, model_path, threads, options):
        """Load once; the session keeps the weights split between card and CPU as `options` say."""
        lib = self.lib
        registry, model, session = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
        self.check(lib.audiocpp_registry_create(None, ctypes.byref(registry)), "registry")
        self.check(
            lib.audiocpp_model_load(registry, model_path.encode(), None, None, ctypes.byref(model)),
            "load",
        )
        # Wrapped, or ctypes passes the bare int to session_create as a 32-bit value.
        settings = ctypes.c_void_p(lib.audiocpp_options_create())
        for key, value in options.items():
            self.check(lib.audiocpp_options_set(settings, key.encode(), value.encode()), key)
        backend = Backend(b"cuda", 0, threads)
        self.check(
            lib.audiocpp_session_create(
                model, b"clon", b"offline", ctypes.byref(backend), settings, ctypes.byref(session)
            ),
            "session",
        )
        return session

    def clone(self, session, text, voice, transcript, seed):
        lib = self.lib
        request = lib.audiocpp_request_create()
        result = ctypes.c_void_p()
        try:
            self.check(lib.audiocpp_request_set_text(request, text.encode(), None), "text")
            samples = voice.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
            self.check(
                lib.audiocpp_request_set_voice_audio(request, samples, voice.size, RATE, 1),
                "reference",
            )
            self.check(
                lib.audiocpp_request_set_option(request, b"reference_text", transcript.encode()),
                "reference_text",
            )
            if seed is not None:
                self.check(
                    lib.audiocpp_request_set_option(request, b"seed", str(seed).encode()), "seed"
                )
            self.check(lib.audiocpp_session_run(session, request, ctypes.byref(result)), "run")
            data = ctypes.POINTER(ctypes.c_float)()
            frames, rate, channels = ctypes.c_size_t(), ctypes.c_int(), ctypes.c_int()
            self.check(
                lib.audiocpp_result_audio(
                    result,
                    ctypes.byref(data),
                    ctypes.byref(frames),
                    ctypes.byref(rate),
                    ctypes.byref(channels),
                ),
                "audio",
            )
            audio = np.ctypeslib.as_array(data, (frames.value * channels.value,)).copy()
            return audio.reshape(-1, channels.value).mean(axis=1), rate.value
        finally:
            if result:
                lib.audiocpp_result_free(result)
            lib.audiocpp_request_free(request)


def decode(path):
    """Any format a caller sends, as mono float samples at the codec's rate."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(RATE), "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def main():
    args = common.arguments("--library", "--model", "--cpu-expert-layers", "--threads")
    audio = AudioCpp(args.library)
    # On a 16 GB card the codec and its reference-encoding graph only fit beside the experts the
    # card keeps when the codec runs on the CPU; see docs/tts-models.md.
    session = audio.session(
        args.model,
        int(args.threads),
        {
            "moe_cpu_expert_layers": args.cpu_expert_layers,
            "fish_drama3.codec_backend": "cpu",
            "fish_drama3.context_length": "2048",
        },
    )

    def synthesize(form, reference):
        if common.text(form, "instruction"):
            raise ValueError("drama3 takes no instruction; write the tone as [tags] in the text")
        seed = common.seed(form)
        return audio.clone(
            session,
            common.text(form, "text"),
            decode(reference),
            common.text(form, "ref_text"),
            None if seed is None else seed % 2**31,
        )

    common.serve(args.port, synthesize)


if __name__ == "__main__":
    main()
