# Fish S2 Pro local engine

Built with Fish Audio. The model is free for research and non-commercial personal use under the [Fish Audio Research License](https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md); commercial use requires a separate license. See `FISH-NOTICE.txt` and the license retained with the checkpoint.

This is an optional Apple Silicon backend for the existing Voice Studio. It uses MLX-Audio 0.5.9 and the BF16 `mlx-community/fish-audio-s2-pro-bf16` checkpoint (about 11 GB). It is not the Fish Audio cloud API. No reference audio, transcript, or generated text is uploaded. The isolated Python environment, model and download caches stay in `.runtime/fish/`.

## Setup and start

From the project directory:

```sh
scripts/fish-install.sh
scripts/fish-download.sh
scripts/fish-start.sh
```

Installation and explicit model download need internet access. Inference is forced offline. The server binds only to `127.0.0.1:7861` and begins loading the local model on startup. If the download is still running, the service checks for verified completion every five seconds and automatically preloads, even with the browser closed. The website's next `GET /health` is a second trigger guarded by the same load lock. The model is loaded once and retained between requests. The model converter's performance on a different Mac must not be interpreted as guaranteed MacBook Air speed.

The downloader uses the official Hugging Face HTTPS endpoint, pinned revision, byte-range resume and final SHA checks. Partial files survive interruptions. Run the same download command to resume, without re-downloading verified files. A filesystem lock prevents duplicate download processes. The health response reports actual cached bytes, not a simulated progress estimate.

## API contract

- `GET /health`: JSON with `status` (`missing`, `loading`, `ready`, `generating`, `error`), `model`, `sample_rate: 44100`, `busy`, `error`, `request_id`, `generated_audio_seconds`, and `local_only: true`.
- `POST /load` with `{}`: retry local model loading; never downloads weights implicitly.
- `POST /generate`: JSON described below. Returns a complete mono 44.1 kHz PCM16 WAV. Error replies use JSON `{ "error": "..." }`; 409 means busy or cancelled; 503 means not ready.
- `POST /cancel` with `{ "request_id": "..." }`: cancel that matching request at the next generated-audio boundary. Aborting a browser fetch alone is not a cancellation request.

```json
{
  "text": "[warm] Hello! It is lovely to hear from you.",
  "reference_audio": "BASE64_WAV_BYTES",
  "reference_text": "The exact words spoken in the reference recording.",
  "instruct": "Natural, conversational delivery.",
  "temperature": 0.7,
  "top_p": 0.7,
  "seed": 42,
  "request_id": "unique-client-request-id"
}
```

Reference WAV and its matching transcript are required. The server does not generate an unselected random voice, infer gender, or transcribe recordings. Reference audio must be 2–30 seconds, mono or stereo, with a supported sample rate. It is decoded/resampled in memory and not written to disk. Client code should send the complete reference clip matching the transcript, not a cropped clip paired with a full transcript.

The model's waveform-resampling speed option is deliberately fixed to 1.0 because it also shifts pitch. Use model-native inline directions or `instruct` for qualitative pacing/emotion. These controls are generative and do not guarantee an exact numeric speed. Do not read the WAV as the old engine's 24 kHz output.

Only one generation runs at a time; concurrent requests are rejected, not queued. CORS permits the three loopback forms of the existing website on port 3000. Host and Origin are validated to prevent unrelated websites from invoking local inference. This service is not designed for public hosting.

## Checks

```sh
.runtime/fish/venv/bin/python -m unittest discover -s backend -p 'test_*.py' -v
scripts/fish-start.sh --no-load
```

The contract tests do not load model weights. A successful health check alone does not verify synthesis; actual WAV generation must be tested after the full model finishes loading.
