import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function moduleUrl(name, replacements = {}) {
  const source = await readFile(new URL("../app/lib/" + name + ".ts", import.meta.url), "utf8");
  let js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  for (const [specifier, replacement] of Object.entries(replacements)) {
    js = js.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
  }
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

const textUrl = await moduleUrl("text");
const { planSpeech, boundaryPause } = await import(textUrl);
const { generateLongSpeech } = await import(await moduleUrl("long-speech", { "./text": textUrl }));
const { joinSpeech, SAMPLE_RATE, encodeWav, encodeWavAsync } = await import(await moduleUrl("audio"));
const { installFinalCacheCleanup } = await import(await moduleUrl("inference-resources"));

test("long prose preserves every word and respects both character and word budgets", () => {
  const paragraph = 'Dr. Smith paid $3.50 in the U.S. shop. "Are you ready?" she asked. ' +
    "The evening was quiet, and everyone at the table listened carefully as she explained the plan, " +
    "because each small detail would help them understand what was going to happen next.";
  const text = Array.from({ length: 100 }, () => paragraph).join("\n\n");
  const chunks = planSpeech(text);
  assert.equal(chunks.map((part) => part.text).join(" "), text.replace(/\s+/g, " ").trim());
  assert.ok(chunks.every((part) => part.text.length <= 220 && part.text.split(/\s+/).length <= 36));
  assert.ok(chunks.some((part) => part.text.includes("Dr. Smith")));
  assert.ok(chunks.some((part) => part.text.includes("$3.50")));
  assert.equal(chunks.filter((part) => part.boundary === "paragraph").length, 100);
});

test("short adjacent sentences share intonation context and word-heavy text stays bounded", () => {
  assert.equal(planSpeech("Hello there. It is good to see you.")[0].text, "Hello there. It is good to see you.");
  const manyWords = ("I am at a bay and I am on a boat ").repeat(15).trim();
  assert.ok(planSpeech(manyWords).every((part) => part.text.split(/\s+/).length <= 36));
  assert.deepEqual(planSpeech("  \n\n "), []);
});

test("a truncated segment is discarded, split and retried in order without losing words", async () => {
  const text = "We followed the river through the valley, and watched the sunlight slowly disappear behind the distant mountains.";
  let first = true;
  const processed = [];
  const parts = await generateLongSpeech(planSpeech(text), {
    generate: async (segment) => {
      if (first) { first = false; return { waveform: new Float32Array([999]), truncated: true }; }
      processed.push(segment);
      return { waveform: new Float32Array([0.1, 0.2]), truncated: false };
    },
    isCancelled: () => false,
    onChunk() {},
  });
  assert.ok(parts.length > 1);
  assert.equal(processed.join(" "), text);
  assert.ok(parts.every((part) => part.waveform[0] !== 999));
  assert.equal(parts.at(-1).boundary, "paragraph");
});

test("cancellation during the final segment cannot be reported as a complete recording", async () => {
  let cancelled = false;
  await assert.rejects(generateLongSpeech(planSpeech("Hello there."), {
    generate: async () => { cancelled = true; return { waveform: new Float32Array([0.1]) }; },
    isCancelled: () => cancelled,
    onChunk() {},
  }), { name: "AbortError" });
});

test("repeated truncation is bounded and does not silently return incomplete speech", async () => {
  let attempts = 0;
  await assert.rejects(generateLongSpeech(planSpeech("The long road leads through the valley and over the hill."), {
    generate: async () => { attempts++; return { waveform: new Float32Array([0.1]), truncated: true }; },
    isCancelled: () => false,
    onChunk() {},
  }), /未能完整生成/);
  assert.ok(attempts <= 3);
});

function paddedSpeech() {
  const audio = new Float32Array(SAMPLE_RATE * 2);
  for (let index = SAMPLE_RATE / 2; index < SAMPLE_RATE * 1.5; index++) {
    audio[index] = 0.2 * Math.sin(2 * Math.PI * 220 * index / SAMPLE_RATE);
  }
  return audio;
}

test("joining removes stacked outer silence while preserving the speech samples and target pause", async () => {
  const first = paddedSpeech();
  const second = paddedSpeech();
  const original = first.slice();
  const combined = await joinSpeech([first, second], [0.24]);
  assert.ok(Math.abs(combined.length / SAMPLE_RATE - 2.32) < 0.015);
  assert.deepEqual(first, original, "input references must not be modified");
  // First speech starts at 40ms instead of 500ms; the interior stays bit-identical.
  assert.deepEqual(combined.slice(1200, 22000), first.slice(12240, 33040));
  assert.ok(boundaryPause("continuation", "natural") < boundaryPause("sentence", "natural"));
  assert.ok(boundaryPause("sentence", "natural") < boundaryPause("paragraph", "natural"));
});

test("joining preserves within-sentence pauses and quiet consonants", async () => {
  const source = paddedSpeech();
  source.fill(0, 18000, 22000);
  source.fill(0.002, 12000, 12500);
  const combined = await joinSpeech([source], []);
  assert.deepEqual(combined.slice(6960, 10960), new Float32Array(4000));
  assert.equal(combined[1000], source[12040]);
});

test("asynchronous WAV encoding matches PCM output and allows the event loop to run", async () => {
  const source = new Float32Array(SAMPLE_RATE * 60);
  source.set([0, -1, 1, 0.5, -0.5, 2, -2]);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  const actual = await encodeWavAsync(source);
  clearInterval(timer);
  assert.ok(ticks > 1, "long audio export should yield to the UI");
  assert.deepEqual(new Uint8Array(await actual.arrayBuffer()), new Uint8Array(await encodeWav(source).arrayBuffer()));
});

test("final GPU decoder caches are freed once; CPU and speaker data are retained", () => {
  let gpuReleases = 0;
  let cpuReleases = 0;
  const gpu = { location: "gpu-buffer", dispose() { gpuReleases++; } };
  const cpu = { location: "cpu", dispose() { cpuReleases++; } };
  const model = { getPastKeyValues: () => ({ a: gpu, alias: gpu, b: cpu }) };
  const release = installFinalCacheCleanup(model);
  assert.equal(model.getPastKeyValues({}, undefined, false).a, gpu);
  assert.equal(gpuReleases, 0);
  assert.deepEqual(model.getPastKeyValues({}, undefined, true), {});
  assert.equal(gpuReleases, 1);
  release();
  assert.equal(gpuReleases, 1);
  assert.equal(cpuReleases, 0);
});

test("worker requests with the same operation resolve independently and reset rejects outstanding work", async () => {
  class FakeWorker {
    static latest;
    listeners = {};
    sent = [];
    constructor() { FakeWorker.latest = this; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    postMessage(message) { this.sent.push(message); }
    terminate() {}
    respond(request, data) { this.listeners.message({ data: { type: request.type + ":complete", requestId: request.requestId, data } }); }
  }
  globalThis.__voiceTestWorker = FakeWorker;
  const workerUrl = "data:text/javascript,export default globalThis.__voiceTestWorker";
  const { ttsClient } = await import(await moduleUrl("tts-client", { "./tts.worker?worker": workerUrl }));
  const first = ttsClient.encodeSpeaker("one", new Float32Array([0.1]));
  const second = ttsClient.encodeSpeaker("two", new Float32Array([0.2]));
  const worker = FakeWorker.latest;
  worker.respond(worker.sent[1], { id: "two" });
  worker.respond(worker.sent[0], { id: "one" });
  assert.deepEqual(await Promise.all([first, second]), [{ id: "one" }, { id: "two" }]);
  const pending = ttsClient.generate("Hello", "one", 0.5);
  const rejected = assert.rejects(pending, /重置/);
  ttsClient.reset();
  await rejected;
  delete globalThis.__voiceTestWorker;
});
