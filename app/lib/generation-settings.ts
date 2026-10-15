export type SamplingProfile = "balanced" | "steady" | "expressive";

export const SAMPLING_PROFILES = [
  { id: "balanced", label: "均衡", description: "保留现有采样设置，兼顾稳定与自然变化。" },
  { id: "steady", label: "更稳定", description: "减少随机变化，适合长文；语气可能更克制。" },
  { id: "expressive", label: "更多变化", description: "增加语气变化，也可能更不稳定；建议先试听。" },
] as const satisfies ReadonlyArray<{ id: SamplingProfile; label: string; description: string }>;

// These are app presets, not a promise of better quality for every reference.
// This installed runtime implements temperature and top-k sampling, but not
// top-p filtering; keep the controls limited to parameters that actually work.
export function getSamplingSettings(profile: unknown): {
  temperature: number;
  top_k: number;
  repetition_penalty: number;
} {
  switch (profile) {
    case "steady":
      return { temperature: 0.65, top_k: 40, repetition_penalty: 1.2 };
    case "expressive":
      return { temperature: 0.9, top_k: 60, repetition_penalty: 1.2 };
    default:
      return { temperature: 0.8, top_k: 50, repetition_penalty: 1.2 };
  }
}
