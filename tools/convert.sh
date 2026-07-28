#!/usr/bin/env bash
# convert.sh — POSIX wrapper around the Chronosplat converter, tools/convert.py.
#
# Passes every argument straight through, so the CLI surface is identical to
# `python3 tools/convert.py`. See the wiki or `./tools/convert.sh --help`.
#
#   ./tools/convert.sh --input ./seq --output ./data --source-fps 24
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for candidate in python3 python py; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PY="$candidate"
    break
  fi
done

if [ -z "${PY:-}" ]; then
  echo "error: no Python interpreter found on PATH (need python3)." >&2
  exit 1
fi

exec "$PY" "$HERE/convert.py" "$@"
