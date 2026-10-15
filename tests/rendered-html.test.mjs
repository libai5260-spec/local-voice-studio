import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the complete Voice Studio shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Voice Studio · 本地声音克隆<\/title>/i);
  assert.match(html, /class="studio-shell"/);
  assert.match(html, /本地声音克隆/);
  assert.match(html, /让文字拥有/);
  assert.match(html, /找到你的声音/);
  assert.match(html, /你的文字，她的声音/);
  assert.match(html, /赋予一点情绪/);
  assert.match(html, /工作室导航/);
  assert.match(html, /class="clone-drawer"/);
  assert.match(html, /美国女声 · 10/);
  assert.match(html, /先试读一段/);
  assert.match(html, /生成完整语音/);
  assert.match(html, /自然语气标签/);
  assert.match(html, /生成历史/);
  assert.doesNotMatch(html, /codex-preview|Building your site|SkeletonPreview/i);
});

test("ships the local voice-cloning implementation without starter artifacts", async () => {
  const [page, studio, recorder, client, worker, workerImpl, storage, launcher] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/voice-studio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/recorder.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/tts-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/tts.worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/tts.worker.impl.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../启动声音工作室.command", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<VoiceStudio \/>/);
  assert.match(recorder, /navigator\.mediaDevices/);
  assert.match(studio, /encodeWav/);
  assert.match(studio, /encodeMp3/);
  assert.match(client, /\.\/tts\.worker\?worker/);
  assert.doesNotMatch(client, /new URL\([^)]*tts\.worker/);
  assert.match(client, /event\.preventDefault\(\)/);
  assert.match(worker, /workerGlobal\.window \?\?= globalThis/);
  assert.match(worker, /queuedMessages/);
  assert.match(worker, /dispatchEvent\(new MessageEvent/);
  assert.match(worker, /await import\("\.\/tts\.worker\.impl"\)/);
  assert.match(workerImpl, /onnx-community\/chatterbox-ONNX/);
  assert.match(workerImpl, /conditional_decoder:\s*"fp32"/);
  assert.match(studio, /prepareVoiceReference/);
  assert.doesNotMatch(studio, /applyAudioControls\(combined/);
  assert.match(studio, /节奏只改变自然停顿/);
  assert.match(workerImpl, /env\.allowLocalModels = true/);
  assert.match(workerImpl, /env\.allowRemoteModels = false/);
  assert.match(workerImpl, /env\.useBrowserCache = false/);
  assert.match(workerImpl, /env\.localModelPath = "\/models\/"/);
  assert.match(workerImpl, /webgpu/);
  assert.match(storage, /indexedDB\.open/);
  assert.match(launcher, /http:\/\/127\.0\.0\.1:3000/);

});

test("bundles the licensed natural voice reference collection", async () => {
  const studio = await readFile(new URL("../app/voice-studio.tsx", import.meta.url), "utf8");
  const notices = await readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  const samples = [
    "Natural-Warm-2094.flac",
    "Natural-Expressive-3575.flac",
    "Natural-Clear-2961.flac",
    "Natural-Bright-8463.flac",
    "Natural-Calm-1995.flac",
    "Natural-Story-1284.flac",
    "Natural-Friendly-5142.flac",
  ];

  for (const sample of samples) {
    assert.match(studio, new RegExp(sample.replaceAll(".", "\\.")));
    const audio = await readFile(new URL(`../public/voice-samples/${sample}`, import.meta.url));
    assert.ok(audio.byteLength > 100_000, `${sample} should contain a complete clean speech clip`);
  }

  assert.match(notices, /LibriSpeech/);
  assert.match(notices, /Creative Commons Attribution 4\.0/);
});

test("bundles ten verified VCTK American female voice references", async () => {
  const studio = await readFile(new URL("../app/voice-studio.tsx", import.meta.url), "utf8");
  const notices = await readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  const speakerIds = ["p294", "p297", "p299", "p300", "p301", "p305", "p306", "p308", "p310", "p318"];

  for (const [index, speakerId] of speakerIds.entries()) {
    const slot = String(index + 1).padStart(2, "0");
    const sample = `US-Female-${slot}-${speakerId}.wav`;
    assert.match(studio, new RegExp(sample.replaceAll(".", "\\.")));
    assert.match(notices, new RegExp("speaker `" + speakerId + "`"));
    const audio = await readFile(new URL(`../public/voice-samples/${sample}`, import.meta.url));
    assert.ok(audio.byteLength > 200_000, `${sample} should contain a complete 5–12 second speech clip`);
    assert.equal(audio.toString("ascii", 0, 4), "RIFF", `${sample} should be a WAV file`);
  }

  assert.match(notices, /CSTR VCTK Corpus v0\.92/);
  assert.match(notices, /female with an American accent/);
});
