import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(scriptDirectory, "../public/voice-samples");
const dataset = "saeedzou/vctk-16khz";
const datasetApi = "https://datasets-server.huggingface.co";

const speakers = [
  { id: "p294", region: "San Francisco", slot: "01" },
  { id: "p297", region: "New York", slot: "02" },
  { id: "p299", region: "California", slot: "03" },
  { id: "p300", region: "California", slot: "04" },
  { id: "p301", region: "North Carolina", slot: "05" },
  { id: "p305", region: "Philadelphia", slot: "06" },
  { id: "p306", region: "New York", slot: "07" },
  { id: "p308", region: "Alabama", slot: "08" },
  { id: "p310", region: "Tennessee", slot: "09" },
  { id: "p318", region: "Napa", slot: "10" },
];

let requestQueue = Promise.resolve();
let previousRequestAt = 0;

async function rateLimitedFetch(url, options) {
  const request = requestQueue.then(async () => {
    const wait = Math.max(0, 450 - (Date.now() - previousRequestAt));
    if (wait) await new Promise((resolveDelay) => setTimeout(resolveDelay, wait));
    previousRequestAt = Date.now();
    return fetch(url, options);
  });
  requestQueue = request.catch(() => undefined);
  return request;
}

async function requestJson(url, attempts = 8) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await rateLimitedFetch(url, {
        headers: { "user-agent": "Voice-Studio-VCTK-downloader/1.0" },
      });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        error.retryAfter = response.status === 429 ? 6_000 : 0;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const wait = error?.retryAfter || attempt * 800;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, wait));
      }
    }
  }
  throw lastError;
}

function audioSource(row) {
  const value = row.audio;
  if (Array.isArray(value)) return value.find((item) => item?.src)?.src;
  return value?.src;
}

function readWavDuration(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Downloaded reference is not a valid WAV file.");
  }

  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16) byteRate = buffer.readUInt32LE(body + 8);
    if (chunkId === "data") {
      dataSize = Math.min(chunkSize, buffer.length - body);
      break;
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  if (!byteRate || !dataSize) throw new Error("Downloaded WAV is missing audio data.");
  return dataSize / byteRate;
}

async function downloadAudio(url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      return { buffer, duration: readWavDuration(buffer) };
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 600));
    }
  }
  throw lastError;
}

function rankCandidate(row, speakerId) {
  const fileId = String(row.file_id ?? "");
  const textLength = String(row.text ?? "").length;
  if (fileId === `${speakerId}_003`) return 10_000;
  if (textLength >= 75 && textLength <= 180) return 1_000 + textLength;
  return textLength;
}

async function fetchSpeakerSample(speaker, filteredRows) {
  const rows = filteredRows.filter((row) => row?.speaker_id === speaker.id);

  if (!rows.length) throw new Error(`No utterances found for ${speaker.id}.`);
  if (rows.some((row) => row.gender !== "F" || row.accent !== "American")) {
    throw new Error(`${speaker.id} did not match female/American metadata.`);
  }

  const candidates = rows
    .filter((row) => audioSource(row))
    .sort((left, right) => rankCandidate(right, speaker.id) - rankCandidate(left, speaker.id));

  let fallback;
  for (const row of candidates.slice(0, 8)) {
    const audio = await downloadAudio(audioSource(row));
    fallback ??= { row, ...audio };
    if (audio.duration >= 5 && audio.duration <= 12) {
      return { speaker, row, ...audio };
    }
  }

  if (fallback) return { speaker, ...fallback };
  throw new Error(`Could not download an audio reference for ${speaker.id}.`);
}

await mkdir(outputDirectory, { recursive: true });
console.log("Filtering 10 verified American female VCTK speakers…");
const where = speakers
  .map((speaker) => `("speaker_id"='${speaker.id}' AND "file_id"='${speaker.id}_003')`)
  .join(" OR ");
const filterQuery = new URLSearchParams({
  dataset,
  config: "default",
  split: "train",
  where,
  offset: "0",
  length: "100",
});
const filteredPayload = await requestJson(`${datasetApi}/filter?${filterQuery}`);
const filteredRows = (filteredPayload.rows ?? []).map((entry) => entry.row);
for (const speaker of speakers) {
  if (filteredRows.some((row) => row?.speaker_id === speaker.id)) continue;
  const fallbackQuery = new URLSearchParams({
    dataset,
    config: "default",
    split: "train",
    where: `"speaker_id"='${speaker.id}'`,
    offset: "0",
    length: "100",
  });
  const fallbackPayload = await requestJson(`${datasetApi}/filter?${fallbackQuery}`);
  filteredRows.push(...(fallbackPayload.rows ?? []).map((entry) => entry.row));
}
const samples = await Promise.all(speakers.map((speaker) => fetchSpeakerSample(speaker, filteredRows)));

const manifest = [];
for (const sample of samples) {
  const filename = `US-Female-${sample.speaker.slot}-${sample.speaker.id}.wav`;
  await writeFile(resolve(outputDirectory, filename), sample.buffer);
  manifest.push({
    file: filename,
    speaker_id: sample.row.speaker_id,
    age: sample.row.age,
    gender: sample.row.gender,
    accent: sample.row.accent,
    region: sample.row.region || sample.speaker.region,
    utterance: sample.row.file_id,
    duration_seconds: Number(sample.duration.toFixed(2)),
    text: sample.row.text,
    bytes: sample.buffer.length,
  });
  console.log(`Saved ${filename} (${sample.duration.toFixed(1)}s)`);
}

console.log(JSON.stringify(manifest, null, 2));
