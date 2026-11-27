#!/usr/bin/env python3
"""Make the merge happen on any overlap, instead of only on a long one.

    python3 scripts/faster_merge.py            # edits expanded/, then re-collapse

The problem
-----------
Measured on the running file, the chain from "both people are in alpha" to "the transition
plays" was:

    pair_level > 0  ->  pair_logic.together = 1                      immediate
                    ->  pair_logic.hold_s accumulates
                        held = 1 once hold_s >= Hold time            3.0 s
                        -> sel_held -> trigger3 (attack 1, decay 3)  the transition
    together = 1    ->  filter18, a 3 s gauss ease = E -> heads turn to face each other

So nothing happened until the two people had overlapped for **three continuous seconds**, and
the heads needed another three to arrive. On top of that the app cannot report alpha instantly:
its prominence comes from a 2 s window, so a short burst is diluted and is recognised about a
second after it starts. Real alpha episodes on these montages last a few seconds, which left
the piece's whole payoff gated behind something the signal does not reliably do.

What this changes
-----------------
    /controls/Hold_time   value0   -> 0.2 s   (the slider's own default; range is still 0-5)
    SYNCD/filter18        width    -> 1.5 s   (the ease of `together` into the head turn)
    pair_logic_callbacks  DEFAULTS -> 0.2     (used only when /controls is missing)

Any overlap, not a sustained one
--------------------------------
0.2 s is about two detector hops, so the merge fires as soon as the two people are in alpha at
the same time. It is deliberately not 0: `FORCE_EPS` in `pair_logic_callbacks` treats Hold time
at or below 0.05 as **forced sync**, which ignores the data entirely, and that end stop is
worth keeping as a separate thing an operator can reach for.

`Forgiveness` (1 s) still pauses the hold count through a brief drop rather than resetting it,
so a flickering overlap reads as one continuous one.

Nothing latches
---------------
The heads are driven by `together` through `filter18`, so they ease toward each other for as
long as the overlap lasts and ease back to each person's own live state when it ends. Dropping
out is not a failure state and costs nothing: the pair can simply try again, as often as they
like. `filter18` at 1.5 s is what makes that ease visible inside a short overlap instead of
being a third of the way round by the time the overlap is over.

The transition envelope is unchanged. `trigger3` is attack 1 s, decay 3 s, sustain 0, so once
it fires the animation plays out in full even if the overlap has already ended.
"""
import io
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(HERE, 'expanded', 'dual-alpha-V16.toe.dir')
SY = os.path.join(D, 'project1', 'SYNCD')

# Set absolutely, by line pattern, so the script is idempotent and states what the file should
# end up containing rather than what it happened to contain when the edit was written.
EDITS = [
    (os.path.join(D, 'controls', 'Hold_time.parm'),
     r'^value0 0 .*$', 'value0 0 0.2'),
    (os.path.join(SY, 'filter18.parm'),
     r'^width 0 .*$', 'width 0 1.5'),
    (os.path.join(SY, 'pair_logic_callbacks.text'),
     r"^DEFAULTS = .*$",
     "DEFAULTS = {'Hold_time': 0.2, 'Relative_alpha_sync': 0.0, 'Forgiveness': 1.0}"),
]

# A `.text` file (a DAT's body) is b'2\n*', six big-endian uint32 whose last is the body
# length, then the UTF-8 body. Editing it as plain text leaves a stale length and
# TouchDesigner reads a truncated script, so the header is re-packed. See swap_sides.py.
TEXT_PREFIX = b'2\n*'
TEXT_HDR = 3 + 24


def read(path):
    if path.endswith('.text'):
        b = io.open(path, 'rb').read()
        assert b.startswith(TEXT_PREFIX), '%s: not a DAT text file' % path
        n = struct.unpack('>6I', b[3:TEXT_HDR])[5]
        assert len(b) - TEXT_HDR == n, '%s: header says %d, file has %d' % (path, n, len(b) - TEXT_HDR)
        return b[TEXT_HDR:].decode('utf-8')
    return io.open(path, 'r', encoding='utf-8', newline='').read()


def write(path, text):
    text = text.replace('\r\n', '\n')          # LF only, or toecollapse emits a 0-byte .toe
    if path.endswith('.text'):
        body = text.encode('utf-8')
        io.open(path, 'wb').write(TEXT_PREFIX + struct.pack('>6I', 1, 1, 1, 1, 2, len(body)) + body)
        return
    io.open(path, 'w', encoding='utf-8', newline='\n').write(text)


problems = []
for path, pattern, _ in EDITS:
    if not os.path.exists(path):
        problems.append('%s: not found' % path)
    elif not re.search(pattern, read(path), re.M):
        problems.append('%s: no line matching %s' % (os.path.basename(path), pattern))
if problems:
    print('nothing written. ' + '; '.join(problems))
    raise SystemExit(1)

for path, pattern, after in EDITS:
    text = read(path)
    # A plain string replacement, not a regex template: the text contains braces and quotes.
    new = re.sub(pattern, lambda _m, a=after: a, text, count=1, flags=re.M)
    rel = os.path.relpath(path, HERE)
    if new != text:
        write(path, new)
        print('  %s' % rel)
    else:
        print('  %s (already set)' % rel)

print('Hold time 0.2 s (any overlap), head ease 1.5 s.')
print('Re-collapse: cd expanded && toecollapse dual-alpha-V16.toe.dir')
sys.exit(0)
