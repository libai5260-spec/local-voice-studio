import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const project = new URL("../", import.meta.url);
const mac = process.platform === "darwin" && process.arch === "arm64";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  return root;
}

async function executable(file, source) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source, { mode: 0o755 });
}

test("installation scripts have valid shell syntax and no private runtime path", { skip: process.platform !== "darwin" }, async () => {
  for (const file of ["scripts/fish-install.sh", "scripts/fish-download.sh", "scripts/fish-start.sh", "首次安装.command", "启动声音工作室.command"]) {
    const source = await readFile(new URL(file, project), "utf8");
    assert.doesNotMatch(source, /\/Users\/[^\s]+|codex-runtimes/);
    const shell = file.endsWith(".command") ? "/bin/zsh" : "/bin/sh";
    const result = spawnSync(shell, ["-n"], { input: source, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("prepare-only installs website components without downloading models or starting servers", { skip: !mac }, async (t) => {
  const root = await fixture(t);
  await copyFile(new URL("启动声音工作室.command", project), path.join(root, "启动声音工作室.command"));
  await writeFile(path.join(root, "package-lock.json"), "{}\n");
  await executable(path.join(root, ".runtime/node/bin/node"), "#!/bin/sh\nexit 0\n");
  await executable(path.join(root, ".runtime/node/bin/npm"), "#!/bin/sh\nprintf '%s\\n' \"$*\"\n");
  const result = spawnSync("/bin/zsh", [path.join(root, "启动声音工作室.command"), "--prepare-only"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ci --cache/);
  assert.match(result.stdout, /尚未下载任何模型/);
  const source = await readFile(new URL("启动声音工作室.command", project), "utf8");
  assert.doesNotMatch(source, /download-voice-model\.sh|fish-download\.sh/);
  assert.match(source, /NODE_SHA256="[a-f0-9]{64}"/);
});

test("Fish installer uses an explicit portable interpreter and isolated environment", { skip: !mac }, async (t) => {
  const root = await fixture(t);
  await copyFile(new URL("scripts/fish-install.sh", project), path.join(root, "scripts/fish-install.sh"));
  const fakePython = path.join(root, "python stub");
  await executable(fakePython, '#!/bin/sh\nif [ "$1" = -c ]; then exit 0; fi\nif [ "$2" = venv ]; then mkdir -p "$3/bin"; cp "$0" "$3/bin/python"; exit 0; fi\nprintf "%s\\n" "$*"\n');
  const result = spawnSync("/bin/sh", [path.join(root, "scripts/fish-install.sh")], {
    env: { ...process.env, FISH_PYTHON: fakePython }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /-m pip install/);
  assert.match(result.stdout, /\.runtime\/fish\/pip-cache/);
  assert.match(result.stdout, /此步骤不下载模型/);
});

test("invalid explicit Python fails before installing or replacing anything", { skip: !mac }, async (t) => {
  const root = await fixture(t);
  await copyFile(new URL("scripts/fish-install.sh", project), path.join(root, "scripts/fish-install.sh"));
  const result = spawnSync("/bin/sh", [path.join(root, "scripts/fish-install.sh")], {
    env: { ...process.env, FISH_PYTHON: path.join(root, "missing-python") }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Python 3.12 或 3.13/);
});

test("Fish download refuses noninteractive first-use consent, but retains explicit prior consent", async (t) => {
  const root = await fixture(t);
  await copyFile(new URL("scripts/fish-download.sh", project), path.join(root, "scripts/fish-download.sh"));
  await mkdir(path.join(root, "licenses"));
  const license = await readFile(new URL("licenses/FISH-AUDIO-RESEARCH-LICENSE.md", project));
  await writeFile(path.join(root, "licenses/FISH-AUDIO-RESEARCH-LICENSE.md"), license);
  await executable(path.join(root, ".runtime/fish/venv/bin/python"), '#!/bin/sh\nprintf "MODEL_DOWNLOAD_CALLED\\n"\n');
  const denied = spawnSync("/bin/sh", [path.join(root, "scripts/fish-download.sh")], { input: "YES\n", encoding: "utf8" });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /交互确认许可/);
  assert.doesNotMatch(denied.stdout, /MODEL_DOWNLOAD_CALLED/);
  await writeFile(path.join(root, ".runtime/fish/license-accepted.sha256"), createHash("sha256").update(license).digest("hex") + "\n");
  const allowed = spawnSync("/bin/sh", [path.join(root, "scripts/fish-download.sh")], { encoding: "utf8" });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /MODEL_DOWNLOAD_CALLED/);
});
