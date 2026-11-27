#!/usr/bin/env python3
"""Render an offline preview of the EEG-mixed break, so the sound can be judged anywhere.

    python3 scripts/render_dnb_preview.py [out.wav]      # default: audio/dnb_preview.wav

This reproduces /project1/dnb_* in plain Python from the same stems, and walks through the
states the two people can be in, eight seconds each, announced in the printout:

    1  nobody connected          everything muted
    2  connected, no alpha       the bed: quiet kick and hats, filter shut
    3  person 1 only             hats and treble come up, kick envelope opens the filter
    4  person 2 only             kick, bass, drive and bass EQ come up
    5  both, person 1 deeper     coming together: the wobble and the drive start to let go
    6  both, deepest             resolved: no wobble, no distortion, clean sub, open echo

Nothing steps. The section targets pass through the same 0.35 s smoothing that `dnb_ctl`
applies in TouchDesigner before anything reads it, so levels glide, the mute fades, the filter
sweeps and the playback speed eases instead of jumping in pitch. That matters as much as the
sounds do: silence followed by an instant full mix is a slam, not a cue.

The bass is two layers: a clean sine sub carrying the fundamental, untouched, and a Reese
(three detuned band-limited saws) carrying the growl, which is the only part the filter, the
wobble and the drive act on.

The mapping resolves rather than escalates: wobble, resonance and distortion all ride
(1 - pair_level), so they are there while the two are apart and gone once they hold the sync.
Alpha is calm focus, so arriving should sound settled. What grows instead is the weight of the
kick and snare and the detail in the hats.

It is a close approximation, not the TouchDesigner graph: the low-pass is a one-pole rather
than TD's Audio Filter, and the EQ is two shelves rather than 16 bands. Gain staging, the
envelope follower, the wobble, the swing delay, the soft clip and the -1 dB limiter all match.
Use it to judge whether the mapping feels right; use TouchDesigner for the real thing.
"""
import array
import math
import os
import sys
import wave

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUD = os.path.join(HERE, 'audio')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(AUD, 'dnb_preview.wav')
SR = 44100
SECTION_S = 8.0
SMOOTH_S = 0.12                       # one-pole time constant; settles in about 0.35 s

# (label, d1_level, d2_level); None means not connected at all
SECTIONS = [
    ('nobody connected (muted)', None, None),
    ('connected, no alpha',      0.0,  0.0),
    ('person 1 only',            0.9,  0.0),
    ('person 2 only',            0.0,  0.9),
    ('both in, person 1 deeper', 0.9,  0.4),
    ('both in, deepest',         1.0,  1.0),
]


def load(name):
    with wave.open(os.path.join(AUD, name)) as w:
        raw = array.array('h')
        raw.frombytes(w.readframes(w.getnframes()))
        return [v / 32768.0 for v in raw]


KICK = load('break_kick.wav')
SNARE = load('break_snare.wav')
HATON = load('break_hat_on.wav')
HATOFF = load('break_hat_off.wav')
SUB = load('break_sub.wav')
REESE = load('break_reese.wav')


def tap(buf, pos):
    """Read a stem at a fractional position, wrapping on its own length -- the drums and the
    bass are different lengths, so each wraps on itself. This is also the speed control."""
    n = len(buf)
    i = int(pos) % n
    j = (i + 1) % n
    f = pos - int(pos)
    return buf[i] * (1.0 - f) + buf[j] * f


for label, a, b in SECTIONS:
    print('  %-28s d1 %-5s d2 %-5s' % (label, 'off' if a is None else a,
                                       'off' if b is None else b))

total = int(SECTION_S * SR * len(SECTIONS))
smooth = 1.0 - math.exp(-1.0 / (SMOOTH_S * SR))
env_a = 1.0 - math.exp(-1.0 / (0.08 * SR))

l1 = l2 = live = 0.0                  # the smoothed controls: what dnb_ctl holds
pos = 0.0
env = 0.0
lp = 0.0
hist = []
echo_n = int(0.1058 * SR)
out = []

for n in range(total):
    sec = min(len(SECTIONS) - 1, int(n / (SECTION_S * SR)))
    _, t1, t2 = SECTIONS[sec]
    l1 += smooth * ((t1 or 0.0) - l1)
    l2 += smooth * ((t2 or 0.0) - l2)
    live += smooth * ((0.0 if t1 is None else 1.0) - live)

    pair = min(l1, l2) if (l1 > 0.001 and l2 > 0.001) else 0.0
    en = max(l1, l2)
    calm = 1.0 - pair                 # the agitation sources ride this, not pair
    speed = 1.00 - 0.05 * pair        # a settle, not a lurch
    drive = 10.0 ** ((12.0 * l2 * calm) / 20.0)
    eq_bass = 10.0 ** ((-3.0 + 9.0 * l2) / 20.0)
    eq_treb = 10.0 ** ((-3.0 + 9.0 * l1) / 20.0)
    swing_n = int((0.012 + 0.023 * pair) * SR)

    k = tap(KICK, pos)
    env += env_a * (abs(k) - env)
    base = 90 + 500 * l2 + 1600 * env * l1
    wob = math.sin(2 * math.pi * (1.0 + 1.2 * calm) * n / SR)
    cutoff = max(40.0, min(6000.0, base * 2.0 ** (0.35 * calm * wob)))
    a_lp = 1.0 - math.exp(-2 * math.pi * cutoff / SR)
    res = 0.8 * calm

    # Only the Reese is filtered and driven. The sub goes through untouched: the moment you
    # low-pass or clip the fundamental it stops being a sub. The growl recedes as they sync.
    r = tap(REESE, pos) * live * (0.15 + 0.40 * l2 * calm)
    lp += a_lp * (r + res * 0.25 * (r - lp) - lp)
    growl = math.tanh(lp * drive)
    sub = tap(SUB, pos) * live * (0.30 + 0.70 * l2)

    dry = (k * live * (0.30 + 0.70 * en)
           + tap(SNARE, pos) * live * (0.30 + 0.50 * en + 0.20 * pair)
           + tap(HATON, pos) * live * (0.20 + 0.80 * l1)
           + tap(HATOFF, pos - swing_n * speed) * live * (0.10 + 0.90 * max(l1, pair))
           + sub + growl * 0.65) * 0.22

    s = dry * eq_bass * 0.6 + dry * eq_treb * 0.4
    hist.append(s)
    if len(hist) > echo_n:
        s += hist[-echo_n] * (0.10 + 0.22 * pair)
    out.append(s)
    pos += speed

CEIL = 10.0 ** (-1.0 / 20.0)          # the -1 dB limiter, the last stage in TouchDesigner
peak = max(1e-9, max(abs(v) for v in out))
if peak > CEIL:
    out = [v * (CEIL / peak) for v in out]
print('peak before limiting %.3f, output ceiling %.3f' % (peak, CEIL))

data = array.array('h', (int(max(-32767, min(32767, v * 32767))) for v in out))
with wave.open(OUT, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(data.tobytes())
print('wrote %s  (%.1f s, %.0f kB)' % (OUT, len(out) / SR, os.path.getsize(OUT) / 1024.0))
