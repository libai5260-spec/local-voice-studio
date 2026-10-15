import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/lib/audio.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { encodeWav, encodeWavAsync, joinSpeech, SAMPLE_RATE } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

function paddedSpeech(sampleRate) {
  const audio = new Float32Array(sampleRate * 2);
  const start = sampleRate / 2;
  for (let index = 0; index < sampleRate; index++) {
    // Distinct samples make accidental resampling or stretching observable.
    audio[start + index] = 0.2 + (index % 100) / 1000;
  }
  return audio;
}

for (const sampleRate of [24_000, 44_100]) {
  test(`WAV export retains ${sampleRate} Hz and the original PCM sample count`, async () => {
    const audio = new Float32Array(sampleRate);
    audio.set([0, 0.5, -0.5, 1, -1]);
    const sync = new Uint8Array(await encodeWav(audio, sampleRate).arrayBuffer());
    const async = new Uint8Array(await (await encodeWavAsync(audio, () => false, sampleRate)).arrayBuffer());
    assert.deepEqual(async, sync);
    const view = new DataView(async.buffer);
    assert.equal(view.getUint32(24, true), sampleRate);
    assert.equal(view.getUint32(28, true), sampleRate * 2);
    assert.equal(view.getUint32(40, true), audio.length * 2);
    assert.equal(async.length, 44 + audio.length * 2);
    assert.equal(view.getInt16(46, true), Math.trunc(0.5 * 0x7fff));
    assert.equal(view.getInt16(48, true), -0.5 * 0x8000);
  });

  test(`speech joining keeps native ${sampleRate} Hz samples and real-time pause lengths`, async () => {
    const original = paddedSpeech(sampleRate);
    const saved = original.slice();
    const joined = await joinSpeech([original, original], [0.24], () => false, sampleRate);
    assert.deepEqual(original, saved, "joining must not mutate source audio");
    const firstSpeech = joined.findIndex((value) => value > 0.1);
    const secondSpeech = joined.findIndex((value, index) => index >= firstSpeech + sampleRate && value > 0.1);
    const speech = original.slice(sampleRate / 2, sampleRate * 1.5);
    assert.deepEqual(joined.slice(firstSpeech, firstSpeech + sampleRate), speech);
    assert.deepEqual(joined.slice(secondSpeech, secondSpeech + sampleRate), speech);
    assert.ok(Math.abs((secondSpeech - firstSpeech - sampleRate) / sampleRate - 0.24) < 0.01);
    assert.ok(Math.abs(joined.length / sampleRate - 2.32) < 0.02);
  });
}

test("existing audio callers still default to 24 kHz", async () => {
  assert.equal(SAMPLE_RATE, 24_000);
  const audio = paddedSpeech(SAMPLE_RATE);
  const wave = new DataView(await (await encodeWavAsync(audio)).arrayBuffer());
  assert.equal(wave.getUint32(24, true), SAMPLE_RATE);
  assert.deepEqual(await joinSpeech([audio], []), await joinSpeech([audio], [], () => false, SAMPLE_RATE));
});
