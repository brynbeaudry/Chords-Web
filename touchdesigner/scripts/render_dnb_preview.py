#!/usr/bin/env python3
"""Render an offline preview of the EEG-mixed break, so the sound can be judged anywhere.

    python3 scripts/render_dnb_preview.py [out.wav]      # default: audio/dnb_preview.wav

This reproduces /project1/dnb_* in plain Python from the same stems, and walks through the
states the two people can be in, eight seconds each, announced in the printout:

    1  nobody connected          everything muted by `stale`
    2  connected, no alpha       the bed: quiet kick and hats, filter shut
    3  person 1 only             hats and treble come up, kick envelope opens the filter
    4  person 2 only             kick, bass, distortion and bass EQ come up
    5  both, person 1 deeper     together: faster, snare in, swing, echo, resonance
    6  both, deepest             everything at full: fastest, widest filter, most drive

The bass is two layers: a clean sine sub carrying the fundamental, untouched, and a
Reese (three detuned band-limited saws) carrying the growl, which is the only part the
filter, the wobble and the drive act on.

It is a close approximation, not the TouchDesigner graph: the low-pass is a one-pole rather
than TD's Audio Filter, and the EQ is two shelves rather than 16 bands. Gain staging, the
envelope follower, the wobble, the swing delay, the soft clip and the -1 dB limiter all match.
Use it to judge whether the mapping feels right; use TouchDesigner for the real thing.
"""
import array
import io
import math
import os
import sys
import wave

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUD = os.path.join(HERE, 'audio')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(AUD, 'dnb_preview.wav')
SR = 44100
SECTION_S = 8.0

# (label, d1_level, d2_level) -- pair_level is min() when both are in, as STATE computes it
SECTIONS = [
    ('nobody connected (stale: muted)', None, None),
    ('connected, no alpha',             0.0,  0.0),
    ('person 1 only',                   0.9,  0.0),
    ('person 2 only',                   0.0,  0.9),
    ('both in, person 1 deeper',        0.9,  0.4),
    ('both in, deepest',                1.0,  1.0),
]


def load(name):
    with wave.open(os.path.join(AUD, name)) as w:
        n = w.getnframes()
        raw = array.array('h')
        raw.frombytes(w.readframes(n))
        return [v / 32768.0 for v in raw]


KICK = load('break_kick.wav')
SNARE = load('break_snare.wav')
HATON = load('break_hat_on.wav')
HATOFF = load('break_hat_off.wav')
SUB = load('break_sub.wav')
REESE = load('break_reese.wav')
LOOP = len(KICK)


def tap(buf, pos):
    """Read a stem at a fractional position, wrapping -- this is the speed control."""
    i = int(pos) % LOOP
    j = (i + 1) % LOOP
    f = pos - int(pos)
    return buf[i] * (1.0 - f) + buf[j] * f


out = []
print('rendering %d sections of %.0f s' % (len(SECTIONS), SECTION_S))
for label, l1, l2 in SECTIONS:
    live = 0.0 if l1 is None else 1.0
    l1 = l1 or 0.0
    l2 = l2 or 0.0
    pair = min(l1, l2) if (l1 > 0 and l2 > 0) else 0.0

    speed = 0.82 + 0.36 * pair
    v_kick = live * (0.30 + 0.70 * l2)
    v_snare = live * (0.20 + 0.80 * pair)
    v_hat = live * (0.25 + 0.75 * l1)
    v_hatoff = live * (0.15 + 0.85 * l1)
    v_sub = live * (0.30 + 0.70 * l2)
    v_reese = live * (0.20 + 0.80 * l2)
    swing_s = 0.012 + 0.023 * pair
    wob_hz = 1.5 + 6.0 * pair
    res = 0.3 + 2.2 * pair
    drive = 10.0 ** ((16.0 * l2) / 20.0)            # inputgain dB -> linear
    eq_bass = 10.0 ** ((-3.0 + 9.0 * l2) / 20.0)
    eq_treb = 10.0 ** ((-3.0 + 9.0 * l1) / 20.0)
    echo_g = 0.12 + 0.38 * pair
    print('  %-34s speed %.2f  cutoff-base %4.0f Hz  drive %+5.1f dB  swing %4.1f ms'
          % (label, speed, 90 + 700 * l2, 16.0 * l2, swing_s * 1000))

    pos = 0.0
    env = 0.0                                        # the kick envelope follower, 80 ms
    lp = 0.0                                         # the bass low-pass state
    swing_n = int(swing_s * SR)
    hist = []                                        # for the echo, a dotted eighth
    echo_n = int(0.1058 * SR)
    for i in range(int(SECTION_S * SR)):
        k = tap(KICK, pos)
        env += (abs(k) - env) * (1.0 - math.exp(-1.0 / (0.08 * SR)))
        cutoff = 90 + 700 * l2 + 2200 * env * l1 + 450 * pair * math.sin(
            2 * math.pi * wob_hz * i / SR)
        cutoff = max(40.0, min(6000.0, cutoff))
        a = 1.0 - math.exp(-2 * math.pi * cutoff / SR)
        # Only the Reese is filtered and driven. The sub goes through untouched: the
        # moment you low-pass or clip the fundamental it stops being a sub.
        r = tap(REESE, pos) * v_reese
        lp += a * (r + res * 0.25 * (r - lp) - lp)   # one-pole with a little resonance
        growl = math.tanh(lp * drive)
        sub = tap(SUB, pos) * v_sub
        bass = sub + growl * 0.9
        dry = (k * v_kick
               + tap(SNARE, pos) * v_snare
               + tap(HATON, pos) * v_hat
               + tap(HATOFF, pos - swing_n * speed) * v_hatoff
               + bass) * 0.30
        lo = dry * eq_bass * 0.6
        hi = dry * eq_treb * 0.4
        s = lo + hi
        hist.append(s)
        if len(hist) > echo_n:
            s += hist[-echo_n] * echo_g
        out.append(s)
        pos += speed

# -1 dB limiter, as the last stage in TouchDesigner
CEIL = 10.0 ** (-1.0 / 20.0)
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
print('wrote %s  (%.1f s, %.1f kB)' % (OUT, len(out) / SR, os.path.getsize(OUT) / 1024.0))
