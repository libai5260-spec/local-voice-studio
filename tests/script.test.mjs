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
const { planSpeech } = await import(textUrl);
const { prepareScript, insertScriptCue, buildAuditionPlan } = await import(
  await moduleUrl("script", { "./text": textUrl }),
);

test("unmarked prose retains the existing paragraph-aware generation plan", () => {
  const text = "Hello there. It is good to see you.\n\nWe have plenty of time.";
  const prepared = prepareScript(text);
  assert.deepEqual(prepared.chunks, planSpeech(text));
  assert.equal(prepared.spokenText, text.replace(/\s+/g, " "));
  assert.deepEqual(prepared.warnings, []);
});

test("explicit pauses are case-insensitive metadata, never synthesized text", () => {
  const prepared = prepareScript("Welcome. [PAUSE] Take a breath. [ Long   Pause ] Let's begin.");
  assert.deepEqual(prepared.chunks.map(({ text, pauseAfter }) => ({ text, pauseAfter })), [
    { text: "Welcome.", pauseAfter: 0.35 },
    { text: "Take a breath.", pauseAfter: 0.75 },
    { text: "Let's begin.", pauseAfter: undefined },
  ]);
  assert.equal(prepared.spokenText, "Welcome. Take a breath. Let's begin.");
  assert.deepEqual(prepared.warnings, []);
});

test("repeated, leading, and trailing pauses are bounded and never produce empty speech", () => {
  const prepared = prepareScript("[pause] Hello. [long pause][long pause][long pause] Goodbye. [pause]");
  assert.equal(prepared.chunks.length, 2);
  assert.equal(prepared.chunks[0].pauseAfter, 2);
  assert.equal(prepared.chunks[1].pauseAfter, 0.35);
  assert.ok(prepared.warnings.some((warning) => warning.includes("开头")));
  assert.ok(prepared.warnings.some((warning) => warning.includes("2 秒")));
  assert.deepEqual(prepareScript("[pause][long pause]").chunks, []);
  assert.equal(prepareScript("First.[pause][pause]Next.").chunks[0].pauseAfter, 0.7);
});

test("every accepted native cue matches the verified tokenizer fixture without model downloads", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/chatterbox-native-cues.json", import.meta.url), "utf8"));
  const specialTokens = new Set(fixture.tokens);
  const cues = ["laughter", "giggle", "sigh", "gasp", "cough", "clear_throat", "whisper"];
  for (const cue of cues) assert.ok(specialTokens.has(`[${cue}]`), `${cue} must be a native token`);
  const prepared = prepareScript(cues.map((cue) => `Hello [${cue.toUpperCase()}].`).join(" "));
  const synthesized = prepared.chunks.map((chunk) => chunk.text).join(" ");
  for (const cue of cues) assert.ok(synthesized.includes(`[${cue}]`));
  assert.ok(!prepared.spokenText.includes("["));
  assert.deepEqual(prepared.warnings, []);
});

