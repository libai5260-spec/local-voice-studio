#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const modelDir = process.argv[2];
if (!modelDir) {
  console.error("缺少模型保存目录。");
  process.exit(1);
}

const baseUrl =
  process.env.VOICE_MODEL_BASE_URL ??
  "https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/main";
const chunkSize = 16 * 1024 * 1024;
const concurrency = 20;

const files = [
  ["config.json", 1097, "a7d8518edd1cf6346e4d2be33201747ea4c476718db756f42e6959e4828f4955"],
  ["generation_config.json", 93, "1b6fbb953861089ebe7da64df46eeef570d53f47a44b7cc1b4d543669fc9cd50"],
  ["preprocessor_config.json", 130, "1c320b2eea5f45678d17d891d51c38467775091dbf26a074635ba5e98ede5950"],
  ["tokenizer.json", 28543, "ecddf6aaae85e271610a2743409f7e447886957d0b0836687c1eaec5ccac2891"],
  ["tokenizer_config.json", 244, "b35967f93e30313d05fc9d520721ca9f671aaa5b3edbb03059aed3ff68b4c4c0"],
  ["onnx/embed_tokens.onnx", 13286, "160722ec14789f616abdb1e31916cbbf9223c03fde0ab546d64ca74fb72e430b"],
  ["onnx/embed_tokens.onnx_data", 61640704, "898c563c3a5ca1b9ea10ce89b0cdcf252b0bb5ab460dfc4eadea003b56e5d2ee"],
  ["onnx/speech_encoder.onnx", 1184608, "8f1c8a0f89b77bf9cd5dd8f2e034eb2c79dc00fe70d41196b28c257643b00ccb"],
  ["onnx/speech_encoder.onnx_data", 591274880, "04431dcef6325c54b02de2219845888b464bcd1f1ac2f8839c2fecd1ed2ef294"],
  ["onnx/conditional_decoder.onnx", 6350448, "1656d0d31332bae1854839959a3139300ebb67c178651dfa3f8c5fbfa5351351"],
  ["onnx/conditional_decoder.onnx_data", 533970816, "51d58345a272747665ec9d5bb61e01835258a940e321a288582ac4c18cf01b5a"],
  ["onnx/language_model_q4.onnx", 227911, "7f8cdca83b2493536cbf3acf421199808a3d68736f55f4eabd20ef8a99da4313"],
  ["onnx/language_model_q4.onnx_data", 353621248, "5203d1e83c159316f9923c5c83759f6a34f87be1322ce4ad0facd9fc4aef4790"],
  ["onnx/language_model_q4f16.onnx", 229388, "3b78e9235be5e2e2a811e482399155cb30415f6d87c98c21d12bf48843fc928f"],
  ["onnx/language_model_q4f16.onnx_data", 304737408, "2480da95471e4cd41a6b1876686e65e8a594c82459f2e5d6fd7592a5bad4e6da"],
];

const totalBytes = files.reduce((sum, [, size]) => sum + size, 0);
let downloadedBytes = 0;
const startedAt = Date.now();

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function reportProgress(label) {
  const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.1);
  const percent = ((downloadedBytes / totalBytes) * 100).toFixed(1);
  const speed = formatBytes(downloadedBytes / elapsed);
  process.stdout.write(`\r${label}  ${percent}%  ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}  ${speed}/s   `);
}

async function existingSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch {
    return -1;
  }
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function fetchWithRetry(url, options, expectedStatus, attempts = 8) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, redirect: "follow" });
      if (response.status !== expectedStatus) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 10000)));
      }
    }
  }
  throw lastError;
}

async function curlDownload(url, destination, range = null, attempts = 8) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const args = [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "30",
      "--speed-limit",
      "1024",
      "--speed-time",
      "90",
    ];
    if (range) args.push("--range", range);
    args.push("--output", destination, url);

    try {
      await new Promise((resolve, reject) => {
        const child = spawn("curl", args, { stdio: ["ignore", "ignore", "pipe"] });
        let errorOutput = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          errorOutput += chunk;
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(errorOutput.trim() || `curl 退出码 ${code}`));
        });
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 10000)));
      }
    }
  }
  throw lastError;
}

