#!/usr/bin/env python3
"""Copy a `td_py/*.py` file into its Text DAT inside `expanded/`.

    python3 scripts/sync_td_py.py heads_callbacks [more...]

`verify_toe.py` check 6 requires the Python embedded in the `.toe` to be byte-identical to the
copy in `td_py/`, which is what keeps the readable version honest. Edit `td_py/` and run this.

A `.text` file is not plain text: b'2\\n*', then six big-endian uint32 of which the last is the
body length in bytes, then the UTF-8 body. Writing the body without re-packing that length
leaves TouchDesigner reading a truncated script -- a silent, confusing failure -- so the header
is always rewritten here.
"""
import io
import os
import struct
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(HERE, 'expanded', 'dual-alpha-V16.toe.dir')

# Where each callbacks file lives inside the expanded tree.
PLACES = {
    'heads_callbacks': os.path.join(D, 'project1', 'SYNCD', 'heads_callbacks.text'),
    'pair_logic_callbacks': os.path.join(D, 'project1', 'SYNCD', 'pair_logic_callbacks.text'),
    'wave_callbacks': os.path.join(
        D, 'project1', 'SYNCD', 'container1websocket_example', 'wave_callbacks.text'),
}

PREFIX = b'2\n*'

if len(sys.argv) < 2:
    raise SystemExit('usage: sync_td_py.py %s' % ' | '.join(sorted(PLACES)))

for name in sys.argv[1:]:
    if name not in PLACES:
        raise SystemExit('unknown: %s (known: %s)' % (name, ', '.join(sorted(PLACES))))
    src = os.path.join(HERE, 'td_py', name + '.py')
    dst = PLACES[name]
    body = io.open(src, 'r', encoding='utf-8', newline='').read().replace('\r\n', '\n').encode('utf-8')
    io.open(dst, 'wb').write(PREFIX + struct.pack('>6I', 1, 1, 1, 1, 2, len(body)) + body)
    print('  %s -> %s (%d bytes)' % (os.path.relpath(src, HERE), os.path.relpath(dst, HERE), len(body)))

print('now: cd expanded && toecollapse dual-alpha-V16.toe.dir')
