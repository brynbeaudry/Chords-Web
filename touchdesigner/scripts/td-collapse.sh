#!/usr/bin/env bash
# Rebuild touchdesigner/dual-alpha-V16.toe from the text copy in touchdesigner/expanded/.
#
#   scripts/td-collapse.sh
#
# Equivalent by hand:  cd touchdesigner/expanded && toecollapse dual-alpha-V16.toe.dir
#                      then move expanded/dual-alpha-V16.toe up one folder.
# toecollapse reads NAME.toe.dir plus the file list NAME.toe.toc next to it; every file in
# the .dir must be listed in the .toc. Needs toecollapse from TouchDesigner (2025.x); set
# TOECOLLAPSE if it is not at the default location (see td-expand.sh).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
NAME=dual-alpha-V16.toe
SRC="$HERE/expanded"

if [ -z "${TOECOLLAPSE:-}" ]; then
  for c in /Applications/TouchDesigner.app/Contents/MacOS/toecollapse \
           "/c/Program Files/Derivative/TouchDesigner/bin/toecollapse.exe" \
           "C:/Program Files/Derivative/TouchDesigner/bin/toecollapse.exe"; do
    if [ -x "$c" ]; then TOECOLLAPSE="$c"; break; fi
  done
fi
[ -n "${TOECOLLAPSE:-}" ] && [ -x "$TOECOLLAPSE" ] || { echo "toecollapse not found; set TOECOLLAPSE" >&2; exit 2; }
[ -d "$SRC/$NAME.dir" ] && [ -f "$SRC/$NAME.toc" ] || { echo "missing expanded/$NAME.dir or .toc" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$SRC/$NAME.dir" "$TMP/"
cp "$SRC/$NAME.toc" "$TMP/"
( cd "$TMP" && "$TOECOLLAPSE" "$NAME.dir" >/dev/null 2>&1 || true )
[ -s "$TMP/$NAME" ] || { echo "toecollapse produced nothing" >&2; exit 1; }
mv "$TMP/$NAME" "$HERE/$NAME"
echo "collapsed expanded/$NAME.dir -> $NAME"