async function downloadSmallFile(relativePath, expectedSize) {
  const destination = path.join(modelDir, relativePath);
  if ((await existingSize(destination)) === expectedSize) {
    downloadedBytes += expectedSize;
    reportProgress(relativePath);
    return;
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const response = await fetchWithRetry(`${baseUrl}/${relativePath}?download=true`, {}, 200);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength !== expectedSize) {
    throw new Error(`${relativePath} 大小不正确：${buffer.byteLength}，应为 ${expectedSize}`);
  }

  const temporary = `${destination}.download`;
  await writeFile(temporary, buffer);
  await rename(temporary, destination);
  downloadedBytes += expectedSize;
  reportProgress(relativePath);
}

async function downloadLargeFile(relativePath, expectedSize) {
  const destination = path.join(modelDir, relativePath);
  if ((await existingSize(destination)) === expectedSize) {
    downloadedBytes += expectedSize;
    reportProgress(relativePath);
    return;
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.download`;
  const partsDir = `${temporary}.parts`;
  const chunkCount = Math.ceil(expectedSize / chunkSize);
  await mkdir(partsDir, { recursive: true });
  await rm(temporary, { force: true });

  const completed = new Set();
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * chunkSize;
    const expectedChunkSize = Math.min(chunkSize, expectedSize - start);
    const partPath = path.join(partsDir, String(index).padStart(4, "0"));
    if ((await existingSize(partPath)) === expectedChunkSize) {
      completed.add(index);
      downloadedBytes += expectedChunkSize;
    }
  }
  reportProgress(relativePath);

  const pending = Array.from({ length: chunkCount }, (_, index) => index).filter((index) => !completed.has(index));
  let cursor = 0;

  async function worker() {
    while (true) {
      const pendingIndex = cursor;
      cursor += 1;
      if (pendingIndex >= pending.length) return;

      const index = pending[pendingIndex];
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, expectedSize) - 1;
      const partPath = path.join(partsDir, String(index).padStart(4, "0"));
      const partDownload = `${partPath}.download`;
      const expectedChunkSize = end - start + 1;
      await curlDownload(
        `${baseUrl}/${relativePath}?download=true`,
        partDownload,
        `${start}-${end}`,
      );
      if ((await existingSize(partDownload)) !== expectedChunkSize) {
        throw new Error(`${relativePath} 分段 ${index + 1} 不完整`);
      }
      await rename(partDownload, partPath);
      completed.add(index);
      downloadedBytes += expectedChunkSize;
      reportProgress(relativePath);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));

  if (completed.size !== chunkCount) {
    throw new Error(`${relativePath} 未完整下载`);
  }

  const handle = await open(temporary, "w+");
  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const partPath = path.join(partsDir, String(index).padStart(4, "0"));
      const buffer = await readFile(partPath);
      await handle.write(buffer, 0, buffer.byteLength, index * chunkSize);
    }
  } finally {
    await handle.close();
  }
  if ((await existingSize(temporary)) !== expectedSize) {
    throw new Error(`${relativePath} 合并后大小不正确`);
  }
  await rename(temporary, destination);
  await rm(partsDir, { recursive: true, force: true });
}

await mkdir(modelDir, { recursive: true });
console.log(`正在下载本地声音模型（${formatBytes(totalBytes)}，支持断点续传）…`);

for (const [relativePath, expectedSize] of files) {
  if (expectedSize >= chunkSize) {
    await downloadLargeFile(relativePath, expectedSize);
  } else {
    await downloadSmallFile(relativePath, expectedSize);
  }
}

process.stdout.write("\n");
console.log("正在校验模型文件 SHA-256…");
for (const [relativePath, , expectedHash] of files) {
  if (!expectedHash) continue;
  const actualHash = await sha256(path.join(modelDir, relativePath));
  if (actualHash !== expectedHash) {
    throw new Error(`${relativePath} SHA-256 校验失败`);
  }
}
console.log("本地声音模型下载及完整性校验完成。");
