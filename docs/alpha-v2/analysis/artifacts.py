"""Artifact stress test: blinks, jaw clenches and electrode pops injected into every block.

    python artifacts.py        # writes artifacts.json

For each subject (Oz): every block gets a blink every 2.5 s (90 uV raised-cosine, 0.35 s),
one 1 s jaw clench (20-120 Hz EMG, ~25 uV rms) and one electrode pop (400 uV decaying step).
These amplitudes are deliberately large for an occipital electrode: it is a stress test.
Reported: % of eyes-closed time detected and % of eyes-open time flagged, with and without
artifacts, for each detector.
"""
import sys, os, json
import numpy as np
from multiprocessing import Pool
from scipy.signal import butter, lfilter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chords_dsp import *
from data import *

HERE = os.path.dirname(os.path.abspath(__file__))
P = json.load(open(os.path.join(HERE, 'results.json')))['chosen']


def artifacts(n, onsets, rng):
    a = np.zeros(n)
    b, aa = butter(4, [20, 120], 'band', fs=FS)
    bl = blink(amp_uv=90.0)
    for o in onsets:
        for dt in np.arange(1.5, 10, 2.5):
            i = int((o + dt) * FS); a[i:i + len(bl)] += bl[:max(0, min(len(bl), n - i))]
        i = int((o + 4.2) * FS)
        a[i:i + FS] += 25 * lfilter(b, aa, rng.normal(size=FS)) / 0.35
        i = int((o + 7.3) * FS)
        a[i:i + 40] += np.linspace(400, 0, 40)
    return a


def job(s, ch='Oz'):
    x, ec, eo = load(s)
    n = len(x)
    y = block_labels(n, ec, eo)
    out = {}
    for tag in ('clean', 'artifacts'):
        uv = x[:, CHANNELS.index(ch)].copy()
        if tag == 'artifacts':
            uv += artifacts(n, np.concatenate([ec, eo]), np.random.default_rng(s + 99))
        c = to_device_counts(uv, np.random.default_rng(s))
        hp = app_highpass(c)
        d = SpectralAlpha(win=P['win'], on_db=P['on_db'], off_db=P['off_db'], n_on=P['n_on'], n_off=P['n_off']).run(hp, c)
        yy = y[np.clip((d['t'] * FS).astype(int) - 1, 0, n - 1)]
        out[f'proposed_{tag}'] = (d['state'][yy == 1].mean(), d['state'][yy == -1].mean(), d['art'][yy != 0].mean())
        lg, _ = legacy_ratio(hp); sl = stage_c(lg)
        rl, _ = harness_rhythm(hp); sr = stage_c(rl)
        out[f'legacy_{tag}'] = (sl[y == 1].mean(), sl[y == -1].mean(), 0.0)
        out[f'rhythm_{tag}'] = (sr[y == 1].mean(), sr[y == -1].mean(), 0.0)
    return out


if __name__ == '__main__':
    with Pool(7) as p:
        res = p.map(job, subjects())
    agg = {}
    for r in res:
        for k, v in r.items():
            agg.setdefault(k, []).append(v)
    out = {k: dict(ec=float(np.mean([a[0] for a in v])), eo=float(np.mean([a[1] for a in v])),
                   gated=float(np.mean([a[2] for a in v]))) for k, v in agg.items()}
    json.dump(out, open(os.path.join(HERE, 'artifacts.json'), 'w'), indent=1)
    for k, v in out.items():
        print(f'{k:22s} EC {v["ec"]:.2f}  EO {v["eo"]:.2f}  gated {v["gated"]:.2f}')
