"""Qwen3-ASR: timed subtitle lines and per-line language from one uploaded audio file.

fsmn-vad cuts speech into pieces of at most 30 s; Qwen3-ASR transcribes each piece and names its
language; the forced aligner's word times cut the text into lines that end at a sentence and last
at most 15 s. Cutting by audio energy instead looped on a chanting crowd and lost per-piece
languages, so the VAD stays (docs/asr-models.md).
"""

import argparse
import http.server
import json
import subprocess
import tempfile
import unicodedata
from pathlib import Path

import common
import numpy as np
import torch
from funasr import AutoModel
from qwen_asr import Qwen3ASRModel

RATE = 16000
LINE_SECONDS = 15.0
PIECE_MS = 30000
BATCH = 8
SENTENCE_END = set("。！？!?….")
CLAUSE_END = set("，、,;；：:")
# Qwen3-ASR language names; Cantonese is written Chinese, so it counts as zh.
ISO = {
    "Chinese": "zh", "Cantonese": "zh", "English": "en", "Japanese": "ja", "Korean": "ko",
    "French": "fr", "German": "de", "Spanish": "es", "Italian": "it", "Portuguese": "pt",
    "Russian": "ru", "Arabic": "ar", "Thai": "th", "Vietnamese": "vi", "Indonesian": "id",
    "Malay": "ms", "Hindi": "hi", "Turkish": "tr", "Dutch": "nl", "Polish": "pl",
    "Swedish": "sv", "Danish": "da", "Finnish": "fi", "Czech": "cs", "Greek": "el",
    "Hungarian": "hu", "Romanian": "ro", "Persian": "fa", "Filipino": "tl", "Macedonian": "mk",
}
NAMES = {"zh": "Chinese", "en": "English", "ja": "Japanese"}
# The aligner covers 11 languages; other lines keep their piece's time span.
ALIGNABLE = {"Chinese", "Cantonese", "English", "Japanese", "Korean", "French", "German",
             "Spanish", "Italian", "Portuguese", "Russian"}

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--weights", required=True)
parser.add_argument("--model-id", required=True)
args = parser.parse_args()
weights = Path(args.weights)

vad = AutoModel(model=str(weights / "vad"), device="cuda:0", disable_update=True,
                max_single_segment_time=PIECE_MS)
asr = Qwen3ASRModel.from_pretrained(
    str(weights / "asr"), dtype=torch.bfloat16, device_map="cuda:0",
    max_inference_batch_size=BATCH, max_new_tokens=512,
    forced_aligner=str(weights / "aligner"),
    forced_aligner_kwargs={"dtype": torch.bfloat16, "device_map": "cuda:0"},
)


def decode(data):
    """Any container ffmpeg reads, as 16 kHz mono floats. A file, not a pipe: MP4 audio from
    yt-dlp may keep its index at the end, which ffmpeg can only reach by seeking."""
    with tempfile.NamedTemporaryFile() as upload:
        upload.write(data)
        upload.flush()
        result = subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", upload.name, "-ac", "1",
             "-ar", str(RATE), "-f", "f32le", "pipe:1"],
            capture_output=True, check=False)
    if result.returncode != 0:
        raise ValueError(f"cannot decode audio: {result.stderr.decode(errors='replace').strip()}")
    return np.frombuffer(result.stdout, dtype=np.float32)


def pieces(wav):
    """Speech spans of at most 30 s, merged across pauses shorter than 0.4 s."""
    found = vad.generate(input=wav, fs=RATE)[0]["value"] if len(wav) else []
    merged = []
    for start, end in found:
        if merged and start - merged[-1][1] <= 400 and end - merged[-1][0] <= PIECE_MS:
            merged[-1][1] = end
        else:
            merged.append([start, end])
    return [(start / 1000, end / 1000) for start, end in merged]


