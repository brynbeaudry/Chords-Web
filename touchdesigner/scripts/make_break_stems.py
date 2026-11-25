#!/usr/bin/env python3
"""Synthesise a drum-and-bass breakbeat as four separate stems, for the EEG to mix.

    python3 scripts/make_break_stems.py            # writes touchdesigner/audio/*.wav

Why synthesised rather than sampled
-----------------------------------
The quintessential jungle break is the Amen Break (The Winstons, "Amen, Brother", 1969), and
it is a copyrighted commercial recording — as are Funky Drummer, Think (About It) and Apache.
None of them can go in this repository.

It is also the wrong tool for the job. The piece needs to move kick, snare and hat
*independently* from the two people's signals, and those cannot be separated out of a single
mixed break. So each drum is generated on its own, which is both lawful and what the mapping
actually needs. These are original waveforms, no sample content.

What it writes, into touchdesigner/audio/
-----------------------------------------
Four mono 16-bit 44.1 kHz loops, all exactly 2 bars at 170 BPM (2.824 s), so they stay in
phase when played together:

    break_kick.wav    sine sweep 120 -> 45 Hz, fast decay
    break_snare.wav   noise burst plus a 185 Hz body
    break_hat_on.wav  high-passed noise on the eighths
    break_hat_off.wav the off-grid sixteenths, kept separate so swing can delay them
    break_bass.wav    saw-ish sub following the kick, deliberately harmonically rich so a
                      low-pass in TouchDesigner can take it from clean sub to growl

The pattern is a syncopated two-bar breakbeat in sixteenths: the kick lands off the grid in
bar 2 and the snare carries the backbeat with ghost hits, which is what gives it the jungle
feel rather than a straight four-four.
"""
import array
import io
import math
import os
import random
import struct
import wave

SR = 44100
BPM = 170.0
STEPS_PER_BAR = 16
BARS = 2
STEP_S = 60.0 / BPM / 4.0              # a sixteenth
TOTAL_STEPS = STEPS_PER_BAR * BARS
LOOP_S = TOTAL_STEPS * STEP_S
N = int(round(LOOP_S * SR))

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, 'audio')

# Sixteenth grid, two bars. 'X' a full hit, 'o' a ghost/quieter hit.
KICK  = 'X.........X.....' '..X.......X.....'
SNARE = '....X.......X..o' '....X..o....X...'
# The hat is split so swing has something to delay: the on-grid eighths stay put and the
# off-grid sixteenths are pushed late by the Delay CHOP. That is what swing physically is.
HAT_ON  = 'X...X...X...X...' 'X...X...X...X...'
HAT_OFF = '..o...o...o...o.' '..o...o...o...o.'
BASS  = 'X.........X.....' '..X.......X.....'   # follows the kick


def env(n, attack, decay):
    """Short attack, exponential decay, as a list of gains."""
    a = max(1, int(attack * SR))
    out = []
    for i in range(n):
        g = i / a if i < a else math.exp(-(i - a) / (decay * SR))
        out.append(g)
    return out


def kick(dur=0.28):
    n = int(dur * SR)
    e = env(n, 0.001, 0.055)
    ph = 0.0
    out = []
    for i in range(n):
        f = 45.0 + 75.0 * math.exp(-i / (0.025 * SR))      # 120 Hz -> 45 Hz
        ph += 2 * math.pi * f / SR
        out.append(math.sin(ph) * e[i])
    return out


def snare(dur=0.20, seed=3):
    r = random.Random(seed)
    n = int(dur * SR)
    e = env(n, 0.0005, 0.035)
    ph = 0.0
    lp = 0.0
    out = []
    for i in range(n):
        noise = r.uniform(-1.0, 1.0)
        lp += 0.55 * (noise - lp)                          # tame the very top
        ph += 2 * math.pi * 185.0 / SR
        out.append((0.75 * lp + 0.45 * math.sin(ph)) * e[i])
    return out


def hat(dur=0.055, seed=7):
    r = random.Random(seed)
    n = int(dur * SR)
    e = env(n, 0.0003, 0.010)
    hp = 0.0
    prev = 0.0
    out = []
    for i in range(n):
        noise = r.uniform(-1.0, 1.0)
        hp = 0.85 * (hp + noise - prev)                    # one-pole high pass
        prev = noise
        out.append(hp * e[i])
    return out


def bass(dur=0.42):
    """Saw-ish, so a low-pass downstream can open it from sub to growl."""
    n = int(dur * SR)
    e = env(n, 0.004, 0.16)
    f = 55.0
    out = []
    for i in range(n):
        t = i / SR
        saw = 2.0 * ((t * f) % 1.0) - 1.0
        sub = math.sin(2 * math.pi * f * t)
        out.append((0.55 * saw + 0.75 * sub) * e[i])
    return out


def render(pattern, voice, gain_full=1.0, gain_ghost=0.45):
    buf = [0.0] * N
    for step, ch in enumerate(pattern):
        if ch == '.':
            continue
        g = gain_full if ch == 'X' else gain_ghost
        start = int(round(step * STEP_S * SR))
        hit = voice()
        for i, v in enumerate(hit):
            j = start + i
            if j < N:
                buf[j] += v * g
            else:                                          # wrap, so the loop joins cleanly
                buf[j - N] += v * g
    return buf


def write_wav(name, buf, peak=0.89):
    os.makedirs(OUT, exist_ok=True)
    hi = max(1e-9, max(abs(v) for v in buf))
    scale = peak / hi
    data = array.array('h', (int(max(-32767, min(32767, v * scale * 32767))) for v in buf))
    path = os.path.join(OUT, name)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    print('  %-20s %5.3f s  %6.1f kB  peak %.2f' % (name, N / SR, os.path.getsize(path) / 1024.0, hi * scale))


print('%g BPM, %d bars, loop %.3f s (%d frames at %d Hz)' % (BPM, BARS, LOOP_S, N, SR))
write_wav('break_kick.wav', render(KICK, kick))
write_wav('break_snare.wav', render(SNARE, snare))
write_wav('break_hat_on.wav', render(HAT_ON, hat, gain_full=0.85))
write_wav('break_hat_off.wav', render(HAT_OFF, hat, gain_full=0.5, gain_ghost=0.42))
write_wav('break_bass.wav', render(BASS, bass))
print('all four are the same length, so they stay in phase when played together')
