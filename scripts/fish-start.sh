#!/bin/sh
set -eu
FISH_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
FISH_PYTHON="$FISH_ROOT/.runtime/fish/venv/bin/python"
if [ ! -x "$FISH_PYTHON" ]; then
  printf '%s\n' 'Fish local environment is not installed. Run scripts/fish-install.sh first.' >&2
  exit 1
fi
exec "$FISH_PYTHON" -u "$FISH_ROOT/backend/fish_server.py" "$@"