test("downloaded tokenizer, when present, still matches the source-only fixture", async (t) => {
  let source;
  try {
    source = await readFile(new URL("../public/models/onnx-community/chatterbox-ONNX/tokenizer.json", import.meta.url));
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("Optional integration check: local model is not installed");
    throw error;
  }
  const { createHash } = await import("node:crypto");
  const fixture = JSON.parse(await readFile(new URL("./fixtures/chatterbox-native-cues.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(source).digest("hex"), fixture.tokenizer_sha256);
  const tokens = new Set(JSON.parse(source).added_tokens.filter((token) => token.special).map((token) => token.content));
  for (const cue of fixture.tokens) assert.ok(tokens.has(cue), `${cue} must be a native token`);
});

test("legacy laugh and chuckle cues normalize while unsupported Fish instructions are removed visibly", () => {
  const prepared = prepareScript("[excited] Hello [laugh]. [chuckle] Nice to meet you [sad]. [excited] Goodbye.");
  const synthesized = prepared.chunks.map((chunk) => chunk.text).join(" ");
  assert.ok(synthesized.includes("[laughter]"));
  assert.ok(synthesized.includes("[giggle]"));
  assert.ok(!/\[(excited|sad|laugh|chuckle)\]/.test(synthesized));
  assert.equal(prepared.warnings.length, 2, "duplicate unsupported directives have one warning");
  assert.ok(prepared.warnings[0].includes("[excited]"));
  assert.deepEqual(prepareScript("[excited][laugh]").chunks, []);
  assert.equal(prepareScript("[constructor]Hello[toString]world").spokenText, "Hello world");
});

test("pause adjacent to punctuation does not synthesize a punctuation-only segment", () => {
  const prepared = prepareScript("Hello[pause]. Goodbye[pause]!");
  assert.deepEqual(prepared.chunks.map((chunk) => chunk.text), ["Hello.", "Goodbye!"]);
  assert.ok(prepared.chunks.every((chunk) => chunk.pauseAfter === 0.35));
});

test("cue insertion preserves the selected words and returns a usable caret", () => {
  const inserted = insertScriptCue("Hello world.", "[pause]", 6, 11);
  assert.equal(inserted.text, "Hello [pause] world.");
  assert.equal(inserted.cursor, "Hello [pause] ".length);
  assert.equal(insertScriptCue("Hello", "[pause]", 99, 99).text, "Hello [pause]");
  assert.equal(insertScriptCue("Hello", "[pause]", -10, -10).text, "[pause] Hello");
  assert.deepEqual(insertScriptCue("Hello", "  ", 2, 4), { text: "Hello", cursor: 2 });
});

test("audition keeps one bounded first segment without changing full-script metadata", () => {
  const prepared = prepareScript(("We have time to listen carefully and enjoy this little moment together. ").repeat(60));
  const original = structuredClone(prepared.chunks);
  const audition = buildAuditionPlan(prepared.chunks);
  assert.equal(audition.length, 1);
  assert.ok(audition[0].text.length <= 220);
  assert.ok(audition[0].text.split(/\s+/).length <= 36);
  audition[0].text = "Changed only in audition";
  assert.deepEqual(prepared.chunks, original);
  assert.deepEqual(buildAuditionPlan([]), []);
});

test("Fish preserves free-form instructions and spelling without Chatterbox aliases", () => {
  const prepared = prepareScript("[Very Happy] Hello [laugh]. [chuckle] Welcome [speaking softly].", "fish");
  const synthesized = prepared.chunks.map((chunk) => chunk.text).join(" ");
  for (const cue of ["[Very Happy]", "[laugh]", "[chuckle]", "[speaking softly]"]) {
    assert.ok(synthesized.includes(cue));
  }
  assert.deepEqual(prepared.warnings, []);
  assert.ok(!prepared.spokenText.includes("["));
  assert.ok(prepareScript("[Very Happy] Hello.").warnings.length > 0, "Chatterbox remains the default");
});

test("Fish has larger full-generation chunks but an independently bounded short audition", () => {
  const text = ("We have time to listen carefully and enjoy this little moment together. ").repeat(20);
  const full = prepareScript(text, "fish").chunks;
  assert.ok(full[0].text.length > 220);
  assert.ok(full.every((chunk) => chunk.text.length <= 450 && chunk.text.split(/\s+/).length <= 70));
  const audition = buildAuditionPlan(full);
  assert.equal(audition.length, 1);
  assert.ok(audition[0].text.length <= 220 && audition[0].text.split(/\s+/).length <= 36);
  assert.ok(full[0].text.startsWith(audition[0].text));
});

test("Fish pauses remain app metadata and are never sent as model instructions", () => {
  const prepared = prepareScript("[excited] Hello. [pause] Welcome. [long pause] Goodbye.", "fish");
  assert.deepEqual(prepared.chunks.map((chunk) => chunk.pauseAfter), [0.35, 0.75, undefined]);
  assert.ok(prepared.chunks[0].text.includes("[excited]"));
  assert.ok(prepared.chunks.every((chunk) => !/\[(?:long )?pause\]/i.test(chunk.text)));
  assert.deepEqual(prepared.warnings, []);
});

test("cue-only paragraphs and cue lists never become standalone generation requests", () => {
  for (const engine of ["chatterbox", "fish"]) {
    const script = "[sigh]\n\n[pause]\n[laughter]\n\nHello there.\n\n[whisper]\n\nGoodbye.\n\n[giggle]";
    const prepared = prepareScript(script, engine);
    assert.equal(prepared.chunks.length, 2);
    assert.ok(prepared.chunks.every((chunk) => /[A-Za-z]/.test(chunk.text.replace(/\[[^\]]*\]/g, ""))));
    assert.ok(prepared.chunks[0].text.includes("[sigh]"));
    assert.ok(prepared.chunks.at(-1).text.includes("[giggle]"));
    assert.ok(prepared.warnings.some((warning) => warning.includes("开头")));
    assert.deepEqual(prepareScript("[sigh]\n\n[whisper]\n\n[giggle]", engine).chunks, []);
    assert.equal(prepareScript("[sigh]...", engine).spokenText, "");
  }
  const prepared = prepareScript("[emotion with a fairly detailed description]\n\nHello there.", "fish");
  assert.equal(prepared.chunks.length, 1);
  assert.ok(prepared.chunks[0].text.includes("[emotion with a fairly detailed description]"));
  assert.equal(buildAuditionPlan(prepared.chunks).length, 1);
});

test("all ten existing female references have transcripts and p318 keeps its different utterance", async () => {
  const { FEMALE_VOICE_TRANSCRIPTS, FEMALE_VOICE_TRANSCRIPT_SOURCE_URL } = await import(await moduleUrl("female-voices"));
  const speakers = ["p294", "p297", "p299", "p300", "p301", "p305", "p306", "p308", "p310", "p318"];
  assert.deepEqual(Object.keys(FEMALE_VOICE_TRANSCRIPTS), speakers.map((id) => "builtin-vctk-us-female-" + id));
  assert.ok(Object.values(FEMALE_VOICE_TRANSCRIPTS).every((text) => text.length > 50));
  assert.notEqual(FEMALE_VOICE_TRANSCRIPTS["builtin-vctk-us-female-p318"], FEMALE_VOICE_TRANSCRIPTS["builtin-vctk-us-female-p294"]);
  assert.equal(FEMALE_VOICE_TRANSCRIPT_SOURCE_URL, "https://huggingface.co/datasets/saeedzou/vctk-16khz");
});
