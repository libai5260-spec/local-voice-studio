#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h}"
RUNTIME_DIR="$PROJECT_DIR/.runtime/node"
RUNTIME_ARCHIVE="$PROJECT_DIR/.runtime/node-v22.23.2-darwin-arm64.tar.gz"
NODE_URL="https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz"
NODE_SHA256="61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6"
LOCAL_URL="http://localhost:3000"
CHECK_URL="http://127.0.0.1:3000"
FISH_SERVER_PID=""
PREPARE_ONLY=false
if [[ "${1:-}" == "--prepare-only" ]]; then
  PREPARE_ONLY=true
elif [[ $# -gt 0 ]]; then
  echo "用法：启动声音工作室.command [--prepare-only]"
  exit 1
fi

cd "$PROJECT_DIR"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "这个一键启动器需要 Apple 芯片 Mac。"
  read "?Press Enter to close..."
  exit 1
fi

if [[ ! -x "$RUNTIME_DIR/bin/node" ]]; then
  echo "首次启动：正在准备网站运行环境（约 50 MB）…"
  mkdir -p "$PROJECT_DIR/.runtime"
  curl --fail --location --progress-bar "$NODE_URL" --output "$RUNTIME_ARCHIVE"
  if [[ "$(shasum -a 256 "$RUNTIME_ARCHIVE" | awk '{print $1}')" != "$NODE_SHA256" ]]; then
    echo "Node.js 下载校验失败，已停止安装；请保持网络稳定后重试。"
    exit 1
  fi
  mkdir -p "$RUNTIME_DIR"
  tar -xzf "$RUNTIME_ARCHIVE" -C "$RUNTIME_DIR" --strip-components=1
  rm "$RUNTIME_ARCHIVE"
fi

export PATH="$RUNTIME_DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ ! -d "$PROJECT_DIR/node_modules" ]] || [[ ! -f "$PROJECT_DIR/.runtime/installed.lock" ]] || ! cmp -s "$PROJECT_DIR/package-lock.json" "$PROJECT_DIR/.runtime/installed.lock"; then
  echo "首次启动：正在安装网站组件，请保持联网…"
  npm ci --cache "$PROJECT_DIR/.runtime/npm-cache" --no-audit --no-fund
  cp "$PROJECT_DIR/package-lock.json" "$PROJECT_DIR/.runtime/installed.lock"
fi

if $PREPARE_ONLY; then
  echo "网站组件已准备完成。尚未下载任何模型。"
  exit 0
fi

if [[ ! -f "$PROJECT_DIR/public/models/onnx-community/chatterbox-ONNX/.complete" ]] && [[ ! -f "$PROJECT_DIR/.runtime/fish/models/s2-pro-bf16/download-complete.json" ]]; then
  echo "还没有完整的本地模型。网站仍会打开；请另行双击「首次安装.command」选择并准备模型。"
fi

if [[ -x "$PROJECT_DIR/.runtime/fish/venv/bin/python" ]]; then
  if ! curl --silent --fail --max-time 3 "http://127.0.0.1:7861/health" >/dev/null 2>&1; then
    echo "正在启动 Fish S2 Pro 本地服务；模型准备完成后会自动载入…"
    "$PROJECT_DIR/scripts/fish-start.sh" > "$PROJECT_DIR/.runtime/fish/server.log" 2>&1 &
    FISH_SERVER_PID=$!
  fi
fi

if curl --silent --fail "$CHECK_URL" >/dev/null 2>&1; then
  if [[ -d "/Applications/Google Chrome.app" ]]; then
    open -a "Google Chrome" "$LOCAL_URL"
  else
    open "$LOCAL_URL"
  fi
  if [[ -n "$FISH_SERVER_PID" ]]; then
    trap 'kill "$FISH_SERVER_PID" >/dev/null 2>&1 || true' INT TERM EXIT
    echo "Fish 本地模型运行中，请保持此窗口打开。"
    wait "$FISH_SERVER_PID"
  fi
  exit 0
fi

VINEXT_LOCK="$PROJECT_DIR/.vinext/dev/lock.json"
if [[ -f "$VINEXT_LOCK" ]]; then
  LOCK_PID="$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$VINEXT_LOCK" | head -1)"
  if [[ -z "$LOCK_PID" ]] || ! kill -0 "$LOCK_PID" >/dev/null 2>&1; then
    rm "$VINEXT_LOCK"
  fi
fi

echo "正在启动 Voice Studio…"
npm run dev &
SERVER_PID=$!

function stop_server {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  if [[ -n "$FISH_SERVER_PID" ]]; then
    kill "$FISH_SERVER_PID" >/dev/null 2>&1 || true
  fi
}

trap stop_server INT TERM EXIT

for attempt in {1..60}; do
  if curl --silent --fail "$CHECK_URL" >/dev/null 2>&1; then
    if [[ -d "/Applications/Google Chrome.app" ]]; then
      open -a "Google Chrome" "$LOCAL_URL"
    else
      open "$LOCAL_URL"
    fi
    echo "Voice Studio 已打开。使用期间请保持此窗口运行。"
    echo "结束使用时，关闭此窗口即可停止网站。"
    wait "$SERVER_PID"
    exit 0
  fi
  sleep 1
done

echo "启动超时。请检查上方的错误信息。"
read "?Press Enter to close..."
exit 1
