#!/usr/bin/env python3
"""Synthesise a drum-and-bass breakbeat as six separate stems, for the EEG to mix.

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
Six mono 16-bit 44.1 kHz loops, all exactly 2 bars at 170 BPM (2.824 s), so they stay in
phase when played together:

    break_kick.wav    sine sweep 120 -> 45 Hz, fast decay
    break_snare.wav   noise burst plus a 185 Hz body
    break_hat_on.wav  a short inharmonic metal accent on the eighths, 18 ms
    break_hat_off.wav the off-grid sixteenths, 42 ms so they read as more open, kept
                      separate so
                      swing can delay them
    break_sub.wav     the fundamental: a clean sine layer, band limited, left unfiltered
                      in TouchDesigner so the low end never disappears
    break_reese.wav   the growl: three detuned band-limited saws beating against each
                      other, a Reese bass, which is what the low-pass, wobble and drive act on

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
# The bass gets a longer phrase than the drums. 4 is an exact multiple of 2, so it
# loops once per two drum loops and nothing drifts out of phase.
BASS_BARS = 4
# Derived from N by multiplication, not rounded independently: rounding both separately gave
# 249035 against 2 x 124518 = 249036, one sample short, which drifts a little every loop.
assert BASS_BARS % BARS == 0, 'the bass phrase must be a whole number of drum loops'
N_BASS = N * (BASS_BARS // BARS)

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, 'audio')

# Sixteenth grid, two bars. 'X' a full hit, 'o' a ghost/quieter hit.
KICK  = 'X.........X.....' '..X.......X.....'
SNARE = '....X.......X..o' '....X..o....X...'
# The hat is split so swing has something to delay: the on-grid eighths stay put and the
# off-grid sixteenths are pushed late by the Delay CHOP. That is what swing physically is.
HAT_ON  = 'X...X...X...X...' 'X...X...X...X...'
HAT_OFF = '..o...o...o...o.' '..o...o...o...o.'
# A four-note riff over the two bars, as (sixteenth step, Hz, seconds). A1, A1, C2, G1:
# The notes are long enough to ring into each other rather than restating: a bass that
# sustains under the break, not one that keeps re-announcing itself.
BASS_NOTES = (
    (0,  55.00, 0.95),   # A1  root
    (10, 55.00, 0.70),   # A1
    (18, 65.41, 0.95),   # C2  minor third
    (26, 48.99, 0.80),   # G1  seventh
    (32, 55.00, 0.95),   # A1  back to the root
    (42, 55.00, 0.70),   # A1
    (50, 43.65, 0.85),   # F1  the lowest note in the phrase
    (58, 41.20, 0.62),   # E1  the dominant: this is what pulls back to A1
)


def env(n, attack, decay):
    """Short attack, exponential decay, as a list of gains."""
    a = max(1, int(attack * SR))
    out = []
    for i in range(n):
        g = i / a if i < a else math.exp(-(i - a) / (decay * SR))
        out.append(g)
    return out


def kick(i=0, dur=0.28):
    n = int(dur * SR)
    e = env(n, 0.001, 0.055)
    ph = 0.0
    out = []
    for i in range(n):
        f = 45.0 + 75.0 * math.exp(-i / (0.025 * SR))      # 120 Hz -> 45 Hz
        ph += 2 * math.pi * f / SR
        out.append(math.sin(ph) * e[i])
    return out


def snare(i=0, dur=0.20):
    r = random.Random(300 + i * 29)
    n = int(dur * SR)
    e = env(n, 0.0005, 0.035 * (0.92 + 0.16 * r.random()))
    ph = 0.0
    lp = 0.0
    out = []
    for i in range(n):
        noise = r.uniform(-1.0, 1.0)
        lp += 0.55 * (noise - lp)                          # tame the very top
        ph += 2 * math.pi * 185.0 / SR
        out.append((0.75 * lp + 0.45 * math.sin(ph)) * e[i])
    return out


def hat(i=0, openness=0.0):
    """A quick resonating accent: inharmonic metal that rings and dies, not a noise smack.

    Almost all of the sound is the partial cluster. The noise is only a 2 ms transient to give
    the stick contact; letting it run for the whole note is what made the old one sound like
    something being slapped. The partials are deliberately not integer multiples -- that is
    what reads as metal rather than as a pitch.
    """
    r = random.Random(900 + i * 37)
    dur = 0.018 + openness * 0.024
    n = int(dur * SR)
    ring = env(n, 0.0002, 0.004 + openness * 0.012)
    click = env(n, 0.0001, 0.0018)                  # the stick, 2 ms and gone
    partials = ((9150.0, 1.0), (10730.0, 0.86), (12410.0, 0.70),
                (13980.0, 0.55), (15360.0, 0.38))
    jitter = 1.0 + 0.035 * (r.random() - 0.5)
    ahp = 1.0 - math.exp(-2 * math.pi * 7000.0 / SR)
    hp1 = hp2 = 0.0
    out = []
    for k in range(n):
        noise = r.uniform(-1.0, 1.0)
        hp1 += ahp * (noise - hp1)
        h1 = noise - hp1
        hp2 += ahp * (h1 - hp2)
        t = k / SR
        metal = sum(a * math.sin(2 * math.pi * f * jitter * t) for f, a in partials)
        out.append(0.85 * (metal / len(partials)) * ring[k] + 0.22 * (h1 - hp2) * click[k])
    return out


def _harmonics(f):
    """How many harmonics fit under 4.5 kHz -- band limited, so no aliasing fold-down."""
    return max(1, int(4500.0 / f))


def sub_note(f, dur):
    """The fundamental. A sine, plus a little second harmonic so it survives small speakers,
    and a short pitch drop at the top for weight. Deliberately no higher content."""
    n = int(dur * SR)
    e = env(n, 0.006, dur * 0.78)
    out = []
    ph = 0.0
    for i in range(n):
        drop = 1.0 + 0.18 * math.exp(-i / (0.035 * SR))     # a brief downward glide
        ph += 2 * math.pi * f * drop / SR
        out.append((math.sin(ph) + 0.18 * math.sin(2 * ph)) * e[i])
    return out


def reese_note(f, dur, detune=0.010):
    """The growl: three band-limited saws, two of them detuned, beating against each other.
    Built additively so there is nothing above 4.5 kHz to alias."""
    n = int(dur * SR)
    e = env(n, 0.010, dur * 0.88)
    freqs = (f, f * (1.0 + detune), f * (1.0 - detune * 1.7))
    out = [0.0] * n
    for fi in freqs:
        k = _harmonics(fi)
        for h in range(1, k + 1):
            w = 2 * math.pi * fi * h / SR
            amp = 1.0 / (h ** 0.65)                         # flatter than a saw: bite
            for i in range(n):
                out[i] += math.sin(w * i) * amp
    g = 1.0 / (len(freqs) * 2.2)
    return [v * g * e[i] for i, v in enumerate(out)]


def lowpass(x, hz, poles=2):
    a = 1.0 - math.exp(-2 * math.pi * hz / SR)
    for _ in range(poles):
        y = 0.0
        out = []
        for v in x:
            y += a * (v - y)
            out.append(y)
        x = out
    return x


def highpass(x, hz, poles=2):
    a = 1.0 - math.exp(-2 * math.pi * hz / SR)
    for _ in range(poles):
        y = 0.0
        out = []
        for v in x:
            y += a * (v - y)
            out.append(v - y)
        x = out
    return x


def render_notes(notes, voice, **kw):
    """Place pitched notes on the sixteenth grid, wrapping at the end of the bass phrase."""
    buf = [0.0] * N_BASS
    cache = {}
    for step, f, dur in notes:
        key = (f, dur)
        if key not in cache:
            cache[key] = voice(f, dur, **kw)
        hit = cache[key]
        start = int(round(step * STEP_S * SR))
        for i, v in enumerate(hit):
            j = start + i
            buf[j if j < N_BASS else j - N_BASS] += v
    return buf


def render(pattern, voice, gain_full=1.0, gain_ghost=0.45, ghost_open=0.0):
    buf = [0.0] * N
    hit_i = 0
    for step, ch in enumerate(pattern):
        if ch == '.':
            continue
        g = gain_full if ch == 'X' else gain_ghost
        start = int(round(step * STEP_S * SR))
        hit_i += 1
        try:                                   # hats take an openness, kick and snare do not
            hit = voice(hit_i, openness=(ghost_open if ch == 'o' else 0.0))
        except TypeError:
            hit = voice(hit_i)
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
    print('  %-20s %5.3f s  %6.1f kB  peak %.2f'
          % (name, len(buf) / SR, os.path.getsize(path) / 1024.0, hi * scale))


print('%g BPM, drums %d bars (%.3f s), bass %d bars (%.3f s), %d Hz'
      % (BPM, BARS, LOOP_S, BASS_BARS, N_BASS / SR, SR))
write_wav('break_kick.wav', render(KICK, kick))
write_wav('break_snare.wav', render(SNARE, snare))
write_wav('break_hat_on.wav', render(HAT_ON, hat, gain_full=0.85))
write_wav('break_hat_off.wav', render(HAT_OFF, hat, gain_full=0.5, gain_ghost=0.42,
                                         ghost_open=0.7))
# Band split: the sub keeps only the fundamental, the Reese only what sits above it.
write_wav('break_sub.wav', lowpass(render_notes(BASS_NOTES, sub_note), 110.0))
write_wav('break_reese.wav', highpass(render_notes(BASS_NOTES, reese_note), 95.0))
print('the four drums share one length and the two bass layers share another,')
print('and the bass phrase is an exact multiple of the drum loop, so nothing drifts')
