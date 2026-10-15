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

const { SAMPLING_PROFILES, getSamplingSettings } = await import(await moduleUrl("generation-settings"));

test("sampling profiles use supported settings and retain the existing balanced default", () => {
  assert.deepEqual(SAMPLING_PROFILES.map(({ id }) => id), ["balanced", "steady", "expressive"]);
  assert.deepEqual(getSamplingSettings("balanced"), { temperature: 0.8, top_k: 50, repetition_penalty: 1.2 });
  assert.deepEqual(getSamplingSettings("steady"), { temperature: 0.65, top_k: 40, repetition_penalty: 1.2 });
  assert.deepEqual(getSamplingSettings("expressive"), { temperature: 0.9, top_k: 60, repetition_penalty: 1.2 });
});

test("unknown worker input falls back safely without leaking mutable shared settings", () => {
  const expected = getSamplingSettings("balanced");
  for (const value of [undefined, null, "", "constructor", "__proto__", "fast", 0, 1, {}, [], { temperature: 100 }]) {
    assert.deepEqual(getSamplingSettings(value), expected);
  }
  const changed = getSamplingSettings("steady");
  changed.temperature = 100;
  assert.equal(getSamplingSettings("steady").temperature, 0.65);
});

test("client forwards the chosen profile and remains compatible with three-argument generation", async () => {
  class FakeWorker {
    static latest;
    listeners = {};
    sent = [];
    constructor() { FakeWorker.latest = this; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    postMessage(message) { this.sent.push(message); }
    terminate() {}
    respond(request) {
      this.listeners.message({ data: {
        type: "generate:complete",
        requestId: request.requestId,
        data: { waveform: new Float32Array([0.25]).buffer, inferenceTime: 1, truncated: false },
      } });
    }
  }
  globalThis.__samplingTestWorker = FakeWorker;
  const workerUrl = "data:text/javascript,export default globalThis.__samplingTestWorker";
  const { ttsClient } = await import(await moduleUrl("tts-client", { "./tts.worker?worker": workerUrl }));
  try {
    const balanced = ttsClient.generate("Hello.", "voice", 0.5);
    const steady = ttsClient.generate("Hello.", "voice", 0.5, "steady");
    const worker = FakeWorker.latest;
    assert.equal(worker.sent[0].data.samplingProfile, "balanced");
    assert.equal(worker.sent[1].data.samplingProfile, "steady");
    worker.sent.forEach((request) => worker.respond(request));
    const results = await Promise.all([balanced, steady]);
    assert.ok(results.every(({ waveform, truncated }) => waveform[0] === 0.25 && truncated === false));
  } finally {
    ttsClient.reset();
    delete globalThis.__samplingTestWorker;
  }
});
