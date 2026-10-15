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

const { inspectReference } = await import(await moduleUrl("reference-quality"));
const textUrl = await moduleUrl("text");
const { generateLongSpeech } = await import(await moduleUrl("long-speech", { "./text": textUrl }));

function signal(seconds = 6, level = 0.15, sampleRate = 24_000) {
  return Float32Array.from({ length: seconds * sampleRate }, (_, index) => level * Math.sin(index / 10));
}

test("empty, silent, nearly silent and invalid references cannot be learned", () => {
  for (const audio of [new Float32Array(), new Float32Array(24_000), signal(6, 1e-6)]) {
    const report = inspectReference(audio);
    assert.equal(report.usable, false);
    assert.ok(report.warnings.length > 0);
  }
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const audio = signal();
    audio[100] = invalid;
    assert.equal(inspectReference(audio).usable, false);
  }
});

test("usable reference diagnostics distinguish clear, quiet, short and clipped recordings", () => {
  const clear = inspectReference(signal());
  assert.equal(clear.usable, true);
  assert.equal(clear.duration, 6);
  assert.deepEqual(clear.warnings, []);
  assert.ok(inspectReference(signal(2)).warnings.some((message) => message.includes("样本较短")));
  assert.ok(inspectReference(signal(6, 0.004)).warnings.some((message) => message.includes("音量偏低")));
  const clipped = signal();
  clipped.fill(1, 0, 1000);
  const report = inspectReference(clipped);
  assert.equal(report.usable, true, "clipping is a visible quality warning, not a hidden rejection");
  assert.ok(report.warnings.some((message) => message.includes("破音")));
  assert.equal(inspectReference(signal(6, 0.15, 44_100), 44_100).duration, 6);
});

test("truncation retry retains explicit pause only after the final replacement segment", async () => {
  const text = "We followed the river through the valley, and watched the sunlight slowly disappear behind the distant mountains.";
  let first = true;
  const parts = await generateLongSpeech([
    { text, boundary: "sentence", pauseAfter: 0.75 },
    { text: "We will return tomorrow.", boundary: "paragraph" },
  ], {
    generate: async () => {
      if (first) { first = false; return { waveform: signal(1), truncated: true }; }
      return { waveform: signal(1), truncated: false };
    },
    isCancelled: () => false,
    onChunk() {},
  });
  assert.ok(parts.length >= 3);
  const replacements = parts.slice(0, -1);
  assert.equal(replacements.map((part) => part.text).join(" "), text);
  assert.equal(replacements.at(-1).pauseAfter, 0.75);
  assert.equal(replacements.at(-1).boundary, "sentence");
  assert.ok(replacements.slice(0, -1).every((part) => part.pauseAfter === undefined));
  assert.equal(parts.at(-1).pauseAfter, undefined);
});

test("zero or nearly silent generation fails after one bounded retry at either model rate", async () => {
  for (const sampleRate of [24_000, 44_100]) {
    for (const level of [0, 1e-6]) {
      let attempts = 0;
      let returned = false;
      await assert.rejects(async () => {
        await generateLongSpeech([{ text: "Hello there.", boundary: "paragraph" }], {
          generate: async () => { attempts++; return { waveform: signal(1, level, sampleRate) }; },
          isCancelled: () => false,
          onChunk() {},
        });
        returned = true;
      }, /静音/);
      assert.equal(attempts, 2);
      assert.equal(returned, false, "a silent take must never reach the save-success path");
    }
  }
});

test("a valid second take replaces silence without repeating earlier speech or losing pause metadata", async () => {
  const attempts = [];
  const progress = [];
  let secondAttempts = 0;
  const validAudio = signal(1, 0.15, 44_100);
  const parts = await generateLongSpeech([
    { text: "First sentence.", boundary: "sentence", pauseAfter: 0.35 },
    { text: "Second sentence.", boundary: "sentence", pauseAfter: 0.75 },
    { text: "Last sentence.", boundary: "paragraph" },
  ], {
    generate: async (text) => {
      attempts.push(text);
      const silent = text === "Second sentence." && ++secondAttempts === 1;
      return { waveform: silent ? new Float32Array(44_100) : validAudio };
    },
    isCancelled: () => false,
    onChunk: (completed, total, text, retrying) => progress.push({ completed, total, text, retrying }),
  });
  assert.deepEqual(attempts, ["First sentence.", "Second sentence.", "Second sentence.", "Last sentence."]);
  assert.deepEqual(parts.map((part) => part.text), ["First sentence.", "Second sentence.", "Last sentence."]);
  assert.deepEqual(parts.map((part) => part.pauseAfter), [0.35, 0.75, undefined]);
  assert.ok(parts.every((part) => part.waveform === validAudio));
  assert.ok(progress.some((item) => item.text === "Second sentence." && item.retrying && item.completed === 1));
});

test("cancellation after a silent result prevents both retry and partial success", async () => {
  let cancelled = false;
  let attempts = 0;
  await assert.rejects(generateLongSpeech([{ text: "Hello there.", boundary: "paragraph" }], {
    generate: async () => {
      attempts++;
      cancelled = true;
      return { waveform: new Float32Array(44_100) };
    },
    isCancelled: () => cancelled,
    onChunk() {},
  }), { name: "AbortError" });
  assert.equal(attempts, 1);
});

test("cancellation during a successful retry still prevents returning an incomplete take", async () => {
  let cancelled = false;
  let attempts = 0;
  await assert.rejects(generateLongSpeech([{ text: "Hello there.", boundary: "paragraph" }], {
    generate: async () => {
      attempts++;
      if (attempts === 1) return { waveform: new Float32Array(44_100) };
      cancelled = true;
      return { waveform: signal(1, 0.15, 44_100) };
    },
    isCancelled: () => cancelled,
    onChunk() {},
  }), { name: "AbortError" });
  assert.equal(attempts, 2);
});
