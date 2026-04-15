#!/usr/bin/env python3
"""Wrapper faster-whisper compatible avec la CLI de whisper.cpp.

Args supportés : -m MODEL -f AUDIO -of OUT_PREFIX -l LANG
                 --output-vtt --output-json -t THREADS
"""
import sys
import json
import argparse
import os

parser = argparse.ArgumentParser()
parser.add_argument("-m", "--model", required=True)
parser.add_argument("-f", "--file", required=True)
parser.add_argument("-of", "--output-prefix", required=True)
parser.add_argument("-l", "--language", default="auto")
parser.add_argument("-t", "--threads", type=int, default=4)
parser.add_argument("--output-vtt", action="store_true")
parser.add_argument("--output-json", action="store_true")
args, _ = parser.parse_known_args()

from faster_whisper import WhisperModel

model_dir = "/app/models/faster-whisper-large-v3-turbo"

model = WhisperModel(
    model_dir,
    device="cpu",
    compute_type="int8",
    cpu_threads=args.threads,
    num_workers=1,
)

language = None if args.language == "auto" else args.language
segments_iter, info = model.transcribe(
    args.file,
    language=language,
    vad_filter=True,
    beam_size=5,
)

segments = list(segments_iter)


def fmt_ts(t):
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


if args.output_vtt:
    with open(args.output_prefix + ".vtt", "w") as f:
        f.write("WEBVTT\n\n")
        for i, seg in enumerate(segments, 1):
            f.write(f"{i}\n")
            f.write(f"{fmt_ts(seg.start)} --> {fmt_ts(seg.end)}\n")
            f.write(f"{seg.text.strip()}\n\n")

if args.output_json:
    out = {
        "transcription": [
            {
                "timestamps": {"from": fmt_ts(seg.start), "to": fmt_ts(seg.end)},
                "text": seg.text.strip(),
            }
            for seg in segments
        ]
    }
    with open(args.output_prefix + ".json", "w") as f:
        json.dump(out, f, ensure_ascii=False)

print(f"[faster-whisper] transcribed {len(segments)} segments in {info.duration:.1f}s audio")
