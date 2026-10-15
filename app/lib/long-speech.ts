import { planSpeech, type SpeechChunk } from "./text";

export type SpeechPart = SpeechChunk & { pauseAfter?: number; waveform: Float32Array };

export async function generateLongSpeech(plan: (SpeechChunk & { pauseAfter?: number })[], options: {
  generate: (text: string) => Promise<{ waveform: Float32Array; truncated?: boolean }>;
  isCancelled: () => boolean;
  onChunk: (completed: number, total: number, text: string, retrying: boolean) => void;
}) {
  const queue = plan.map((chunk) => ({ ...chunk, retries: 0, audioRetries: 0 }));
  const parts: SpeechPart[] = [];
  const checkCancelled = () => {
    if (options.isCancelled()) throw new DOMException("已停止生成。", "AbortError");
  };
  while (queue.length) {
    checkCancelled();
    const chunk = queue.shift()!;
    options.onChunk(parts.length, parts.length + queue.length + 1, chunk.text, chunk.retries > 0 || chunk.audioRetries > 0);
    const result = await options.generate(chunk.text);
    checkCancelled();
    if (result.truncated) {
      const smaller = planSpeech(chunk.text, Math.max(24, Math.floor(chunk.text.length / 2)), 18);
      if (chunk.retries >= 2 || smaller.length < 2) {
        throw new Error("这段语音未能完整生成，请缩短或改写后重试：" + chunk.text.slice(0, 70));
      }
      smaller[smaller.length - 1].boundary = chunk.boundary;
      queue.unshift(...smaller.map((part, index) => ({ ...part, retries: chunk.retries + 1, audioRetries: 0, pauseAfter: index === smaller.length - 1 ? chunk.pauseAfter : undefined })));
      continue;
    }
    if (!result.waveform.length || !result.waveform.every(Number.isFinite)) {
      throw new Error("模型返回了无效音频，请重试。");
    }
    if (!result.waveform.some((sample) => Math.abs(sample) > 0.0001)) {
      if (chunk.audioRetries < 1) { queue.unshift({ ...chunk, audioRetries: chunk.audioRetries + 1 }); continue; }
      throw new Error("这段生成结果接近静音，请更换参考音色或改写后重试。");
    }
    parts.push({ text: chunk.text, boundary: chunk.boundary, pauseAfter: chunk.pauseAfter, waveform: result.waveform });
  }
  checkCancelled();
  options.onChunk(parts.length, parts.length, "", false);
  return parts;
}
