#!/usr/bin/env python3
"""Magenta RealTime 2 worker for omep/magenta-rt-engine.mjs (OpenBand, MIT).

Runs in the user's own Python, where magenta-rt is installed (magenta-rt 2.0.3 API):

    uv pip install "magenta-rt[mlx]"          # Apple Silicon
    uv pip install magenta-rt "jax[cuda13]"   # NVIDIA
    mrt models init && mrt models download mrt2_small

Protocol (stdio):
  in   one JSON object per line:
       {"op": "style", "id": n, "text": "warm lo-fi keys"}
       {"op": "gen", "id": n, "frames": [{"notes": [128 ints] | null, "drums": -1 | 0 | 1}, ...]}
  out  messages: u32 length (of what follows) · u8 kind · payload
       kind 0: JSON ({"ready": true, ...}, {"id": n} for style, {"id": n, "error": "..."})
       kind 1: u32 id · float32 little-endian stereo interleaved, 1920 samples per frame (48 kHz)

Each frame is generated with frames=1 so that its conditioning (the chord piano roll and the beat as a
drum onset) is the one the studio's transport needs at that very 40 ms.
"""
import argparse
import json
import struct
import sys
import traceback

OUT = sys.stdout.buffer

# Token keys of magenta_rt/config.py (MUSICCOCA, PIANOROLL_WITH_ONSETS, DRUM_PIANOROLL).
STYLE_KEY = "mulan_tokens_25hz"
NOTES_KEY = "pianoroll_with_onsets_tokens"
DRUMS_KEY = "drum_pianoroll_tokens"


def send(kind, payload):
    OUT.write(struct.pack("<IB", len(payload) + 1, kind) + payload)
    OUT.flush()


def send_json(obj):
    send(0, json.dumps(obj).encode("utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="mrt2_small")
    ap.add_argument("--backend", default="mlx", choices=["mlx", "jax"])
    ap.add_argument("--temperature", type=float, default=1.3)
    ap.add_argument("--top-k", type=int, default=40)
    a = ap.parse_args()

    import numpy as np

    try:
        if a.backend == "mlx":
            from magenta_rt import MagentaRT2StdMlxfn as System
        else:
            from magenta_rt import MagentaRT2Jax as System
        mrt = System(size=a.model, temperature=a.temperature, top_k=a.top_k)
    except Exception as e:  # not installed, weights missing, wrong platform
        send_json({"error": f"{type(e).__name__}: {e}. Install magenta-rt and run `mrt models init` and `mrt models download {a.model}`."})
        return 1

    send_json({"ready": True, "model": a.model, "backend": a.backend, "sample_rate": 48000, "frame_samples": 1920})
    state = None
    style = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        mid = msg.get("id", 0)
        try:
            if msg.get("op") == "style":
                text = (msg.get("text") or "").strip()
                style = mrt.embed_style(text, use_mapper=True) if text else None
                send_json({"id": mid})
            elif msg.get("op") == "gen":
                chunks = []
                for f in msg.get("frames", []):
                    cond = {}
                    if style is not None:
                        cond[STYLE_KEY] = style
                    if f.get("notes") is not None:
                        cond[NOTES_KEY] = f["notes"]
                    if f.get("drums") is not None and f["drums"] >= 0:
                        cond[DRUMS_KEY] = [f["drums"]]
                    wav, state = mrt.generate(conditioning=cond or None, frames=1, state=state)
                    chunks.append(np.asarray(wav.samples, dtype=np.float32).reshape(-1, 2))
                pcm = np.concatenate(chunks).astype("<f4").tobytes() if chunks else b""
                send(1, struct.pack("<I", mid) + pcm)
            else:
                send_json({"id": mid, "error": f"unknown op {msg.get('op')}"})
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            send_json({"id": mid, "error": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
