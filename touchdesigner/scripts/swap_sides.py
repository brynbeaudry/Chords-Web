#!/usr/bin/env python3
"""Put person 1 on the LEFT of the projection and person 2 on the right.

    python3 scripts/swap_sides.py            # edits expanded/, then re-collapse

Why
---
V15 wired person 1 to the right-hand face and object, and V16 inherited it. In the room the
two people sit left and right, and the person on the operator's left is the one plugged into
device 1, so the projection read back to front. This flips the *side wiring* only.

What it does not do
-------------------
It does not rename anything. `d1_*` still means person 1 everywhere — in the contract, in the
app, in `eeg`, in `heads`. The fix is entirely in the seven places where a side-specific
operator picks a person, which is where the mistake actually was:

    heads_callbacks   R_ry <- d2_angle, L_ry <- d1_angle   (the face turns)
    okgreyR / okgreyL saturation <- d2_sat / d1_sat         (the grey-out when not ok)
    math22 / math28   gain <- d2_calm / d1_calm             (how far each object calms)
    wave_slot1/2/3    renamefrom "d2_w d1_w"                (the waveform: chan1-3 are the
                                                             right side, chan4-6 the left)

Renaming the channels at ingestion instead would have been one line, but then every `d1_`
channel inside the file would hold person 2's value and every expression and document that
mentions them would be wrong. Seven honest edits beat one lie.

The sound does not change. It is a mono mix sent to both output channels, so it has no sides;
person 1 still drives the hats, the bass filter and the treble.
"""
import io
import struct
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(HERE, 'expanded', 'dual-alpha-V16.toe.dir', 'project1')
SY = os.path.join(D, 'SYNCD')
WS = os.path.join(SY, 'container1websocket_example')

# (path, before, after). Every one is asserted present, so a half-applied run is impossible:
# the script fails before writing anything.
EDITS = [
    (os.path.join(SY, 'heads_callbacks.text'),
     "\tout['R_ry'] = out['d1_angle']           # right face, transform6.ry via FrotatepositionR\n"
     "\tout['L_ry'] = -out['d2_angle']          # left face, transform5.ry via FrotatepositionL",
     "\t# Person 1 is the LEFT side of the projection: that is where device 1 sits in the room.\n"
     "\tout['R_ry'] = out['d2_angle']           # right face  = person 2, transform6.ry via FrotatepositionR\n"
     "\tout['L_ry'] = -out['d1_angle']          # left face   = person 1, transform5.ry via FrotatepositionL"),

    (os.path.join(SY, 'okgreyR.parm'),
     "saturationmult 17 1 op('heads')['d1_sat']",
     "saturationmult 17 1 op('heads')['d2_sat']"),
    (os.path.join(SY, 'okgreyL.parm'),
     "saturationmult 17 1 op('heads')['d2_sat']",
     "saturationmult 17 1 op('heads')['d1_sat']"),

    (os.path.join(SY, 'math22.parm'),
     "gain 17 1.84 \"op('select20')['v1'] * op('heads')['d1_calm']\"",
     "gain 17 1.84 \"op('select20')['v1'] * op('heads')['d2_calm']\""),
    (os.path.join(SY, 'math28.parm'),
     "gain 17 1 \"op('select20')['v1'] * op('heads')['d2_calm']\"",
     "gain 17 1 \"op('select20')['v1'] * op('heads')['d1_calm']\""),
]
# chan1-3 feed the right object and its colours, chan4-6 the left.
for i in (1, 2, 3):
    EDITS.append((os.path.join(WS, 'wave_slot%d.parm' % i),
                  'renamefrom 0 "d1_w d2_w"', 'renamefrom 0 "d2_w d1_w"'))

# `heads.script` and `wave.script` are only cached *channel name* lists (R_ry, L_ry, d1_w, …),
# not copies of the logic, and none of those names change here -- so there is no stale cache to
# fix up. Checked rather than assumed: heads.script is 773 bytes against the callbacks' 5597.


# A `.text` file (the body of a Text DAT) is not plain text: it is b'2\n*', then six
# big-endian uint32 of which the last is the body length in bytes, then the UTF-8 body. Edit
# the body without re-packing that length and TouchDesigner reads a truncated script -- so
# these are handled as bytes and the header is rewritten. `.parm` files are plain text.
TEXT_PREFIX = b'2\n*'
TEXT_HDR = 3 + 24


def is_dat(path):
    return path.endswith('.text')


def read(path):
    if is_dat(path):
        b = io.open(path, 'rb').read()
        assert b.startswith(TEXT_PREFIX), '%s: not a DAT text file' % path
        n = struct.unpack('>6I', b[3:TEXT_HDR])[5]
        assert len(b) - TEXT_HDR == n, '%s: header says %d bytes, file has %d' % (path, n, len(b) - TEXT_HDR)
        return b[TEXT_HDR:].decode('utf-8')
    return io.open(path, 'r', encoding='utf-8', newline='').read()


def write(path, text):
    # LF only: a CRLF .toc or node file makes toecollapse emit a 0-byte .toe.
    text = text.replace('\r\n', '\n')
    if is_dat(path):
        body = text.encode('utf-8')
        head = struct.pack('>6I', 1, 1, 1, 1, 2, len(body))
        io.open(path, 'wb').write(TEXT_PREFIX + head + body)
        return
    io.open(path, 'w', encoding='utf-8', newline='\n').write(text)


missing = []
for path, before, after in EDITS:
    if not os.path.exists(path):
        missing.append('%s: not found' % path)
    elif before not in read(path):
        if after in read(path):
            missing.append('%s: already swapped' % os.path.basename(path))
        else:
            missing.append('%s: expected text not found' % os.path.basename(path))
if missing:
    print('nothing written. ' + '; '.join(missing))
    raise SystemExit(1)

for path, before, after in EDITS:
    write(path, read(path).replace(before, after, 1))
    print('  %s' % os.path.relpath(path, HERE))

print('%d edits applied. Person 1 is now the left side.' % len(EDITS))
print('Re-collapse: cd expanded && toecollapse dual-alpha-V16.toe.dir')
sys.exit(0)
