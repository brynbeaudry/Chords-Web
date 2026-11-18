"""Check that SpectralAlphaDetector.ts reproduces chords_dsp.SpectralAlpha hop for hop.

    python verify_ts.py        # needs node >= 22.18 (built-in TypeScript type stripping)
"""
import sys, os, json, subprocess, tempfile
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from chords_dsp import *
from data import *

HERE = os.path.dirname(os.path.abspath(__file__))
P = json.load(open(os.path.join(HERE, 'results.json')))['chosen']
params = dict(onDb=P['on_db'], offDb=P['off_db'], nOn=P['n_on'], nOff=P['n_off'], win=P['win'], maxHoldHops=24)
report = {}
for s, ch, rail in ((3, 'Oz', False), (11, 'O1', False), (6, 'Fp1', False), (3, 'Oz', True)):
    x, ec, eo = load(s)
    c = to_device_counts(x[:, CHANNELS.index(ch)], np.random.default_rng(s))
    if rail:   # electrode detached during eyes closed: output pinned at the ADC rail for 10 s
        a = int((ec[1] + 3) * FS)
        c[a:a + 10 * FS] = 4095
    hp = app_highpass(c)
    py = SpectralAlpha(win=P['win'], on_db=P['on_db'], off_db=P['off_db'], n_on=P['n_on'], n_off=P['n_off']).run(hp, c)
    with tempfile.NamedTemporaryFile(suffix='.bin', delete=False) as f:
        f.write(np.asarray(hp, '<f8').tobytes() + np.asarray(c, '<f8').tobytes())
    r = subprocess.run(['node', os.path.join(HERE, 'verify_runner.ts'), f.name, json.dumps(params)],
                       capture_output=True, text=True, check=True)
    os.unlink(f.name)
    ts = json.loads(r.stdout)
    o = np.array(ts['out'])
    n = min(len(o), len(py['prom']))
    rep = dict(hops=n, hops_py=len(py['prom']),
               max_prom_diff_db=float(np.max(np.abs(o[:n, 0] - py['prom'][:n]))),
               iaf_agree=float(np.mean(o[:n, 1] == py['iaf'][:n])),
               art_agree=float(np.mean(o[:n, 2] == py['art'][:n])),
               state_agree=float(np.mean(o[:n, 3] == py['state'][:n])),
               ms_per_s=ts['msPerSecondOfSignal'])
    if rail:
        t = py['t'][:n]; st = py['state'][:n]
        on_before = bool(st[(t > ec[1] + 2) & (t < ec[1] + 3)].all())
        off_at = t[(t > ec[1] + 3) & ~st]
        rep['rail_on_before'] = on_before
        rep['rail_forced_off_after_s'] = float(off_at[0] - (ec[1] + 3)) if len(off_at) else None
    report[f's{s}_{ch}' + ('_rail' if rail else '')] = rep
    print(s, ch, rep)
json.dump(report, open(os.path.join(HERE, 'verify_ts.json'), 'w'), indent=1)
