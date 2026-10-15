#!/usr/bin/env python3
"""One-time local synthesis acceptance test, optionally after download/preload."""

import argparse
import base64
import io
import json
from pathlib import Path
import time
import urllib.error
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime" / "fish"
BASE = "http://127.0.0.1:7861"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def health():
    with OPENER.open(f"{BASE}/health", timeout=5) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wait", action="store_true")
    args = parser.parse_args()
    deadline = time.monotonic() + (4 * 60 * 60 if args.wait else 5)
    print("Waiting for the existing local engine; no second model is loaded.", flush=True)
    while True:
        try:
            state = health()
        except (OSError, urllib.error.URLError):
            state = {"status": "offline"}
        if state["status"] == "ready":
            break
        if state["status"] == "error":
            raise RuntimeError(state.get("error", "Model load failed"))
        if time.monotonic() >= deadline:
            raise RuntimeError("Engine is not ready; no synthesis test was performed.")
        time.sleep(10)
    reference = ROOT / "public" / "voice-samples" / "US-Female-03-p299.wav"
    body = {
        "text": "Hi there. I'm glad you're here. Take your time, and let's make this sound natural.",
        "reference_audio": base64.b64encode(reference.read_bytes()).decode(),
        "reference_text": "Six spoons of fresh snow peas, five thick slabs of blue cheese, and maybe a snack for her brother Bob.",
        "instruct": "Warm, natural conversational delivery. Clear American English.",
        "temperature": 0.7, "top_p": 0.7, "seed": 42,
        "request_id": "fish-install-acceptance-p299",
    }
    request = urllib.request.Request(
        f"{BASE}/generate", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    started = time.monotonic()
    try:
        with OPENER.open(request, timeout=1800) as response:
            audio = response.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(exc.read().decode()) from exc
    import numpy as np
    with wave.open(io.BytesIO(audio), "rb") as wav:
        assert wav.getframerate() == 44100, "Unexpected sample rate"
        assert wav.getnchannels() == 1, "Unexpected channel count"
        assert wav.getsampwidth() == 2, "Unexpected PCM encoding"
        duration = wav.getnframes() / wav.getframerate()
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768
    assert 1 < duration < 40, f"Unexpected short-test duration: {duration}"
    rms = float(np.sqrt(np.mean(samples * samples)))
    peak = float(np.max(np.abs(samples)))
    assert rms > 0.00002 and peak > 0.0002, "Silent output"
    path = RUNTIME / "smoke.wav"
    path.write_bytes(audio)
    result = {
        "passed": True, "checks": "Real API synthesis; WAV/PCM/sample-rate/duration/non-silence",
        "subjective_quality_reviewed": False, "voice": "VCTK p299 female",
        "sample_rate": 44100, "duration_seconds": duration,
        "generation_seconds": round(time.monotonic() - started, 2),
        "rms": rms, "peak": peak, "audio_path": str(path),
    }
    (RUNTIME / "smoke-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        RUNTIME.mkdir(parents=True, exist_ok=True)
        (RUNTIME / "smoke-result.json").write_text(json.dumps({"passed": False, "error": str(exc)}, indent=2) + "\n")
        raise
