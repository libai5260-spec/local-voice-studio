import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("every bundled voice reference is present and has a redistribution notice", async () => {
  const studio = await readFile(new URL("../app/voice-studio.tsx", import.meta.url), "utf8");
  const notices = await readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  const samples = [...studio.matchAll(/file: "(\/voice-samples\/[^"\n]+)"/g)].map((match) => match[1]);
  assert.equal(samples.length, 17);
  assert.equal(samples.filter((path) => path.endsWith(".wav")).length, 10);
  assert.equal(samples.filter((path) => path.endsWith(".flac")).length, 7);
  for (const path of samples) {
    const bytes = await readFile(new URL(`../public${path}`, import.meta.url));
    assert.ok(bytes.length > 100_000, `${path} must be included in a clean source checkout`);
  }
  assert.match(notices, /VCTK/);
  assert.match(notices, /LibriSpeech/);
});

test("public source excludes private runtime, model weights and unlicensed legacy clips", async () => {
  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  for (const pattern of [".runtime/", "/public/models/", "/node_modules", ".env*", "/outputs/", "/work/", "/vendor/transformersjs-chatterbox-demo/", "/voice-samples/"]) {
    assert.ok(ignore.split("\n").includes(pattern), `${pattern} must remain ignored`);
  }
  const studio = await readFile(new URL("../app/voice-studio.tsx", import.meta.url), "utf8");
  for (const file of ["Alba-UK.mp3", "Amy-US.mp3", "HFC-Female-US.mp3", "Jenny-Dioco-UK.mp3", "Kristin-US.mp3"]) {
    assert.ok(ignore.includes(`/public/voice-samples/${file}`));
    assert.ok(!studio.includes(file), `${file} must not be fetched by a clean installation`);
  }
});
