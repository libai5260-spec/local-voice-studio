#!/usr/bin/env python3
"""Loopback-only Fish S2 Pro inference. Audio and transcripts never leave this Mac."""

from __future__ import annotations

import argparse
import base64
import binascii
from concurrent.futures import ThreadPoolExecutor
import io
import json
import math
import os
from pathlib import Path
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime" / "fish"
MODEL_DIR = RUNTIME / "models" / "s2-pro-bf16"
MODEL_ID = "mlx-community/fish-audio-s2-pro-bf16"
SAMPLE_RATE = 44100
MAX_BODY = 12 * 1024 * 1024
MODEL_DOWNLOAD_BYTES = 11007903383
ALLOWED_ORIGINS = {
    "http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000",
}

# The server only opens an already-downloaded checkpoint; no implicit network calls.
os.environ.setdefault("HF_HOME", str(RUNTIME / "hf-cache"))
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


class RequestError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class Cancelled(Exception):
    pass


def model_present(path: Path) -> bool:
    if not all((path / name).is_file() for name in (
        "config.json", "codec.safetensors", "tokenizer.json",
        "model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors",
        "download-complete.json",
    )):
        return False
    try:
        manifest = json.loads((path / "download-complete.json").read_text())
        return manifest.get("checksums_verified") is True and manifest.get("model") == MODEL_ID
    except (OSError, ValueError):
        return False


def download_progress(path: Path) -> dict:
    """Count actual checkpoint/cache bytes, not a time-based pretend percentage."""
    downloaded = 0
    try:
        for file in path.iterdir():
            if file.is_file() and file.name != "download-complete.json":
                downloaded += file.stat().st_size
        resumable = path / ".downloads"
        partial_files = resumable.glob("*.part") if resumable.exists() else (path / ".cache" / "huggingface" / "download").glob("*.incomplete")
        for file in partial_files:
            stats = file.stat()
            downloaded += min(stats.st_size, stats.st_blocks * 512)
    except OSError:
        pass
    downloaded = min(downloaded, MODEL_DOWNLOAD_BYTES)
    active = False
    try:
        import fcntl
        with (path / ".downloads" / "download.lock").open("rb") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                fcntl.flock(lock, fcntl.LOCK_UN)
            except BlockingIOError:
                active = True
    except OSError:
        pass
    return {"download_bytes": downloaded, "download_total_bytes": MODEL_DOWNLOAD_BYTES, "download_active": active}


def split_text(text: str, limit: int = 360) -> list[str]:
    """Bound each speaker turn, retaining inline directions and punctuation."""
    # Fish's chunk_length groups speaker turns; it does not split an oversized turn.
    # Whitespace within an inline direction is not a boundary.
    pieces = re.findall(r"\[[^\]]*\]|\S+", text)
    chunks: list[str] = []
    current = ""
    for word in pieces:
        if len(word) > 600:
            raise RequestError("文本中有过长的连续字符，请增加空格或分段后再生成。")
        if current and len(current) + len(word) + 1 > limit:
            chunks.append(current)
            current = ""
        current = f"{current} {word}".strip()
        if len(current) >= limit * 0.6 and re.search(r"[.!?][\"']?$", word):
            chunks.append(current)
            current = ""
    if current:
        chunks.append(current)
    return chunks


def finite_number(value, name: str, default: float, low: float, high: float) -> float:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RequestError(f"{name} 必须是数字。")
    value = float(value)
    if not math.isfinite(value) or not low <= value <= high:
        raise RequestError(f"{name} 超出允许范围。")
    return value


def validate_request(data: dict) -> dict:
    text = data.get("text")
    transcript = data.get("reference_text")
    encoded = data.get("reference_audio")
    if not isinstance(text, str) or not text.strip() or len(text) > 6000:
        raise RequestError("请输入 1–6000 字符的文本；更长内容请分段生成。")
    if "<|speaker:" in text:
        raise RequestError("当前模式仅使用所选单个音色，请移除多说话人标记。")
    if not isinstance(transcript, str) or not transcript.strip() or len(transcript) > 4000:
        raise RequestError("Fish 音色需要样本的准确文字。请先填写或确认参考音频转写。")
    if not isinstance(encoded, str) or not encoded:
        raise RequestError("请先选择一个女性音色，或上传本人的声音样本。")
    if encoded.startswith("data:"):
        encoded = encoded.split(",", 1)[-1]
    try:
        wav = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise RequestError("参考音频不是有效的 Base64 WAV。") from exc
    if len(wav) > 8 * 1024 * 1024 or wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise RequestError("参考样本必须是 WAV 格式且小于 8 MB。")
    instruct = data.get("instruct", "")
    if not isinstance(instruct, str) or len(instruct) > 600:
        raise RequestError("表达提示不能超过 600 字符。")
    request_id = data.get("request_id") or str(uuid.uuid4())
    if not isinstance(request_id, str) or len(request_id) > 100:
        raise RequestError("无效的生成任务编号。")
    seed = data.get("seed", 42)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**32:
        raise RequestError("随机种子必须是 0–4294967295 的整数。")
    return {
        "text": text.strip(), "reference_text": transcript.strip(),
        "reference_wav": wav, "instruct": instruct.strip(), "request_id": request_id,
        "temperature": finite_number(data.get("temperature"), "变化度", 0.7, 0.1, 1.2),
        "top_p": finite_number(data.get("top_p"), "top_p", 0.7, 0.1, 1.0),
        "seed": seed,
    }


