#!/bin/sh
set -eu
FISH_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
FISH_PYTHON="$FISH_ROOT/.runtime/fish/venv/bin/python"
if [ ! -x "$FISH_PYTHON" ]; then
  printf '%s\n' 'Please run scripts/fish-install.sh first.' >&2
  exit 1
fi

FISH_LICENSE="$FISH_ROOT/licenses/FISH-AUDIO-RESEARCH-LICENSE.md"
FISH_ACCEPTANCE="$FISH_ROOT/.runtime/fish/license-accepted.sha256"
if [ ! -f "$FISH_LICENSE" ]; then
  printf '%s\n' '缺少 Fish 模型许可文件，请重新下载完整项目。尚未开始下载模型。' >&2
  exit 1
fi
FISH_LICENSE_HASH="$(shasum -a 256 "$FISH_LICENSE" | awk '{print $1}')"
FISH_ACCEPTED_HASH="$(test ! -f "$FISH_ACCEPTANCE" || head -n 1 "$FISH_ACCEPTANCE")"
if [ "$FISH_ACCEPTED_HASH" != "$FISH_LICENSE_HASH" ]; then
  printf '%s\n' '即将从官方 Hugging Face 下载约 11 GB Fish S2 Pro BF16 模型。' \
    'Fish Audio Research License：研究及非商业个人用途免费；商业用途需要另行授权。' \
    "完整许可：$FISH_LICENSE" \
    '在线许可：https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md'
  if [ ! -t 0 ]; then
    printf '%s\n' '需要使用者交互确认许可。请在终端运行 scripts/fish-download.sh 或双击首次安装.command。' >&2
    exit 1
  fi
  printf '\n%s\n' '请阅读完整许可（滚动查看，按 q 返回）：'
  less "$FISH_LICENSE"
  printf '\n%s' '已阅读并同意许可，且要开始下载，请输入 YES（其他输入取消）：'
  IFS= read -r FISH_REPLY || FISH_REPLY=""
  if [ "$FISH_REPLY" != YES ]; then
    printf '%s\n' '已取消，未下载模型、未记录同意。'
    exit 1
  fi
  mkdir -p "$FISH_ROOT/.runtime/fish"
  printf '%s\n' "$FISH_LICENSE_HASH" > "$FISH_ACCEPTANCE"
fi
exec "$FISH_PYTHON" "$FISH_ROOT/backend/fish_download.py"
