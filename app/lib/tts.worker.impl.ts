/*
 * Browser inference adapter derived from Resemble AI's MIT-licensed
 * transformersjs-chatterbox-demo:
 * https://github.com/resemble-ai/transformersjs-chatterbox-demo
 */
import { AutoProcessor, ChatterboxModel, env, Tensor, InterruptableStoppingCriteria } from "@huggingface/transformers";
import { installFinalCacheCleanup } from "./inference-resources";
import { getSamplingSettings } from "./generation-settings";

// Use the full Chatterbox model for voice quality. The Turbo model is faster,
// but its two-step decoder and unsupported expression controls sound noticeably
// flatter in longer, cloned speech.
const MODEL_ID = "onnx-community/chatterbox-ONNX";

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = "/models/";
// The model already lives on disk under public/models. Caching it again would
// duplicate roughly 1.8 GB in browser storage and can stall model startup.
env.useBrowserCache = false;

const onnxEnvironment = env.backends.onnx as {
  wasm?: {
    wasmPaths?: string | { mjs: string; wasm: string };
  };
};

if (onnxEnvironment.wasm) {
  onnxEnvironment.wasm.wasmPaths = {
    mjs: "/models/onnx-runtime/ort-wasm-simd-threaded.asyncify.mjs",
    wasm: "/models/onnx-runtime/ort-wasm-simd-threaded.asyncify.wasm",
  };
}

type WorkerEndpoint = {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
};

const workerScope = self as unknown as WorkerEndpoint;

let model: Awaited<ReturnType<typeof ChatterboxModel.from_pretrained>> | null = null;
let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null;
const speakerCache = new Map<string, Record<string, Tensor>>();
let releaseDecoderCache: (() => void) | undefined;
let currentRequestId: string | undefined;
const cancelledRequests = new Set<string>();
const stoppingCriteria = new InterruptableStoppingCriteria();
function respond(type: string, data: unknown, transfer?: Transferable[]) {
  workerScope.postMessage({ type, data, requestId: currentRequestId }, transfer);
}

const DTYPE_CONFIGS = {
  wasm: {
    embed_tokens: "fp32",
    speech_encoder: "fp32",
    language_model: "q4",
    conditional_decoder: "fp32",
  },
  webgpu: {
    embed_tokens: "fp32",
    speech_encoder: "fp32",
    language_model: "q4f16",
    conditional_decoder: "fp32",
  },
} as const;

const MODEL_FILE_SIZES: Record<string, number> = {
  "onnx/embed_tokens.onnx": 13_286,
  "onnx/embed_tokens.onnx_data": 61_640_704,
  "onnx/speech_encoder.onnx": 1_184_608,
  "onnx/speech_encoder.onnx_data": 591_274_880,
  "onnx/conditional_decoder.onnx": 6_350_448,
  "onnx/conditional_decoder.onnx_data": 533_970_816,
  "onnx/language_model_q4.onnx": 227_911,
  "onnx/language_model_q4.onnx_data": 353_621_248,
  "onnx/language_model_q4f16.onnx": 229_388,
  "onnx/language_model_q4f16.onnx_data": 304_737_408,
};

type RawLoadProgress = {
  status?: string;
  file?: string;
  name?: string;
  progress?: number;
  loaded?: number;
  total?: number;
};

function postLoadProgress(progress: number, file: string, raw: RawLoadProgress = {}) {
  respond("load:progress", { ...raw, progress, file });
}

function createModelProgressReporter(device: "webgpu" | "wasm") {
  const languageModel = device === "webgpu" ? "language_model_q4f16" : "language_model_q4";
  const selectedComponents = ["embed_tokens", "speech_encoder", "conditional_decoder", languageModel];
  const expectedFiles = Object.entries(MODEL_FILE_SIZES).filter(([file]) =>
    selectedComponents.some((component) => file === `onnx/${component}.onnx` || file === `onnx/${component}.onnx_data`),
  );
  const expectedTotal = expectedFiles.reduce((sum, [, size]) => sum + size, 0);
  const loadedByFile = new Map<string, number>();

  return (value: unknown) => {
    const raw = value as RawLoadProgress;
    const file = raw.file ?? raw.name ?? "正在读取模型文件…";
    const expectedSize = MODEL_FILE_SIZES[file];

    if (expectedSize) {
      const previous = loadedByFile.get(file) ?? 0;
      const reported = raw.status === "done"
        ? expectedSize
        : Math.min(expectedSize, Math.max(0, raw.loaded ?? 0));
      loadedByFile.set(file, Math.max(previous, reported));
    }

    const loadedTotal = [...loadedByFile.values()].reduce((sum, size) => sum + size, 0);
    const aggregate = 8 + Math.round((loadedTotal / expectedTotal) * 86);
    const allFilesRead = loadedTotal >= expectedTotal;
    postLoadProgress(
      Math.max(8, Math.min(94, aggregate)),
      allFilesRead ? "正在初始化语音模型…" : file,
      raw,
    );
  };
}

async function checkWebGpu() {
  const gpu = (navigator as Navigator & {
    gpu?: { requestAdapter: () => Promise<unknown | null> };
  }).gpu;
  if (!gpu) return { available: false, reason: "WebGPU is not supported by this browser." };
  try {
    const adapter = await gpu.requestAdapter();
    return adapter
      ? { available: true }
      : { available: false, reason: "No compatible graphics adapter was found." };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : "WebGPU check failed." };
  }
}

