export const SAMPLE_RATE = 24_000;

async function yieldToBrowser() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// Export long recordings in small batches so controls and playback stay responsive.
export async function encodeWavAsync(audio: Float32Array, isCancelled = () => false, sampleRate = SAMPLE_RATE) {
  const header = await encodeWav(new Float32Array(), sampleRate).arrayBuffer();
  const view = new DataView(header);
  view.setUint32(4, 36 + audio.length * 2, true);
  view.setUint32(40, audio.length * 2, true);
  const blocks: BlobPart[] = [header];
  for (let start = 0; start < audio.length; start += 262_144) {
    if (isCancelled()) throw new DOMException("已停止处理。", "AbortError");
    const count = Math.min(262_144, audio.length - start);
    const bytes = new ArrayBuffer(count * 2);
    const block = new DataView(bytes);
    for (let index = 0; index < count; index += 1) {
      const value = Math.max(-1, Math.min(1, audio[start + index]));
      block.setInt16(index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    }
    blocks.push(bytes);
    await yieldToBrowser();
  }
  return new Blob(blocks, { type: "audio/wav" });
}

export function encodeWav(audio: Float32Array, sampleRate = SAMPLE_RATE) {
  const dataSize = audio.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let index = 0; index < audio.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, audio[index]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export async function encodeMp3(audio: Float32Array, sampleRate = SAMPLE_RATE) {
  const lame = await import("@breezystack/lamejs");
  const encoder = new lame.Mp3Encoder(1, sampleRate, 128);
  const samples = new Int16Array(1152);
  const blocks: BlobPart[] = [];
  for (let offset = 0; offset < audio.length; offset += 1152) {
    const count = Math.min(1152, audio.length - offset);
    for (let index = 0; index < count; index += 1) {
      const sample = Math.max(-1, Math.min(1, audio[offset + index]));
      samples[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    const encoded = encoder.encodeBuffer(samples.subarray(0, count));
    if (encoded.length) blocks.push(new Uint8Array(encoded));
    if ((offset / 1152) % 16 === 15) await yieldToBrowser();
  }

  const tail = encoder.flush();
  if (tail.length) blocks.push(new Uint8Array(tail));
  return new Blob(blocks, { type: "audio/mpeg" });
}

export function concatenateAudio(parts: Float32Array[], pauseSeconds = 0.18) {
  const silence = new Float32Array(Math.round(SAMPLE_RATE * pauseSeconds));
  const total = parts.reduce((sum, part) => sum + part.length, 0) +
    Math.max(0, parts.length - 1) * silence.length;
  const combined = new Float32Array(total);
  let offset = 0;

  parts.forEach((part, index) => {
    combined.set(part, offset);
    offset += part.length;
    if (index < parts.length - 1) {
      combined.set(silence, offset);
      offset += silence.length;
    }
  });

  return combined;
}

// Detect only outer silence, retaining quiet consonants and breath tails.
// Internal speech and its timing are left untouched.
function speechEdges(audio: Float32Array, sampleRate: number) {
  const frame = Math.max(1, Math.round(sampleRate * 0.005)); // 5 ms at the native rate
  const levels: number[] = [];
  let peak = 0;
  for (let start = 0; start < audio.length; start += frame) {
    const end = Math.min(start + frame, audio.length);
    let energy = 0;
    for (let index = start; index < end; index += 1) energy += audio[index] ** 2;
    const rms = Math.sqrt(energy / (end - start));
    peak = Math.max(peak, rms);
    levels.push(rms);
  }
  const threshold = Math.max(0.0001, Math.min(0.001, peak * 0.01));
  const first = levels.findIndex((rms) => rms > threshold);
  const last = levels.findLastIndex((rms) => rms > threshold);
  if (first < 0) return { start: 0, end: audio.length, leading: 0, trailing: 0 };
  const padding = Math.round(sampleRate * 0.04);
  const speechStart = first * frame;
  const speechEnd = Math.min(audio.length, (last + 1) * frame);
  const start = Math.max(0, speechStart - padding);
  const end = Math.min(audio.length, speechEnd + padding);
  return { start, end, leading: speechStart - start, trailing: end - speechEnd };
}

export async function joinSpeech(
  parts: Float32Array[],
  pauses: number[],
  isCancelled = () => false,
  sampleRate = SAMPLE_RATE,
) {
  const edges = [];
  const gaps: number[] = [];
  let total = 0;
  for (const part of parts) {
    if (isCancelled()) throw new DOMException("已停止生成。", "AbortError");
    const edge = speechEdges(part, sampleRate);
    edges.push(edge);
    total += edge.end - edge.start;
    await yieldToBrowser();
  }
  for (let index = 0; index < parts.length - 1; index += 1) {
    // Account for the silence already present, instead of stacking pauses.
    const gap = Math.max(0, Math.round((pauses[index] ?? 0.24) * sampleRate) -
      edges[index].trailing - edges[index + 1].leading);
    gaps.push(gap);
    total += gap;
  }
  const combined = new Float32Array(total);
  let destination = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const edge = edges[index];
    const count = edge.end - edge.start;
    for (let source = edge.start; source < edge.end; source += 262_144) {
      if (isCancelled()) throw new DOMException("已停止生成。", "AbortError");
      const length = Math.min(262_144, edge.end - source);
      combined.set(parts[index].subarray(source, source + length), destination + source - edge.start);
      await yieldToBrowser();
    }
    // A 3 ms edge fade suppresses splice clicks, without overlapping speech.
    const fade = Math.min(Math.round(sampleRate * 0.003), Math.floor(count / 2));
    for (let sample = 0; sample < fade; sample += 1) {
      const gain = sample / Math.max(1, fade - 1);
      combined[destination + sample] *= gain;
      combined[destination + count - 1 - sample] *= gain;
    }
    destination += count + (gaps[index] ?? 0);
  }
  return combined;
}

export function applyAudioControls(
  audio: Float32Array,
  speed: number,
  pitchSemitones: number,
) {
  const naturalSpeed = clamp(speed, 0.86, 1.16);
  const naturalPitch = clamp(pitchSemitones, -1.5, 1.5);
  if (Math.abs(naturalSpeed - 1) < 0.001 && Math.abs(naturalPitch) < 0.01) {
    return audio.slice();
  }

  // Pitch is changed with cubic interpolation, then WSOLA restores the desired
  // duration while aligning each overlap to the speech waveform. The previous
  // fixed overlap-add path did not align phases and created a metallic sound.
  const pitchFactor = 2 ** (naturalPitch / 12);
  const pitched = resampleCubic(audio, pitchFactor);
  const targetLength = Math.max(1, Math.round(audio.length / naturalSpeed));
  return finishSpeech(wsolaStretch(pitched, targetLength));
}

export function prepareVoiceReference(audio: Float32Array) {
  if (!audio.length) return audio.slice();

  const cleaned = audio.slice();
  let mean = 0;
  for (const sample of cleaned) mean += Number.isFinite(sample) ? sample : 0;
  mean /= cleaned.length;
  for (let index = 0; index < cleaned.length; index += 1) {
    cleaned[index] = Number.isFinite(cleaned[index]) ? cleaned[index] - mean : 0;
  }

  // Remove only leading/trailing silence. Gating the middle of speech damages
  // consonants and makes the cloned result sound synthetic.
  const frameSize = Math.round(SAMPLE_RATE * 0.02);
  const frameRms: number[] = [];
  for (let offset = 0; offset < cleaned.length; offset += frameSize) {
    const end = Math.min(cleaned.length, offset + frameSize);
    let energy = 0;
    for (let index = offset; index < end; index += 1) energy += cleaned[index] * cleaned[index];
    frameRms.push(Math.sqrt(energy / Math.max(1, end - offset)));
  }
  const strongestFrame = Math.max(...frameRms, 0);
  const silenceThreshold = Math.max(0.003, strongestFrame * 0.06);
  let firstFrame = frameRms.findIndex((value) => value >= silenceThreshold);
  let lastFrame = frameRms.findLastIndex((value) => value >= silenceThreshold);
  if (firstFrame < 0 || lastFrame < firstFrame) {
    firstFrame = 0;
    lastFrame = frameRms.length - 1;
  }
  const marginFrames = 6;
  const start = Math.max(0, (firstFrame - marginFrames) * frameSize);
  const end = Math.min(cleaned.length, (lastFrame + marginFrames + 1) * frameSize);
  const maximumLength = SAMPLE_RATE * 10;
  const reference = cleaned.slice(start, Math.min(end, start + maximumLength));

  let energy = 0;
  let peak = 0;
  for (const sample of reference) {
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(energy / Math.max(1, reference.length));
  const targetRms = 0.11;
  const gain = rms > 1e-5 ? Math.min(4, targetRms / rms, 0.96 / Math.max(peak, 1e-5)) : 1;
  const edgeSamples = Math.min(Math.round(SAMPLE_RATE * 0.01), Math.floor(reference.length / 2));
  for (let index = 0; index < reference.length; index += 1) {
    let edgeGain = 1;
    if (index < edgeSamples) edgeGain = index / Math.max(1, edgeSamples - 1);
    if (index >= reference.length - edgeSamples) {
      edgeGain = Math.min(edgeGain, (reference.length - 1 - index) / Math.max(1, edgeSamples - 1));
    }
    reference[index] *= gain * edgeGain;
  }
  return reference;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Resolve only when playback finishes, not when HTMLAudioElement.play() starts.
export async function playAudio(audio: Float32Array, signal?: AbortSignal, sampleRate = SAMPLE_RATE) {
  const blob = await encodeWavAsync(audio, () => signal?.aborted ?? false, sampleRate);
  signal?.throwIfAborted();
  const player = new Audio();
  const url = URL.createObjectURL(blob);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      player.removeEventListener("ended", onEnded);
      player.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      player.pause();
      player.removeAttribute("src");
      player.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve();
    };
    const onEnded = () => finish();
    const onError = () => finish(new Error("音频播放失败，请重试。"));
    const onAbort = () => finish(new DOMException("播放已取消", "AbortError"));
    player.addEventListener("ended", onEnded);
    player.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    player.src = url;
    try {
      void player.play().catch(finish);
    } catch (error) {
      finish(error);
    }
  });
}

function resampleCubic(input: Float32Array, playbackRate: number) {
  if (Math.abs(playbackRate - 1) < 0.001) return input.slice();
  const outputLength = Math.max(1, Math.round(input.length / playbackRate));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * playbackRate;
    const center = Math.floor(position);
    const fraction = position - center;
    const previous = input[Math.max(0, center - 1)];
    const current = input[Math.min(input.length - 1, center)];
    const next = input[Math.min(input.length - 1, center + 1)];
    const following = input[Math.min(input.length - 1, center + 2)];
    const a = (-0.5 * previous) + (1.5 * current) - (1.5 * next) + (0.5 * following);
    const b = previous - (2.5 * current) + (2 * next) - (0.5 * following);
    const c = (-0.5 * previous) + (0.5 * next);
    output[index] = ((a * fraction + b) * fraction + c) * fraction + current;
  }

  return output;
}

function wsolaStretch(input: Float32Array, targetLength: number) {
  if (input.length < 3072 || Math.abs(targetLength - input.length) < 48) {
    return resampleCubicToLength(input, targetLength);
  }

  const frameSize = 2048;
  const synthesisHop = 512;
  const overlapSize = frameSize - synthesisHop;
  const analysisHop = (input.length / targetLength) * synthesisHop;
  const searchRadius = 288;
  const output = new Float32Array(targetLength + frameSize);
  output.set(input.subarray(0, Math.min(frameSize, input.length)));

  let inputOffset = 0;
  for (let outputOffset = synthesisHop; outputOffset < targetLength; outputOffset += synthesisHop) {
    const predicted = inputOffset + analysisHop;
    const minimum = Math.max(0, Math.round(predicted - searchRadius));
    const maximum = Math.min(input.length - frameSize, Math.round(predicted + searchRadius));
    if (maximum <= minimum) break;

    inputOffset = findBestOverlap(input, output, outputOffset, minimum, maximum, overlapSize);

    const available = Math.min(frameSize, input.length - inputOffset, output.length - outputOffset);
    for (let index = 0; index < available; index += 1) {
      const incoming = input[inputOffset + index];
      if (index < overlapSize) {
        const phase = index / Math.max(1, overlapSize - 1);
        const fadeIn = 0.5 - 0.5 * Math.cos(Math.PI * phase);
        output[outputOffset + index] = output[outputOffset + index] * (1 - fadeIn) + incoming * fadeIn;
      } else {
        output[outputOffset + index] = incoming;
      }
    }
  }

  return output.slice(0, targetLength);
}

function findBestOverlap(
  input: Float32Array,
  output: Float32Array,
  outputOffset: number,
  minimum: number,
  maximum: number,
  overlapSize: number,
) {
  let bestOffset = minimum;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let candidate = minimum; candidate <= maximum; candidate += 3) {
    let correlation = 0;
    let inputEnergy = 1e-9;
    let outputEnergy = 1e-9;
    for (let index = 0; index < overlapSize; index += 6) {
      const incoming = input[candidate + index];
      const existing = output[outputOffset + index];
      correlation += incoming * existing;
      inputEnergy += incoming * incoming;
      outputEnergy += existing * existing;
    }
    const score = correlation / Math.sqrt(inputEnergy * outputEnergy);
    if (score > bestScore) {
      bestScore = score;
      bestOffset = candidate;
    }
  }

  return bestOffset;
}

function resampleCubicToLength(input: Float32Array, targetLength: number) {
  if (input.length === targetLength) return input.slice();
  return resampleCubic(input, input.length / targetLength);
}

function finishSpeech(audio: Float32Array) {
  const edgeSamples = Math.min(Math.round(SAMPLE_RATE * 0.008), Math.floor(audio.length / 2));
  for (let index = 0; index < edgeSamples; index += 1) {
    const gain = index / Math.max(1, edgeSamples - 1);
    audio[index] *= gain;
    audio[audio.length - 1 - index] *= gain;
  }

  let peak = 0;
  for (const sample of audio) peak = Math.max(peak, Math.abs(sample));
  if (peak <= 0.94 || peak === 0) return audio;
  const gain = 0.94 / peak;
  for (let index = 0; index < audio.length; index += 1) audio[index] *= gain;
  return audio;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}
