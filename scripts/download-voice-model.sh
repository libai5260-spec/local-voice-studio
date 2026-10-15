#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
MODEL_DIR="$PROJECT_DIR/public/models/onnx-community/chatterbox-ONNX"
WASM_DIR="$PROJECT_DIR/public/models/onnx-runtime"
MARKER="$MODEL_DIR/.complete"

mkdir -p "$WASM_DIR"
cp "$PROJECT_DIR/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs" "$WASM_DIR/"
cp "$PROJECT_DIR/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm" "$WASM_DIR/"

if [[ -f "$MARKER" ]]; then
  echo "本地声音模型已经准备完成。"
  exit 0
fi

mkdir -p "$MODEL_DIR/onnx"
node "$PROJECT_DIR/scripts/download-model.mjs" "$MODEL_DIR"

touch "$MARKER"
echo "本地声音模型下载完成。"
