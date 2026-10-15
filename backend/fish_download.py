#!/usr/bin/env python3
"""Resumable official-CDN download with pinned revision and cryptographic checks."""

from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime" / "fish"
MODEL = "mlx-community/fish-audio-s2-pro-bf16"
REVISION = "eccd57bf5c1ebc13cb2f993df867f4e49931a36a"
DESTINATION = RUNTIME / "models" / "s2-pro-bf16"
PARTIALS = DESTINATION / ".downloads"
# Sizes and content hashes from the pinned upstream Hugging Face tree.
# Small files use Git blob SHA1; LFS objects use SHA256.
FILES = {
    "LICENSE.md": (10360, "b469a1a983b3f961e839881fc0ea5c4eb82ec4be", "git"),
    "README.md": (3535, "531f4613bed4764238d6b42712aa0a6a64ff94e2", "git"),
    "chat_template.jinja": (4116, "699ff8df401fe4788525e9c1f9b86a99eadd6230", "git"),
    "codec.safetensors": (1870921167, "c2096e27a1bb69a05151ccb502649a88744712270d9b029a68a3c9305f2b1edf", "sha256"),
    "config.json": (1863, "5214fbf56c44b20d00b1d5654d68b3b1f9ec9ea5", "git"),
    "model-00001-of-00002.safetensors": (4986872984, "c4218e8ac93be83b35eee30b4f94cb2e9b5ecff40f3e21611438d2f4f8804aad", "sha256"),
    "model-00002-of-00002.safetensors": (4136876104, "76738d23465deaac431433232c0762908cc99a6eddc3d49f67307d92680827be", "sha256"),
    "model.safetensors.index.json": (32686, "4a355d7d68ae0885db2c3ed3e2d9846420eef9a1", "git"),
    "special_tokens_map.json": (101864, "7989e2cfbbfec23cfe75e17cb5494c2354a1769e", "git"),
    "tokenizer.json": (12217872, "f24e08099d45a8adf3f52f5f0b03276e433bb9d689bb15fcbcc48ce58744588b", "sha256"),
    "tokenizer_config.json": (860832, "47a7c4ee0e88f50904020eec33f723cec6933c61", "git"),
}


def verified(path: Path, spec: tuple) -> bool:
    size, expected, algorithm = spec
    if not path.is_file() or path.stat().st_size != size:
        return False
    digest = hashlib.sha256() if algorithm == "sha256" else hashlib.sha1()
    if algorithm == "git":
        digest.update(f"blob {size}\0".encode())
    with path.open("rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest() == expected


def download_file(name: str):
    spec = FILES[name]
    target = DESTINATION / name
    if verified(target, spec):
        print(f"Verified cached file: {name}", flush=True)
        return
    part = PARTIALS / f"{name}.part"
    if target.exists():
        target.rename(PARTIALS / f"{name}.unverified-{int(time.time())}")
    url = f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}"
    for attempt in range(1, 9):
        current = part.stat().st_size if part.exists() else 0
        if current > spec[0]:
            part.rename(PARTIALS / f"{name}.invalid-size-{int(time.time())}")
            current = 0
        if current < spec[0]:
            print(f"Downloading {name}: resume {current:,} / {spec[0]:,} bytes (attempt {attempt}).", flush=True)
            completed = subprocess.run([
                "curl", "--silent", "--show-error", "--fail", "--location",
                "--continue-at", "-", "--connect-timeout", "20",
                "--speed-time", "90", "--speed-limit", "4096",
                "--output", str(part), url,
            ], check=False)
            if completed.returncode:
                print(f"Download interrupted ({completed.returncode}); partial bytes retained for {name}.", flush=True)
                time.sleep(min(15, attempt * 2))
                continue
        if verified(part, spec):
            part.replace(target)
            print(f"SHA-verified: {name}", flush=True)
            return
        if part.exists() and part.stat().st_size == spec[0]:
            part.rename(PARTIALS / f"{name}.checksum-mismatch-{int(time.time())}")
            raise RuntimeError(f"Checksum mismatch for {name}; unexpected data preserved and not loaded.")
    raise RuntimeError(f"Download incomplete for {name}. Run scripts/fish-download.sh again to resume.")


def main():
    import fcntl
    PARTIALS.mkdir(parents=True, exist_ok=True)
    with (PARTIALS / "download.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("The model download is already running; no duplicate download was started.")
        print(f"Official model {MODEL}, revision {REVISION}; {sum(item[0] for item in FILES.values()):,} bytes.", flush=True)
        # Independent files, not duplicate copies; partials survive process restarts.
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = [executor.submit(download_file, name) for name in FILES]
            for future in as_completed(futures):
                future.result()
        manifest = {"model": MODEL, "revision": REVISION, "license": "fish-audio-research", "checksums_verified": True}
        (DESTINATION / "download-complete.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print("All model files verified. Run scripts/fish-start.sh to load locally.", flush=True)


if __name__ == "__main__":
    main()
