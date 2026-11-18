#!/usr/bin/env bash
# Regenerate touchdesigner/expanded/ (the diffable text copy) from dual-alpha-V16.toe.
#
#   scripts/td-expand.sh            rewrite expanded/ from the .toe
#   scripts/td-expand.sh --check    exit 1 if expanded/ does not match the .toe
#
# Needs toeexpand, which ships with TouchDesigner (2025.x). Set TOEEXPAND to its path
# if it is not at the default location:
#   macOS    /Applications/TouchDesigner.app/Contents/MacOS/toeexpand
#   Windows  "C:/Program Files/Derivative/TouchDesigner/bin/toeexpand.exe" (Git Bash)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # touchdesigner/
NAME=dual-alpha-V16.toe
TOE="$HERE/$NAME"
OUT="$HERE/expanded"

if [ -z "${TOEEXPAND:-}" ]; then
  for c in /Applications/TouchDesigner.app/Contents/MacOS/toeexpand \
           "/c/Program Files/Derivative/TouchDesigner/bin/toeexpand.exe" \
           "C:/Program Files/Derivative/TouchDesigner/bin/toeexpand.exe"; do
    if [ -x "$c" ]; then TOEEXPAND="$c"; break; fi
  done
fi
[ -n "${TOEEXPAND:-}" ] && [ -x "$TOEEXPAND" ] || { echo "toeexpand not found; set TOEEXPAND" >&2; exit 2; }
[ -f "$TOE" ] || { echo "missing $TOE" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$TOE" "$TMP/$NAME"
# toeexpand writes NAME.dir and NAME.toc next to the file; it exits 1 even on success,
# so success is judged by the output existing
( cd "$TMP" && "$TOEEXPAND" "$NAME" >/dev/null 2>&1 || true )
[ -d "$TMP/$NAME.dir" ] && [ -f "$TMP/$NAME.toc" ] || { echo "toeexpand produced nothing" >&2; exit 1; }

if [ "${1:-}" = "--check" ]; then
  if diff -rq "$TMP/$NAME.dir" "$OUT/$NAME.dir" >/dev/null && cmp -s "$TMP/$NAME.toc" "$OUT/$NAME.toc"; then
    echo "expanded/ matches $NAME"
  else
    echo "expanded/ is out of date with $NAME: run scripts/td-expand.sh" >&2
    exit 1
  fi
  exit 0
fi

rm -rf "$OUT/$NAME.dir" "$OUT/$NAME.toc"
mkdir -p "$OUT"
mv "$TMP/$NAME.dir" "$OUT/$NAME.dir"
mv "$TMP/$NAME.toc" "$OUT/$NAME.toc"
echo "expanded $NAME -> expanded/$NAME.dir + expanded/$NAME.toc"
