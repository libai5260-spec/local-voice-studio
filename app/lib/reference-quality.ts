// Signal-level checks only: this is not speech recognition or noise removal.
export function inspectReference(audio: Float32Array, sampleRate = 24_000) {
  let energy = 0;
  let peak = 0;
  let clipped = 0;
  let invalid = 0;
  for (const sample of audio) {
    if (!Number.isFinite(sample)) { invalid++; continue; }
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if (Math.abs(sample) >= 0.999) clipped++;
  }
  const duration = audio.length / sampleRate;
  const rms = Math.sqrt(energy / Math.max(1, audio.length));
  const warnings: string[] = [];
  const usable = audio.length > 0 && invalid === 0 && rms >= 0.0001 && peak >= 0.003;
  if (!usable) warnings.push("没有检测到可用声音，请重新录制或选择有效音频。");
  else {
    if (duration < 5) warnings.push("样本较短，建议使用 5–10 秒连续、自然的说话录音。");
    if (rms < 0.012) warnings.push("录音音量偏低，建议靠近麦克风重新录制。");
    if (clipped / audio.length > 0.005) warnings.push("录音可能有破音，请降低麦克风增益重新录制。");
  }
  return { usable, duration, rms, peak, warnings };
}
