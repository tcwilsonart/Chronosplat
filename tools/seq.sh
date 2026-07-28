#!/usr/bin/env bash
# seq.sh - Chronosplat short wrapper for the common conversion (POSIX twin of seq.cmd).
#
#   tools/seq.sh capyFall                  convert raw_data/capyFall -> data/capyFall
#   tools/seq.sh capyFall --dry-run        plan only, convert nothing
#   tools/seq.sh capyFall --frame-step 2   any convert.py flag passes through
#
# Defaults applied: --source-fps 24 --gpu 0 --force, --project from the folder
# name. Pass a flag yourself to override; the later value wins.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

list_available() {
  if [ -d "$REPO/raw_data" ]; then
    echo "  available in raw_data/:"
    for d in "$REPO"/raw_data/*/; do
      [ -d "$d" ] && echo "      $(basename "$d")"
    done
  fi
}

if [ $# -lt 1 ]; then
  echo
  echo "  usage: tools/seq.sh <name> [extra convert.py flags]"
  echo
  echo "  <name> is a folder under raw_data/, converted into data/<name>."
  echo
  list_available
  echo
  exit 1
fi

NAME="$1"
shift

if [ ! -d "$REPO/raw_data/$NAME" ]; then
  echo
  echo "  ERROR: raw_data/$NAME does not exist."
  echo
  list_available
  echo
  exit 1
fi

PY=""
for candidate in python3 python py; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [ -z "$PY" ]; then
  echo "  ERROR: no Python interpreter found on PATH." >&2
  exit 1
fi

exec "$PY" "$HERE/convert.py" \
  --input "$REPO/raw_data/$NAME" \
  --output "$REPO/data/$NAME" \
  --source-fps 24 --gpu 0 --force --project "$NAME" "$@"
