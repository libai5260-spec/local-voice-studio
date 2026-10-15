import TtsWorker from "./tts.worker?worker";
import type { SamplingProfile } from "./generation-settings";

type ResolvePair = {
  type: string;
  resolve: (value: never) => void;
  reject: (reason?: unknown) => void;
};

type LoadProgress = {
  status?: string;
  file?: string;
  name?: string;
  progress?: number;
  loaded?: number;
  total?: number;
};

let worker: Worker | null = null;
let modelLoaded = false;
let loadedDevice: "webgpu" | "wasm" | null = null;
let loadedWebGpu = false;
let loadPromise: Promise<{ device: "webgpu" | "wasm"; webgpu: boolean }> | null = null;
const pending = new Map<string, ResolvePair>();
const progressListeners = new Set<(progress: LoadProgress) => void>();
export type GenerationProgress = { phase: "generating" | "decoding"; tokens: number; elapsedMs: number };
const generationListeners = new Set<(progress: GenerationProgress) => void>();
let nextRequestId = 0;

function getWorker() {
  if (worker) return worker;
  worker = new TtsWorker();
  worker.addEventListener("message", (event: MessageEvent) => {
    const { type, data, requestId } = event.data as { type: string; data: never; requestId?: string };
    if (type === "load:progress") {
      progressListeners.forEach((listener) => listener(data as LoadProgress));
      return;
    }
    if (type === "generate:progress") {
      if (requestId && pending.has(requestId)) generationListeners.forEach((listener) => listener(data));
      return;
    }
    const callbacks = requestId ? pending.get(requestId) : undefined;
    if (type === "error") {
      const message = (data as { message?: string })?.message ?? "Voice generation failed.";
      const error = new Error(message);
      error.name = (data as { name?: string })?.name ?? "Error";
      callbacks?.reject(error);
      if (requestId) pending.delete(requestId);
      return;
    }
    if (callbacks) {
      callbacks.resolve(data);
      pending.delete(requestId!);
    }
  });
  worker.addEventListener("error", (event) => {
    event.preventDefault();
    const failedWorker = worker;
    worker = null;
    modelLoaded = false;
    failedWorker?.terminate();
    pending.forEach(({ reject }) => reject(new Error(event.message || "The voice model stopped.")));
    pending.clear();
  });
  return worker;
}

function send<T>(type: string, data: Record<string, unknown> = {}, transfer: Transferable[] = []) {
  const requestId = String(++nextRequestId);
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, {
      type,
      resolve: resolve as (value: never) => void,
      reject,
    });
    try {
      getWorker().postMessage({ type, data, requestId }, transfer);
    } catch (error) {
      pending.delete(requestId);
      reject(error);
    }
  });
}

export const ttsClient = {
  get isLoaded() {
    return modelLoaded;
  },
  checkWebGpu() {
    return send<{ available: boolean; reason?: string }>("check_webgpu");
  },
  async load(device?: "webgpu" | "wasm") {
    if (modelLoaded && loadedDevice) {
      return { device: loadedDevice, webgpu: loadedWebGpu };
    }
    if (loadPromise) return loadPromise;

    loadPromise = send<{ device: "webgpu" | "wasm"; webgpu: boolean }>("load", { device })
      .then((result) => {
        modelLoaded = true;
        loadedDevice = result.device;
        loadedWebGpu = result.webgpu;
        return result;
      })
      .finally(() => {
        loadPromise = null;
      });
    return loadPromise;
  },
  encodeSpeaker(id: string, audio: Float32Array) {
    const audioData = audio.slice().buffer;
    return send<{ id: string }>("encode_speaker", { id, audioData }, [audioData]);
  },
  async generate(text: string, speakerId: string, exaggeration: number, samplingProfile: SamplingProfile = "balanced") {
    const result = await send<{ waveform: ArrayBuffer; inferenceTime: number; truncated: boolean }>("generate", {
      text,
      speakerId,
      exaggeration,
      samplingProfile,
    });
    return {
      waveform: new Float32Array(result.waveform),
      inferenceTime: result.inferenceTime,
      truncated: result.truncated,
    };
  },
  cancelGeneration() {
    for (const [requestId, request] of pending) {
      if (request.type === "generate") worker?.postMessage({ type: "cancel", requestId });
    }
  },
  releaseSpeaker(id: string) {
    if (!worker) return Promise.resolve();
    return send("release_speaker", { id });
  },
  onGenerationProgress(listener: (progress: GenerationProgress) => void) {
    generationListeners.add(listener);
    return () => { generationListeners.delete(listener); };
  },
  onProgress(listener: (progress: LoadProgress) => void) {
    progressListeners.add(listener);
    return () => {
      progressListeners.delete(listener);
    };
  },
  reset() {
    worker?.terminate();
    worker = null;
    modelLoaded = false;
    loadedDevice = null;
    loadedWebGpu = false;
    loadPromise = null;
    pending.forEach(({ reject }) => reject(new Error("语音模型已重置，请重新生成。")));
    pending.clear();
  },
};
