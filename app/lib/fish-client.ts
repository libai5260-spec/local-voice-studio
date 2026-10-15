import { encodeWavAsync } from "./audio";
import type { SamplingProfile } from "./generation-settings";

const BASE = "http://127.0.0.1:7861";
export type FishHealth = { status: "missing" | "loading" | "ready" | "generating" | "error" | "offline"; model?: string; sample_rate?: number; error?: string; download_bytes?: number; download_total_bytes?: number; download_active?: boolean };
let activeRequest: { id: string; controller: AbortController } | null = null;

async function responseError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return new Error(body?.error ?? `本地 Fish 服务返回 ${response.status}，请稍后重试。`);
}

export const fishClient = {
  async health(): Promise<FishHealth> {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw await responseError(response);
      return await response.json();
    } catch {
      return { status: "offline", error: "本地 Fish 服务未启动，请使用一键启动器打开网站。" };
    }
  },
  async load() {
    const response = await fetch(`${BASE}/load`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw await responseError(response);
  },
  async generate(text: string, reference: Float32Array, referenceText: string, profile: SamplingProfile, instruct: string) {
    if (activeRequest) throw new Error("上一段语音仍在生成，请稍候。");
    if (!referenceText.trim()) throw new Error("Fish 模型需要参考录音对应的英文原文，请先填写并保存。");
    const request = { id: crypto.randomUUID(), controller: new AbortController() };
    activeRequest = request;
    try {
      const blob = await encodeWavAsync(reference, () => request.controller.signal.aborted);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      const response = await fetch(`${BASE}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text, reference_audio: btoa(binary), reference_text: referenceText.trim(), instruct,
          temperature: profile === "steady" ? 0.6 : profile === "expressive" ? 0.8 : 0.7,
          top_p: profile === "steady" ? 0.65 : profile === "expressive" ? 0.85 : 0.7,
          request_id: request.id,
          seed: crypto.getRandomValues(new Uint32Array(1))[0],
        }),
        signal: request.controller.signal,
      });
      if (!response.ok) throw await responseError(response);
      const context = new OfflineAudioContext(1, 1, 44_100);
      const decoded = await context.decodeAudioData(await response.arrayBuffer());
      request.controller.signal.throwIfAborted();
      return { waveform: decoded.getChannelData(0).slice(), truncated: false };
    } finally {
      if (activeRequest === request) activeRequest = null;
    }
  },
  cancel() {
    const request = activeRequest;
    if (!request) return;
    request.controller.abort();
    void fetch(`${BASE}/cancel`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: request.id }), signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  },
};
