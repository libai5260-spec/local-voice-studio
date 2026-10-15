import { planSpeech, type SpeechChunk } from "./text";

export type DirectedSpeechChunk = SpeechChunk & { pauseAfter?: number };

// These exact tokens are present as special tokens in the bundled full
// onnx-community/chatterbox-ONNX tokenizer. Token support does not guarantee
// that every generated take will express the requested sound naturally.
const NATIVE_CUES = new Set([
  "laughter", "giggle", "sigh", "gasp", "cough", "clear_throat", "whisper",
]);
const CUE_ALIASES: Record<string, string> = { laugh: "laughter", chuckle: "giggle" };
const PAUSES: Record<string, number> = { pause: 0.35, "long pause": 0.75 };

function hasProse(text: string) {
  return /[\p{L}\p{N}]/u.test(text.replace(/\[[^\[\]]*\]/g, ""));
}

function planWithCues(text: string, maximumLength: number, maximumWords: number): SpeechChunk[] {
  // Keep a multi-word Fish instruction atomic while the sentence planner works.
  // Equal-width placeholders preserve its character budget for ordinary cues.
  const cues = new Map<string, string>();
  const protectedText = text.replace(/\[[^\[\]]*\]/g, (cue) => {
    const id = cues.size.toString(36);
    const placeholder = `\uE000${id}\uE001` + "\uE002".repeat(Math.max(0, cue.length - id.length - 2));
    cues.set(placeholder, cue);
    return placeholder;
  });
  const planned: SpeechChunk[] = [];
  let pendingCues = "";
  for (const chunk of planSpeech(protectedText, maximumLength, maximumWords)) {
    let restored = chunk.text;
    for (const [placeholder, cue] of cues) restored = restored.replaceAll(placeholder, cue);
    if (!hasProse(restored)) {
      pendingCues += restored + " ";
      continue;
    }
    planned.push({ ...chunk, text: pendingCues + restored });
    pendingCues = "";
  }
  // A closing nonverbal cue belongs to the last spoken segment, not a separate
  // generation request with no prose. A cue-only document produces no segments.
  if (pendingCues && planned.length) planned[planned.length - 1].text += " " + pendingCues.trim();
  return planned;
}

/**
 * Keep supported model cues in chunks, but exclude every directive from
 * spokenText (the actual prose used for counts and empty-script validation).
 * pauseAfter overrides the ordinary boundary pause. A trailing pause remains
 * metadata only: the audio joiner does not append silence after the last take.
 */
export function prepareScript(text: string, engine: "chatterbox" | "fish" = "chatterbox"): {
  chunks: DirectedSpeechChunk[];
  spokenText: string;
  warnings: string[];
} {
  const chunks: DirectedSpeechChunk[] = [];
  const spoken: string[] = [];
  const warnings = new Set<string>();
  let buffer = "";
  let offset = 0;

  const flush = () => {
    // A cue inserted just before punctuation should not create a standalone
    // punctuation-only utterance. Keep that punctuation with the prior words.
    if (chunks.length) {
      const punctuation = buffer.match(/^\s*([,.!?;:]+)(?=\s|$)/);
      if (punctuation) {
        chunks[chunks.length - 1].text += punctuation[1];
        buffer = buffer.slice(punctuation[0].length);
      }
    }
    if (!hasProse(buffer)) return;
    chunks.push(...planWithCues(buffer, engine === "fish" ? 450 : 220, engine === "fish" ? 70 : 36));
    buffer = "";
  };

  for (const match of text.matchAll(/\[([^\[\]]*)\]/g)) {
    const plain = text.slice(offset, match.index);
    buffer += plain;
    spoken.push(plain, " ");
    const label = match[1].trim().toLowerCase().replace(/\s+/g, " ");
    const pause = Object.hasOwn(PAUSES, label) ? PAUSES[label] : undefined;
    if (pause !== undefined) {
      flush();
      const previous = chunks.at(-1);
      if (previous) {
        const requested = (previous.pauseAfter ?? 0) + pause;
        previous.pauseAfter = Math.min(2, Math.round(requested * 100) / 100);
        if (requested > 2) warnings.add("连续停顿已限制为最多 2 秒，避免出现过长空白。");
      } else {
        warnings.add("已忽略开头的停顿；请把停顿放在需要朗读的文字之后。");
      }
    } else {
      const cue = Object.hasOwn(CUE_ALIASES, label) ? CUE_ALIASES[label] : label;
      if (engine === "fish") {
        // Fish supports free-form bracket instructions. Preserve user spelling
        // instead of translating Chatterbox labels into unverified aliases.
        buffer += ` ${match[0]} `;
      } else if (NATIVE_CUES.has(cue)) {
        buffer += ` [${cue}] `;
      } else {
        // Do not let Fish-specific emotion labels become literal spoken words.
        buffer += " ";
        warnings.add(`已忽略当前本地模型不支持的指令 [${label}]；请使用停顿、标点或已提供的声音提示。`);
      }
    }
    offset = match.index! + match[0].length;
  }
  const tail = text.slice(offset);
  buffer += tail;
  spoken.push(tail);
  flush();
  if (buffer.trim() && chunks.length) chunks[chunks.length - 1].text += " " + buffer.trim();
  const prose = spoken.join("").replace(/\s+/g, " ").trim();
  const spokenText = hasProse(prose) ? prose : "";
  return { chunks: spokenText ? chunks : [], spokenText, warnings: [...warnings] };
}

/** Insert before a selection without deleting the selected prose. */
export function insertScriptCue(text: string, cue: string, selectionStart: number, selectionEnd: number): {
  text: string;
  cursor: number;
} {
  const clamp = (value: number) => Number.isFinite(value)
    ? Math.max(0, Math.min(text.length, Math.trunc(value)))
    : text.length;
  const start = Math.min(clamp(selectionStart), clamp(selectionEnd));
  const cleanCue = cue.trim();
  if (!cleanCue) return { text, cursor: start };
  const before = text.slice(0, start);
  const after = text.slice(start);
  const inserted = `${before && !/\s$/.test(before) ? " " : ""}${cleanCue}${after && !/^\s/.test(after) ? " " : ""}`;
  return { text: before + inserted + after, cursor: before.length + inserted.length };
}

/** A short, complete first segment; never mutate the full generation plan. */
export function buildAuditionPlan(chunks: DirectedSpeechChunk[]): DirectedSpeechChunk[] {
  if (!chunks.length) return [];
  const first = planWithCues(chunks[0].text, 220, 36)[0];
  if (!first) return [];
  // A partial audition must not inherit a pause intended for the full segment.
  return [{ ...first, ...(first.text === chunks[0].text ? { pauseAfter: chunks[0].pauseAfter } : {}) }];
}