async function loadModel(device?: "webgpu" | "wasm") {
  postLoadProgress(2, "正在检查图形加速…");
  const webGpu = await checkWebGpu();
  const selectedDevice = device ?? (webGpu.available ? "webgpu" : "wasm");
  postLoadProgress(4, "正在准备文本处理器…");
  processor = await AutoProcessor.from_pretrained(MODEL_ID, {
    progress_callback: (progress: unknown) => {
      const raw = progress as RawLoadProgress;
      postLoadProgress(6, raw.file ?? "正在准备文本处理器…", raw);
    },
  });
  postLoadProgress(8, "正在读取本地模型…");
  model = await ChatterboxModel.from_pretrained(MODEL_ID, {
    device: selectedDevice,
    dtype: DTYPE_CONFIGS[selectedDevice],
    progress_callback: createModelProgressReporter(selectedDevice),
  });
  releaseDecoderCache = installFinalCacheCleanup(model);
  postLoadProgress(98, "正在完成初始化…");
  respond("load:complete", { device: selectedDevice, webgpu: webGpu.available });
}

async function encodeSpeaker(data: { id: string; audioData: ArrayBuffer }) {
  if (!model) throw new Error("Load the voice model first.");
  const audio = new Float32Array(data.audioData);
  const tensor = new Tensor("float32", audio, [1, audio.length]);
  try {
    const encoded = await (model as unknown as {
    encode_speech: (input: Tensor) => Promise<Record<string, Tensor>>;
  }).encode_speech(tensor);
    disposeSpeaker(data.id);
    speakerCache.set(data.id, encoded as Record<string, Tensor>);
    respond("encode_speaker:complete", { id: data.id });
  } finally {
    tensor.dispose();
  }
}

function disposeSpeaker(id: string) {
  for (const tensor of new Set(Object.values(speakerCache.get(id) ?? {}))) tensor.dispose();
  speakerCache.delete(id);
}

type GenerateSpeechRequest = { text: string; speakerId: string; exaggeration: number; samplingProfile?: unknown };

async function generateSpeech(data: GenerateSpeechRequest) {
  if (!model || !processor) throw new Error("Load the voice model first.");
  const speaker = speakerCache.get(data.speakerId);
  if (!speaker) throw new Error("The selected voice needs to be prepared again.");

  const inputs = await (processor as unknown as {
    _call: (text: string) => Promise<Record<string, Tensor>>;
  })._call(data.text);
  const expression = Math.max(0, Math.min(1.5, data.exaggeration));
  const startedAt = performance.now();
  let tokens = 0;
  let receivedPrompt = false;
  let endedNaturally = false;
  let lastProgress = 0;
  stoppingCriteria.reset();
  const eos = model.generation_config?.eos_token_id ?? [2, 6562];
  const eosIds = (Array.isArray(eos) ? eos : [eos]).filter((id) => id != null).map(String);
  const streamer = {
    put(ids: bigint[][]) {
      if (!receivedPrompt) { receivedPrompt = true; return; }
      tokens += ids[0]?.length ?? 0;
      endedNaturally = eosIds.includes(String(ids[0]?.at(-1)));
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs - lastProgress > 250 || tokens === 1) {
        lastProgress = elapsedMs;
        respond("generate:progress", { phase: "generating", tokens, elapsedMs });
      }
    },
    end() {
      respond("generate:progress", { phase: "decoding", tokens, elapsedMs: performance.now() - startedAt });
    },
  };
  let waveform: Tensor | undefined;
  try {
    waveform = await (model as unknown as {
    generate: (options: Record<string, unknown>) => Promise<Tensor>;
  }).generate({
    ...inputs,
    ...speaker,
    exaggeration: expression,
    do_sample: true,
    ...getSamplingSettings(data.samplingProfile),
    max_new_tokens: 640,
    streamer,
    stopping_criteria: [stoppingCriteria],
  });
  if (currentRequestId && cancelledRequests.has(currentRequestId)) {
    throw new DOMException("已停止生成。", "AbortError");
  }
  const inferenceTime = performance.now() - startedAt;
  const values = waveform.data as Float32Array;
  const buffer = values.slice().buffer;
  respond("generate:complete", { waveform: buffer, inferenceTime, truncated: !endedNaturally }, [buffer]);
  } finally {
    releaseDecoderCache?.();
    waveform?.dispose();
    for (const tensor of Object.values(inputs)) if (tensor instanceof Tensor) tensor.dispose();
  }
}

let requestQueue = Promise.resolve();
workerScope.addEventListener("message", (event: MessageEvent) => {
  const { type, data, requestId } = event.data as { type: string; requestId: string; data?: Record<string, unknown> };
  if (type === "cancel") {
    cancelledRequests.add(requestId);
    if (currentRequestId === requestId) stoppingCriteria.interrupt();
    return;
  }
  // ONNX sessions and conditioning tensors are shared; run one request at a time.
  requestQueue = requestQueue.then(async () => {
  currentRequestId = requestId;
  try {
    if (cancelledRequests.has(requestId)) throw new DOMException("已停止生成。", "AbortError");
    if (type === "check_webgpu") {
      respond("check_webgpu:complete", await checkWebGpu());
    } else if (type === "load") {
      await loadModel(data?.device as "webgpu" | "wasm" | undefined);
    } else if (type === "encode_speaker") {
      await encodeSpeaker(data as { id: string; audioData: ArrayBuffer });
    } else if (type === "generate") {
      await generateSpeech(data as GenerateSpeechRequest);
    } else if (type === "release_speaker") {
      disposeSpeaker(data?.id as string);
      respond("release_speaker:complete", {});
    } else {
      throw new Error(`Unknown worker message: ${type}`);
    }
  } catch (error) {
    respond("error", { message: error instanceof Error ? error.message : "Voice generation failed.", name: error instanceof Error ? error.name : "Error" });
  } finally {
    cancelledRequests.delete(requestId);
    currentRequestId = undefined;
  }
  });
});

export {};
