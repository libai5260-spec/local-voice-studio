#!/bin/sh
set -eu
FISH_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
FISH_VENV_PYTHON="$FISH_ROOT/.runtime/fish/venv/bin/python"

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  printf '%s\n' 'Fish 本地模型需要 Apple 芯片 Mac，并以原生 arm64 模式运行（不要使用 Rosetta）。' >&2
  exit 1
fi

# Pinned NumPy/SciPy require Python >= 3.12. Limit to the supported stable
# interpreter versions instead of accidentally using macOS's Python 3.9.
fish_python_supported() {
  "$1" -c 'import platform, sys; raise SystemExit(0 if (3, 12) <= sys.version_info[:2] < (3, 14) and platform.machine() == "arm64" else 1)' >/dev/null 2>&1
}

if [ -x "$FISH_VENV_PYTHON" ]; then
  if ! fish_python_supported "$FISH_VENV_PYTHON"; then
    printf '%s\n' '现有 Fish Python 环境不兼容；已保留，未覆盖。请使用 Python 3.12/3.13 arm64 重新建立环境。' >&2
    exit 1
  fi
else
  FISH_BASE_PYTHON=""
  if [ -n "${FISH_PYTHON:-}" ]; then
    FISH_BASE_PYTHON="$(command -v "$FISH_PYTHON" || true)"
    if [ -z "$FISH_BASE_PYTHON" ] || ! fish_python_supported "$FISH_BASE_PYTHON"; then
      printf '%s\n' 'FISH_PYTHON 必须指向 Python 3.12 或 3.13 的 arm64 可执行文件。' >&2
      exit 1
    fi
  else
    for FISH_CANDIDATE in python3.12 python3.13 python3 \
      /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.13 \
      /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 \
      /Library/Frameworks/Python.framework/Versions/3.13/bin/python3; do
      FISH_CANDIDATE_PATH="$(command -v "$FISH_CANDIDATE" || true)"
      if [ -n "$FISH_CANDIDATE_PATH" ] && fish_python_supported "$FISH_CANDIDATE_PATH"; then
        FISH_BASE_PYTHON="$FISH_CANDIDATE_PATH"
        break
      fi
    done
  fi
  if [ -z "$FISH_BASE_PYTHON" ]; then
    printf '%s\n' '未找到 Python 3.12/3.13（推荐 3.12）。请先从 https://www.python.org/downloads/macos/ 安装官方 macOS universal2 版本，再重新运行首次安装。' \
      '本脚本不会安装系统 Python，也不会要求管理员密码。' >&2
    exit 1
  fi
  "$FISH_BASE_PYTHON" -m venv "$FISH_ROOT/.runtime/fish/venv"
fi

printf '%s\n' '正在安装 Fish 本地运行组件；此步骤不下载模型。'
exec "$FISH_VENV_PYTHON" -m pip install \
  --cache-dir "$FISH_ROOT/.runtime/fish/pip-cache" \
  -r "$FISH_ROOT/backend/requirements-fish.txt"
