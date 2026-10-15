export type SpeechBoundary = "continuation" | "clause" | "sentence" | "paragraph";
export type SpeechChunk = { text: string; boundary: SpeechBoundary };

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "etc", "vs", "inc", "ltd",
  "e.g", "i.e", "no", "fig", "dept",
]);

// Keep the same limits at every pace to avoid constantly resetting intonation.
export function planSpeech(text: string, maximumLength = 220, maximumWords = 36): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  for (const paragraph of text.trim().split(/\n\s*\n/).filter(Boolean)) {
    const sentences = splitSentences(paragraph.replace(/\s+/g, " ").trim());
    const paragraphChunks: SpeechChunk[] = [];
    for (const sentence of sentences) {
      for (const piece of splitLongSentence(sentence, maximumLength, maximumWords)) {
        const previous = paragraphChunks.at(-1);
        const merged = previous ? previous.text + " " + piece.text : "";
        if (previous?.boundary === "sentence" && merged.length <= maximumLength &&
          merged.split(/\s+/).length <= maximumWords) {
          previous.text = merged;
          previous.boundary = piece.boundary;
        } else {
          paragraphChunks.push(piece);
        }
      }
    }
    if (paragraphChunks.length) paragraphChunks[paragraphChunks.length - 1].boundary = "paragraph";
    chunks.push(...paragraphChunks);
  }
  return chunks;
}

export function splitText(text: string, maximumLength = 220) {
  return planSpeech(text, maximumLength).map((chunk) => chunk.text);
}

function splitSentences(text: string) {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!".!?".includes(text[index])) continue;
    if (text[index] === "." && isAbbreviation(text.slice(start, index + 1))) continue;
    let end = index + 1;
    while (end < text.length && /[.!?"'”’\])]/.test(text[end])) end += 1;
    if (end < text.length && !/\s/.test(text[end])) continue;
    sentences.push(text.slice(start, end).trim());
    start = end;
    index = end - 1;
  }
  if (text.slice(start).trim()) sentences.push(text.slice(start).trim());
  return sentences;
}

function isAbbreviation(text: string) {
  const token = text.match(/([^\s]+)\.$/)?.[1] ?? "";
  return ABBREVIATIONS.has(token.toLowerCase()) || /^(?:[A-Za-z]\.)*[A-Za-z]$/.test(token);
}

function splitLongSentence(text: string, maximumLength: number, maximumWords: number): SpeechChunk[] {
  const words = text.split(/\s+/);
  const chunks: SpeechChunk[] = [];
  let start = 0;
  while (start < words.length) {
    let end = start;
    let length = 0;
    while (end < words.length && end - start < maximumWords) {
      const nextLength = length + (end > start ? 1 : 0) + words[end].length;
      if (nextLength > maximumLength && end > start) break;
      length = nextLength;
      end += 1;
    }
    if (end < words.length) {
      for (let candidate = end; candidate > start + Math.floor((end - start) / 2); candidate -= 1) {
        if (/[,;:—]["”’']?$/.test(words[candidate - 1])) { end = candidate; break; }
      }
    }
    const part = words.slice(start, end).join(" ");
    chunks.push({ text: part, boundary: end === words.length ? "sentence" : /[,;:—]["”’']?$/.test(part) ? "clause" : "continuation" });
    start = end;
  }
  return chunks;
}

export function boundaryPause(boundary: SpeechBoundary, pace: "relaxed" | "natural" | "brisk") {
  const pauses = { continuation: 0.06, clause: 0.12, sentence: 0.24, paragraph: 0.42 };
  return pauses[boundary] * (pace === "relaxed" ? 1.3 : pace === "brisk" ? 0.7 : 1);
}