def spans(items, text):
    """Place each aligned word in the punctuated transcript, so lines keep the model's punctuation."""
    out, position = [], 0
    for item in items:
        start = text.find(item.text, position)
        if start < 0:
            start = text.lower().find(item.text.lower(), position)
        if start < 0:
            start = position
        end = min(max(start + len(item.text), position), len(text))
        while end < len(text) and unicodedata.category(text[end])[0] == "P":
            end += 1
        out.append((item.start_time, item.end_time, start, end))
        position = end
    return out


def lines(placed, text, offset):
    """Close a line at each sentence end; a line about to pass 15 s closes at its last clause end."""
    result, current = [], []

    def close(count):
        nonlocal current
        part, current = current[:count], current[count:]
        if part:
            result.append({"from": round(offset + part[0][0], 2),
                           "to": round(offset + part[-1][1], 2),
                           "text": text[part[0][2]:part[-1][3]].strip()})

    for word in placed:
        if current and word[1] - current[0][0] > LINE_SECONDS:
            clauses = [k + 1 for k, w in enumerate(current) if w[3] and text[w[3] - 1] in CLAUSE_END]
            close(clauses[-1] if clauses else len(current))
            if current and word[1] - current[0][0] > LINE_SECONDS:
                close(len(current))
        current.append(word)
        if word[3] and text[word[3] - 1] in SENTENCE_END:
            close(len(current))
    close(len(current))
    return [line for line in result if line["text"]]


def name(language):
    """Mixed pieces come back as "Chinese,English"; the first is the dominant one."""
    return language.split(",")[0].strip()


def transcribe(wav, hint):
    spots = pieces(wav)
    clips = [(wav[int(a * RATE):int(b * RATE)], RATE) for a, b in spots]
    results = asr.transcribe(clips, language=NAMES[hint] if hint else None) if clips else []
    todo = [k for k, r in enumerate(results) if r.text.strip() and name(r.language) in ALIGNABLE]
    aligned = {}
    for first in range(0, len(todo), BATCH):
        keys = todo[first:first + BATCH]
        got = asr.forced_aligner.align(audio=[clips[k] for k in keys],
                                       text=[results[k].text for k in keys],
                                       language=[name(results[k].language) for k in keys])
        aligned.update(zip(keys, got, strict=True))
    segments, weight = [], {}
    for k, ((start, end), result) in enumerate(zip(spots, results, strict=True)):
        if not result.text.strip():
            continue
        lang = ISO.get(name(result.language)) or hint
        if k in aligned and aligned[k].items:
            found = lines(spans(aligned[k].items, result.text), result.text, start)
        else:
            found = [{"from": round(start, 2), "to": round(end, 2), "text": result.text.strip()}]
        for line in found:
            segments.append({**line, "lang": lang} if lang else line)
            weight[lang] = weight.get(lang, 0) + line["to"] - line["from"]
    weight.pop(None, None)
    top = max(weight, key=weight.get) if weight else hint
    return {"lang": top, "model": args.model_id, "duration": round(len(wav) / RATE, 2),
            "segments": segments}


class Handler(http.server.BaseHTTPRequestHandler):
    def respond(self, status, payload, kind):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.respond(200, b"ready", "text/plain")

    def do_POST(self):
        form = common.fields(self.headers["Content-Type"],
                             self.rfile.read(int(self.headers["Content-Length"])))
        hint = (form.get("language") or b"").decode() or None
        if "file" not in form or (hint and hint not in NAMES):
            self.respond(400, b"need a file, and language one of en, ja, zh", "text/plain")
            return
        try:
            answer = transcribe(decode(form["file"]), hint)
        except ValueError as error:
            self.respond(400, str(error).encode(), "text/plain")
            return
        except Exception as error:
            self.respond(500, str(error).encode(), "text/plain")
            return
        finally:
            torch.cuda.empty_cache()
        self.respond(200, json.dumps(answer, ensure_ascii=False).encode(), "application/json")


http.server.HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
