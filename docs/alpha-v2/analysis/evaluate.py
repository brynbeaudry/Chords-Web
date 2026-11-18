"""Evaluate current and proposed alpha detectors on the open eyes-closed / eyes-open dataset.

    python evaluate.py            # writes results.json and cache/*.npz next to this file

Protocol
  * Each subject's recording is resampled to 500 Hz and converted to NPG Lite counts with the
    device model in chords_dsp.to_device_counts (gain x1470, 12-bit, 3 counts rms ADC noise).
  * Truth: eyes-closed blocks = alpha expected, eyes-open blocks = alpha suppressed, first 1 s
    after each instruction excluded. Eyes-open alpha is reduced, not absent, so the eyes-open
    flag rate is an upper bound on false alarms; the true null is the noise-only test.
  * Parameters for the proposed detector are tuned on even-numbered subjects only and reported
    on odd-numbered subjects (held out).
"""
import sys, os, json, itertools
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from chords_dsp import *
from data import *

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
os.makedirs(CACHE, exist_ok=True)
OCC = ['O1', 'Oz', 'O2']
ALL_CH = ['O1', 'Oz', 'O2', 'Pz', 'Cz', 'Fz', 'Fp1']
WINS = [1000, 1500, 2000]


def auc(pos, neg):
    """Probability a random eyes-closed hop scores above a random eyes-open hop."""
    pos, neg = np.asarray(pos), np.asarray(neg)
    allv = np.concatenate([pos, neg])
    ranks = allv.argsort().argsort() + 1
    rp = ranks[:len(pos)].sum()
    return (rp - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def features_for(s, ch, mains_uv=0.0):
    key = os.path.join(CACHE, f's{s:02d}_{ch}_m{int(mains_uv)}.npz')
    if os.path.exists(key):
        return dict(np.load(key))
    x, ec, eo = load(s)
    n = len(x)
    y = block_labels(n, ec, eo)
    c = to_device_counts(x[:, CHANNELS.index(ch)], np.random.default_rng(s), mains_uv=mains_uv)
    hp = app_highpass(c)
    out = dict(y=y, ec=ec, eo=eo)
    for w in WINS:
        d = SpectralAlpha(win=w).features(hp, c)
        for k, v in d.items():
            out[f'w{w}_{k}'] = v
    lg, ra = legacy_ratio(hp)
    rl, rh = harness_rhythm(hp)
    out.update(legacy_label=lg, legacy_ra=ra, legacy_isalpha=stage_c(lg),
               rhythm_label=rl, rhythm=rh, rhythm_isalpha=stage_c(rl),
               env_prom=envelope_prom(hp))
    np.savez_compressed(key, **out)
    return out


def null_features(k, exponent, mains_uv=0.0, amp_uv=15.0, dur_s=120):
    key = os.path.join(CACHE, f'null{k}_e{exponent}_m{int(mains_uv)}.npz')
    if os.path.exists(key):
        return dict(np.load(key))
    rng = np.random.default_rng(1000 + k)
    uv = amp_uv * pink_noise(FS * dur_s, rng, exponent=exponent)
    c = to_device_counts(uv, rng, mains_uv=mains_uv)
    hp = app_highpass(c)
    out = {}
    for w in WINS:
        d = SpectralAlpha(win=w).features(hp, c)
        for kk, v in d.items():
            out[f'w{w}_{kk}'] = v
    lg, _ = legacy_ratio(hp)
    rl, _ = harness_rhythm(hp)
    out.update(legacy_isalpha=stage_c(lg), rhythm_isalpha=stage_c(rl))
    np.savez_compressed(key, **out)
    return out


def hop_truth(d, w):
    t = d[f'w{w}_t']
    return d['y'][np.clip((t * FS).astype(int) - 1, 0, len(d['y']) - 1)]


def score(state, yy):
    return state[yy == 1].mean(), state[yy == -1].mean()


def latencies(d, w, state):
    """Seconds from instruction to the flag turning on (eyes closed) / off (eyes open)."""
    t = d[f'w{w}_t']
    on, off = [], []
    for o in d['ec']:
        k = np.where((t >= o) & (t < o + 10) & state)[0]
        on.append(t[k[0]] - o if len(k) else np.nan)
    for o in d['eo']:
        k = np.where((t >= o) & (t < o + 10) & ~state)[0]
        off.append(t[k[0]] - o if len(k) else np.nan)
    return on, off


def main():
    subs = subjects()
    train = [s for s in subs if s % 2 == 0]
    test = [s for s in subs if s % 2 == 1]
    print('subjects', subs)
    feats = {(s, ch): features_for(s, ch) for s in subs for ch in ALL_CH}
    feats_m = {(s, ch): features_for(s, ch, mains_uv=50.0) for s in subs for ch in OCC}
    nulls = [null_features(k, e) for k in range(4) for e in (1.0, 1.5, 2.0)]
    nulls_m = [null_features(k, 1.5, mains_uv=m) for k in range(2) for m in (50.0, 200.0)]

    # ── grid search on training subjects, occipital channels ───────────────────
    grid = list(itertools.product(WINS, [3.0, 3.5, 4.0, 4.5, 5.0], [1.5, 2.0, 2.5, 3.0], [2, 3, 4], [3, 5, 8]))
    best = None
    rows = []
    for w, on, off, n_on, n_off in grid:
        if off >= on:
            continue
        null_fa = np.mean([hysteresis(nd[f'w{w}_prom'], nd[f'w{w}_art'], on, off, n_on, n_off).mean() for nd in nulls])
        tp, fp = [], []
        for s in train:
            for ch in OCC:
                d = feats[(s, ch)]
                st = hysteresis(d[f'w{w}_prom'], d[f'w{w}_art'], on, off, n_on, n_off)
                a, b = score(st, hop_truth(d, w))
                tp.append(a); fp.append(b)
        bal = 0.5 * (np.mean(tp) + 1 - np.mean(fp))
        rows.append((w, on, off, n_on, n_off, null_fa, np.mean(tp), np.mean(fp), bal))
        if null_fa <= 0.01 and (best is None or bal > best[-1]):
            best = rows[-1]
    w, on, off, n_on, n_off = best[:5]
    print('chosen', best)

    # ── held-out evaluation ────────────────────────────────────────────────────
    def evaluate(subset, chans, fset, kind):
        tp, fp, lat_on, lat_off, per = [], [], [], [], {}
        for s in subset:
            for ch in chans:
                d = fset[(s, ch)]
                if kind == 'proposed':
                    st = hysteresis(d[f'w{w}_prom'], d[f'w{w}_art'], on, off, n_on, n_off)
                    yy = hop_truth(d, w)
                    lo, lf = latencies(d, w, st)
                    lat_on += lo; lat_off += lf
                else:
                    st = d[f'{kind}_isalpha']
                    yy = d['y']
                a, b = score(st, yy)
                tp.append(a); fp.append(b)
                per[f'{s}_{ch}'] = (a, b)
        return dict(ec_flag=float(np.mean(tp)), eo_flag=float(np.mean(fp)),
                    ec_flag_min=float(np.min(tp)),
                    lat_on_med=float(np.nanmedian(lat_on)) if lat_on else None,
                    lat_off_med=float(np.nanmedian(lat_off)) if lat_off else None,
                    missed_blocks=float(np.mean(np.isnan(lat_on))) if lat_on else None,
                    per=per)

    res = dict(chosen=dict(win=w, on_db=on, off_db=off, n_on=n_on, n_off=n_off,
                           null_fa=best[5], train_ec=best[6], train_eo=best[7]))
    for kind in ('legacy', 'rhythm', 'proposed'):
        res[f'{kind}_test_occ'] = evaluate(test, OCC, feats, kind)
        res[f'{kind}_test_occ_mains50'] = evaluate(test, OCC, feats_m, kind)
        res[f'{kind}_all_occ'] = evaluate(subs, OCC, feats, kind)
        for ch in ('Pz', 'Cz', 'Fz', 'Fp1'):
            res[f'{kind}_all_{ch}'] = evaluate(subs, [ch], feats, kind)
    # noise-only false alarm for each detector
    res['null'] = dict(
        legacy=float(np.mean([nd['legacy_isalpha'][FS * 5:].mean() for nd in nulls])),
        rhythm=float(np.mean([nd['rhythm_isalpha'][FS * 5:].mean() for nd in nulls])),
        proposed=float(np.mean([hysteresis(nd[f'w{w}_prom'], nd[f'w{w}_art'], on, off, n_on, n_off).mean() for nd in nulls])))
    res['null_mains'] = {}
    for m, nd in zip([50, 200, 50, 200], nulls_m):
        r = res['null_mains'].setdefault(str(m), dict(legacy=[], rhythm=[], proposed=[]))
        r['legacy'].append(float(nd['legacy_isalpha'][FS * 5:].mean()))
        r['rhythm'].append(float(nd['rhythm_isalpha'][FS * 5:].mean()))
        r['proposed'].append(float(hysteresis(nd[f'w{w}_prom'], nd[f'w{w}_art'], on, off, n_on, n_off).mean()))
    # threshold-free separation (AUC) per subject, occipital, all subjects
    aucs = dict(legacy=[], rhythm=[], envelope=[], proposed=[])
    for s in subs:
        for ch in OCC:
            d = feats[(s, ch)]
            y = d['y']
            sl = slice(None, None, 25)
            aucs['legacy'].append(auc(d['legacy_ra'][sl][y[sl] == 1], d['legacy_ra'][sl][y[sl] == -1]))
            aucs['rhythm'].append(auc(d['rhythm'][sl][y[sl] == 1], d['rhythm'][sl][y[sl] == -1]))
            aucs['envelope'].append(auc(d['env_prom'][sl][y[sl] == 1], d['env_prom'][sl][y[sl] == -1]))
            yy = hop_truth(d, w)
            aucs['proposed'].append(auc(d[f'w{w}_prom'][yy == 1], d[f'w{w}_prom'][yy == -1]))
    res['auc'] = {k: dict(median=float(np.median(v)), q25=float(np.percentile(v, 25)),
                          q75=float(np.percentile(v, 75)), min=float(np.min(v))) for k, v in aucs.items()}
    # IAF per subject (eyes closed, Oz)
    res['iaf'] = {str(s): float(np.median(feats[(s, 'Oz')][f'w{w}_iaf'][hop_truth(feats[(s, 'Oz')], w) == 1])) for s in subs}
    res['grid_top'] = sorted([r for r in rows if r[5] <= 0.01], key=lambda r: -r[-1])[:10]
    with open(os.path.join(HERE, 'results.json'), 'w') as f:
        json.dump(res, f, indent=1, default=float)
    for k, v in res.items():
        if isinstance(v, dict) and 'per' in v:
            print(k, {kk: (round(vv, 3) if isinstance(vv, float) else vv) for kk, vv in v.items() if kk != 'per'})
    print('null', res['null']); print('null_mains', res['null_mains']); print('auc', res['auc']); print('iaf', res['iaf'])


if __name__ == '__main__':
    main()
