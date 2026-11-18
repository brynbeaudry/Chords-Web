"""Robustness of the proposed detector, plus the measurements the dataset's markers cannot give.

    python robustness.py        # needs results.json; writes robustness.json

1. Operating characteristic: eyes-closed hit rate, eyes-open flag rate and pure-noise false-alarm
   rate across enter thresholds, for 2 s and 4 s windows.
2. Device-model sensitivity: ADC noise, mains pickup and the x882 gain setting.
3. Response time: the dataset's block markers are placed after the participant has already
   changed state, so latency is measured on splices: 8 s eyes-open | 8 s eyes-closed | 8 s
   eyes-open, cut from the same person's recording at known times.
"""
import sys, os, json
import numpy as np
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chords_dsp as dsp
from chords_dsp import *
from data import *

HERE = os.path.dirname(os.path.abspath(__file__))
P = json.load(open(os.path.join(HERE, 'results.json')))['chosen']
OCC = ['O1', 'Oz', 'O2']


def hop_truth(t, y):
    return y[np.clip((t * FS).astype(int) - 1, 0, len(y) - 1)]


def cached(s, ch):
    return dict(np.load(os.path.join(HERE, 'cache', f's{s:02d}_{ch}_m0.npz')))


def nulls():
    return [dict(np.load(os.path.join(HERE, 'cache', f'null{k}_e{e}_m0.npz'))) for k in range(4) for e in (1.0, 1.5, 2.0)]


def operating_curve():
    out = {}
    nl = nulls()
    for w in (1000, 2000):
        rows = []
        for on in np.arange(2.0, 8.01, 0.5):
            off = on - 3.0
            ec, eo, low = [], [], []
            for s in subjects():
                for ch in OCC:
                    d = cached(s, ch)
                    st = hysteresis(d[f'w{w}_prom'], d[f'w{w}_art'], on, off, P['n_on'], P['n_off'])
                    yy = hop_truth(d[f'w{w}_t'], d['y'])
                    ec.append(st[yy == 1].mean()); eo.append(st[yy == -1].mean())
            fa = np.mean([hysteresis(n[f'w{w}_prom'], n[f'w{w}_art'], on, off, P['n_on'], P['n_off']).mean() for n in nl])
            rows.append(dict(on=float(on), off=float(off), ec=float(np.mean(ec)), eo=float(np.mean(eo)),
                             ec_p10=float(np.percentile(ec, 10)), null=float(fa)))
        out[str(w)] = rows
    return out


def run_variant(args):
    s, ch, noise, mains, gain = args
    old = dsp.UV_PER_COUNT
    dsp.UV_PER_COUNT = VREF / 4095 / gain * 1e6
    x, ec, eo = load(s)
    y = block_labels(len(x), ec, eo)
    c = dsp.to_device_counts(x[:, CHANNELS.index(ch)], np.random.default_rng(s), adc_noise_counts=noise, mains_uv=mains)
    dsp.UV_PER_COUNT = old
    hp = app_highpass(c)
    d = SpectralAlpha(win=P['win'], on_db=P['on_db'], off_db=P['off_db'], n_on=P['n_on'], n_off=P['n_off']).run(hp, c)
    yy = hop_truth(d['t'], y)
    return (noise, mains, gain), d['state'][yy == 1].mean(), d['state'][yy == -1].mean()


def splice_job(args):
    s, ch = args
    x, ec, eo = load(s)
    u = x[:, CHANNELS.index(ch)]
    seg = lambda o: u[int((o + 1.5) * FS):int((o + 9.5) * FS)]
    a, b, c_ = seg(eo[0]), seg(ec[1]), seg(eo[1])
    fade = np.linspace(0, 1, 25)

    def join(p, q):
        p, q = p.copy(), q.copy()
        p[-25:] = p[-25:] * (1 - fade) + q[:25] * fade
        return np.concatenate([p, q[25:]])
    sig = join(join(a, b), c_)
    t_on = len(a) / FS - 25 / FS / 2
    t_off = t_on + (len(b) - 25) / FS
    cnt = to_device_counts(sig, np.random.default_rng(s))
    hp = app_highpass(cnt)
    res = {}
    d = SpectralAlpha(win=P['win'], on_db=P['on_db'], off_db=P['off_db'], n_on=P['n_on'], n_off=P['n_off']).run(hp, cnt)
    res['proposed'] = (d['t'], d['state'])
    ts = np.arange(len(hp)) / FS
    lg, _ = legacy_ratio(hp)
    res['legacy'] = (ts, stage_c(lg))
    rl, _ = harness_rhythm(hp)
    res['rhythm'] = (ts, stage_c(rl))
    lat = {}
    for k, (t, st) in res.items():
        before = st[(t > t_on - 3) & (t < t_on)].mean()
        on = np.where((t >= t_on) & (t < t_off) & st)[0]
        off = np.where((t >= t_off) & ~st)[0]
        lat[k] = dict(on=float(t[on[0]] - t_on) if len(on) and before < 0.5 else None,
                      off=float(t[off[0]] - t_off) if len(off) and st[(t > t_off - 2) & (t < t_off)].mean() > 0.5 else None)
    return s, ch, lat


if __name__ == '__main__':
    out = dict(operating=operating_curve())
    variants = [(3, 0, 1470), (6, 0, 1470), (12, 0, 1470), (3, 50, 1470), (3, 200, 1470), (3, 0, 882), (12, 200, 882)]
    test = [s for s in subjects() if s % 2 == 1]
    jobs = [(s, ch) + v for v in variants for s in test for ch in OCC]
    with Pool(7) as p:
        r = p.map(run_variant, jobs)
        lat = p.map(splice_job, [(s, ch) for s in subjects() for ch in OCC])
    agg = {}
    for key, a, b in r:
        agg.setdefault(str(key), []).append((a, b))
    out['variants'] = {k: dict(ec=float(np.mean([v[0] for v in vals])), eo=float(np.mean([v[1] for v in vals])))
                       for k, vals in agg.items()}
    L = {}
    for s, ch, l in lat:
        for k, v in l.items():
            L.setdefault(k, dict(on=[], off=[]))
            if v['on'] is not None: L[k]['on'].append(v['on'])
            if v['off'] is not None: L[k]['off'].append(v['off'])
    out['latency'] = {k: dict(on_med=float(np.median(v['on'])), on_p90=float(np.percentile(v['on'], 90)), n_on=len(v['on']),
                              off_med=float(np.median(v['off'])), off_p90=float(np.percentile(v['off'], 90)), n_off=len(v['off']),
                              on_all=v['on'], off_all=v['off'])
                      for k, v in L.items()}
    json.dump(out, open(os.path.join(HERE, 'robustness.json'), 'w'), indent=1)
    for w, rows in out['operating'].items():
        print('win', w)
        for r_ in rows:
            print('  on %.1f off %.1f  EC %.2f (p10 %.2f)  EO %.2f  null %.4f' % (r_['on'], r_['off'], r_['ec'], r_['ec_p10'], r_['eo'], r_['null']))
    print(json.dumps(out['variants'], indent=1))
    for k, v in out['latency'].items():
        print(k, {kk: vv for kk, vv in v.items() if not kk.endswith('_all')})