class FishEngine:
    def __init__(self, model_dir: Path = MODEL_DIR):
        self.model_dir = model_dir
        self.lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="fish-inference")
        self.model = None
        self.status = "missing"
        self.error = None
        self.request_id = None
        self.cancelled = threading.Event()
        self.started_at = None
        self.audio_seconds = 0.0

    def health(self) -> dict:
        progress = download_progress(self.model_dir)
        with self.lock:
            error = self.error
            if self.status == "missing" and progress["download_active"]:
                error = "高品质模型正在下载，完成后将自动载入。请保持电脑与网络开启。"
            return {
                "status": self.status, "model": MODEL_ID,
                "sample_rate": SAMPLE_RATE, "busy": self.status == "generating",
                "error": error, "request_id": self.request_id,
                "elapsed_seconds": round(time.monotonic() - self.started_at, 1) if self.started_at else 0,
                "generated_audio_seconds": round(self.audio_seconds, 1),
                "local_only": True,
                **progress,
            }

    def load(self):
        with self.lock:
            if self.status in {"loading", "ready", "generating"}:
                return
            if not model_present(self.model_dir):
                self.status = "missing"
                self.error = "本地 Fish 模型尚未下载完整，请先运行 scripts/fish-download.sh。"
                return
            self.status, self.error = "loading", None
        self.executor.submit(self._load)

    def _load(self):
        try:
            import mlx.core as mx
            from mlx_audio.tts.utils import load_model
            model = load_model(str(self.model_dir))
            mx.eval(model.parameters())
            if model.sample_rate != SAMPLE_RATE:
                raise ValueError(f"Unexpected model sample rate: {model.sample_rate}")
            with self.lock:
                self.model, self.status, self.error = model, "ready", None
            print("Fish S2 Pro BF16 ready (44.1 kHz, local only).", flush=True)
        except Exception as exc:
            with self.lock:
                self.status, self.error = "error", f"Fish 模型载入失败：{type(exc).__name__}: {exc}"
            print(self.error, flush=True)

    def generate(self, request: dict):
        with self.lock:
            if self.status == "generating":
                raise RequestError("已有音频正在生成，请等待完成后再试。", 409)
            if self.status != "ready":
                raise RequestError(self.error or "模型尚在载入，请稍候再生成。", 503)
            self.status, self.request_id = "generating", request["request_id"]
            self.cancelled.clear()
            self.started_at, self.audio_seconds = time.monotonic(), 0.0
        return self.executor.submit(self._generate, request)

    def cancel(self, request_id: str) -> bool:
        with self.lock:
            if self.status == "generating" and request_id == self.request_id:
                self.cancelled.set()
                return True
            return False

    def _generate(self, request: dict) -> bytes:
        mx = None
        try:
            import mlx.core as mx
            import numpy as np
            import soundfile as sf
            from scipy.signal import resample_poly
            with sf.SoundFile(io.BytesIO(request["reference_wav"])) as source:
                if source.samplerate < 8000 or source.samplerate > 192000 or source.channels > 2:
                    raise RequestError("参考音频的采样率或声道数不受支持。")
                duration = source.frames / source.samplerate
                if not 2 <= duration <= 30:
                    raise RequestError("请使用 2–30 秒的清晰参考音频，并填写这段音频的准确文字。")
                reference = source.read(dtype="float32", always_2d=True).mean(axis=1)
                ref_rate = source.samplerate
            if not np.isfinite(reference).all() or np.max(np.abs(reference)) < 0.003:
                raise RequestError("参考音频无有效人声或音量过低，请重新录制。")
            if ref_rate != SAMPLE_RATE:
                divisor = math.gcd(ref_rate, SAMPLE_RATE)
                reference = resample_poly(reference, SAMPLE_RATE // divisor, ref_rate // divisor)
            if self.cancelled.is_set():
                raise Cancelled()
            mx.random.seed(request["seed"])
            segments = split_text(request["text"])
            tagged_text = "\n".join(f"<|speaker:0|>{part}" for part in segments)
            audio_parts = []
            segment_tokens: dict[int, int] = {}
            # Match the pinned runtime's per-turn token cap, not only max_tokens.
            batches = self.model._split_generation_text(tagged_text, 400)
            token_budgets = [min(1536, max(32, len(self.model.tokenizer.encode(batch)) * 12)) for batch in batches]
            generator = self.model.generate(
                text=tagged_text, ref_audio=mx.array(reference.astype(np.float32)),
                ref_text=request["reference_text"], instruct=request["instruct"] or None,
                temperature=request["temperature"], top_p=request["top_p"], top_k=30,
                max_tokens=1536, speed=1.0, chunk_length=400,
                stream=True, streaming_interval=0.5, verbose=False,
            )
            try:
                for result in generator:
                    if self.cancelled.is_set():
                        raise Cancelled()
                    segment_index = getattr(result, "segment_idx", 0)
                    segment_tokens[segment_index] = segment_tokens.get(segment_index, 0) + getattr(result, "token_count", 0)
                    if segment_tokens[segment_index] >= token_budgets[segment_index]:
                        raise RequestError("模型在某段文本处未正常结束。请缩短该段或检查参考转写后重试。", 500)
                    part = np.asarray(result.audio, dtype=np.float32)
                    if part.size:
                        audio_parts.append(part)
                        with self.lock:
                            self.audio_seconds += part.size / SAMPLE_RATE
            finally:
                generator.close()
            if self.cancelled.is_set():
                raise Cancelled()
            if not audio_parts:
                raise RequestError("模型没有产生音频，请更换一段参考样本后重试。", 500)
            audio = np.concatenate(audio_parts)
            if not np.isfinite(audio).all():
                raise RequestError("模型产生无效音频，请重试。", 500)
            peak = float(np.max(np.abs(audio)))
            rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
            if peak < 0.0002 or rms < 0.00002:
                raise RequestError("模型只生成了静音，请检查参考样本与转写是否一致后重试。", 500)
            if peak > 0.98:
                audio *= 0.98 / peak
            output = io.BytesIO()
            sf.write(output, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
            return output.getvalue()
        finally:
            if mx is not None:
                mx.clear_cache()
            with self.lock:
                self.status, self.request_id, self.started_at = "ready", None, None


class Handler(BaseHTTPRequestHandler):
    server_version = "VoiceStudioLocal/1"

    @property
    def engine(self) -> FishEngine:
        return self.server.engine

    def allowed(self) -> bool:
        port = self.server.server_port
        if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}:
            self.respond(403, {"error": "本地服务只接受 loopback 地址。"})
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            self.respond(403, {"error": "此网页来源不能访问本地语音服务。"})
            return False
        return True

    def respond(self, status: int, payload, content_type: str = "application/json; charset=utf-8"):
        content = json.dumps(payload, ensure_ascii=False).encode() if isinstance(payload, dict) else payload
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            origin = self.headers.get("Origin")
            if origin in ALLOWED_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def body(self) -> dict:
        if self.headers.get_content_type() != "application/json":
            raise RequestError("请求必须使用 application/json。", 415)
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise RequestError("无效的请求长度。") from exc
        if not 0 < length <= MAX_BODY:
            raise RequestError("请求为空或音频文件过大。", 413)
        self.connection.settimeout(30)
        try:
            value = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError) as exc:
            raise RequestError("无效的 JSON 请求。") from exc
        if not isinstance(value, dict):
            raise RequestError("请求必须是 JSON 对象。")
        self.connection.settimeout(None)
        return value

    def do_OPTIONS(self):
        if not self.allowed():
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", ""))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self.allowed():
            return
        if self.path == "/health":
            if self.server.auto_load and self.engine.status == "missing" and model_present(self.engine.model_dir):
                self.engine.load()
            self.respond(200, self.engine.health())
        else:
            self.respond(404, {"error": "接口不存在。"})

    def do_POST(self):
        if not self.allowed():
            return
        try:
            data = self.body()
            if self.path == "/load":
                self.engine.load()
                self.respond(202, self.engine.health())
            elif self.path == "/cancel":
                self.respond(200, {"cancelled": self.engine.cancel(data.get("request_id"))})
            elif self.path == "/generate":
                request = validate_request(data)
                result = self.engine.generate(request).result()
                self.respond(200, result, "audio/wav")
            else:
                self.respond(404, {"error": "接口不存在。"})
        except RequestError as exc:
            self.respond(exc.status, {"error": str(exc)})
        except Cancelled:
            self.respond(409, {"error": "生成已取消。", "cancelled": True})
        except Exception as exc:
            # No reference waveform, transcript, or generated text is logged.
            print(f"Generation error: {type(exc).__name__}: {exc}", flush=True)
            self.respond(500, {"error": f"本地生成失败：{type(exc).__name__}: {exc}"})

    def log_message(self, format, *args):
        print(f"{self.log_date_time_string()} {format % args}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7861)
    parser.add_argument("--model-dir", type=Path, default=MODEL_DIR)
    parser.add_argument("--no-load", action="store_true", help="Run health/API checks without automatic MLX loading")
    args = parser.parse_args()
    engine = FishEngine(args.model_dir)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    server.engine = engine
    server.auto_load = not args.no_load
    shutdown = threading.Event()
    print(f"Local Fish API: http://127.0.0.1:{args.port}", flush=True)
    if not args.no_load:
        engine.load()
        def preload_after_download():
            while not shutdown.wait(5):
                if engine.status != "missing":
                    return
                if model_present(engine.model_dir):
                    engine.load()
                    return
        # The page may be backgrounded or closed; the local service still preloads.
        threading.Thread(target=preload_after_download, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        engine.cancelled.set()
    finally:
        shutdown.set()
        server.server_close()
        engine.executor.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
