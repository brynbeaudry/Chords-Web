"""Optional personal threshold from a short eyes-closed / eyes-open check.

The first eyes-closed and first eyes-open block (about 20 s) set enter = midpoint of the two
median prominences, floored at FLOOR dB; exit = enter - 3 dB. Scored on the remaining blocks only.

    python personal.py          # writes personal.json
"""
import sys, os, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chords_dsp import hysteresis, FS
from data import subjects

HERE = os.path.dirname(os.path.abspath(__file__))
P = json.load(open(os.path.join(HERE, 'results.json')))['chosen']
W = P['win']
nulls = [dict(np.load(os.path.join(HERE, 'cache', f'null{k}_e{e}_m0.npz'))) for k in range(4) for e in (1.0, 1.5, 2.0)]
out = {}
for floor in (3.5, 4.0, 4.5):
    rows = dict(fixed_ec=[], fixed_eo=[], pers_ec=[], pers_eo=[], on=[])
    for s in subjects():
        for ch in ('O1', 'Oz', 'O2'):
            d = dict(np.load(os.path.join(HERE, 'cache', f's{s:02d}_{ch}_m0.npz')))
            t, p, a = d[f'w{W}_t'], d[f'w{W}_prom'], d[f'w{W}_art']
            y = d['y'][np.clip((t * FS).astype(int) - 1, 0, len(d['y']) - 1)]
            cal_end = max(d['ec'][0], d['eo'][0]) + 10
            cal, rest = t < cal_end, t >= cal_end + 2
            m_ec = np.median(p[cal & (y == 1)]); m_eo = np.median(p[cal & (y == -1)])
            on = max(floor, 0.5 * (m_ec + m_eo))
            for kind, (o, f) in (('fixed', (P['on_db'], P['off_db'])), ('pers', (on, on - 3))):
                st = hysteresis(p, a, o, f, P['n_on'], P['n_off'])
                rows[f'{kind}_ec'].append(st[rest & (y == 1)].mean())
                rows[f'{kind}_eo'].append(st[rest & (y == -1)].mean())
            rows['on'].append(on)
    fa = np.mean([hysteresis(n[f'w{W}_prom'], n[f'w{W}_art'], floor, floor - 3, P['n_on'], P['n_off']).mean() for n in nulls])
    out[str(floor)] = {k: dict(mean=float(np.mean(v)), p10=float(np.percentile(v, 10))) for k, v in rows.items()}
    out[str(floor)]['null_at_floor'] = float(fa)
    print(floor, {k: (round(v['mean'], 3), round(v['p10'], 3)) if isinstance(v, dict) else round(v, 4) for k, v in out[str(floor)].items()})
json.dump(out, open(os.path.join(HERE, 'personal.json'), 'w'), indent=1)
