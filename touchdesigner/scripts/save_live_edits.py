#!/usr/bin/env python3
"""Bake the hand edits made in the running instance into `expanded/`.

    python3 scripts/save_live_edits.py       # then re-collapse

Hand edits in TouchDesigner live only in memory, so they have to be written into `expanded/`
before anything reloads the file. `scripts/live_diff.py` finds them by comparing the running
instance against these files -- run that first, and add what it reports here.

What this writes
----------------
**The chart wave lines' position.** `WS/chopto1` and `WS/chopto2` are the CHOP-to-SOP
operators behind the two trace lines; both were moved to `startposx -0.6`. That is the edit
this script exists to keep.

What this deliberately does not write
-------------------------------------
`SYNCD/ramp2`'s colours were also edited live, to a flat grey (0.228 on all three channels)
from the V15 teal (0.082 / 0.574 / 0.456). That is the background, and a grey one was a
complaint earlier in this build, so it is left to a decision rather than baked in silently.

`WS/eeg_meta`'s constants also differ, and must never be baked: that operator holds live
counters -- messages, last-heard time, lost samples -- in its parameters.
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(HERE, 'expanded', 'dual-alpha-V16.toe.dir', 'project1')
WS = os.path.join(D, 'SYNCD', 'container1websocket_example')

# (file, parameter, value). Parameters absent from a .parm file are appended; present ones are
# replaced. A .parm file lists exactly the parameters that are not at their default.
EDITS = [
    (os.path.join(WS, 'chopto1.parm'), 'startposx', '-0.6'),
    (os.path.join(WS, 'chopto2.parm'), 'startposx', '-0.6'),
]


def apply(path, name, value):
    if not os.path.exists(path):
        return '%s: not found' % os.path.basename(path)
    lines = io.open(path, encoding='utf-8', newline='').read().replace('\r\n', '\n').split('\n')
    line = '%s 0 %s' % (name, value)
    for i, l in enumerate(lines):
        if l.split(' ')[:1] == [name]:
            if l == line:
                return '%s %s already %s' % (os.path.basename(path), name, value)
            lines[i] = line
            break
    else:
        # Insert before the closing '?', which is the parameter block's terminator.
        close = max(i for i, l in enumerate(lines) if l.strip() == '?')
        lines.insert(close, line)
    # LF only: a CRLF node file makes toecollapse emit a 0-byte .toe.
    io.open(path, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
    return '%s %s = %s' % (os.path.basename(path), name, value)


for path, name, value in EDITS:
    print('  ' + apply(path, name, value))
print('wave line position saved.')
print('Re-collapse: cd expanded && toecollapse dual-alpha-V16.toe.dir')
sys.exit(0)
