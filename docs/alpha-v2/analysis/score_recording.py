"""Score a dual-stream recording exported from the app with the proposed alpha detector.

    python score_recording.py recording.csv [--on 5 --off 2] [--marks marks.csv]

Input: the replay-ready CSV written by workers/indexedDBWorker.ts convertToCSV
(optional "# meta: {...}" line, then Slot,tWallMs,tStreamMs,Counter,Raw0..2,Filtered0..2).
Raw counts are re-run through the app's own 1 Hz highpass, exactly as ingestSample does.

Output, next to the input:
  <name>_alpha.csv   one row per device, channel and 128 ms hop: t, prominence, peak Hz, artifact, is_alpha
  <name>_alpha.png   prominence and is_alpha for every channel of both devices
`--marks` takes a CSV of clinician marks (columns: slot,channel,start_s,end_s) and reports how
much of the marked time was flagged, and how much unmarked time was flagged.

    python score_recording.py --selftest     # builds a synthetic recording in the same format and scores it
"""
import sys, os, json, argparse, csv
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chords_dsp import FS, SpectralAlpha, app_highpass, to_device_counts


def read_recording(path):
    meta = None
    with open(path) as f:
        first = f.readline()
        if first.startswith('# meta:'):
            meta = json.loads(first[len('# meta:'):])
        else:
            f.seek(0)
        rows = list(csv.DictReader(f))
    devices = {}
    for slot in (1, 2):
        r = [x for x in rows if int(float(x['Slot'])) == slot]
        if not r:
            continue
        t = np.array([float(x['tWallMs']) for x in r]) / 1000.0
        raw = np.array([[float(x[f'Raw{c}']) for c in range(3)] for x in r])
        devices[slot] = (t - t[0], raw)
    return devices, meta


def score(devices, on_db, off_db, fs=FS):
    out = {}
    for slot, (t, raw) in devices.items():
        for ch in range(raw.shape[1]):
            hp = app_highpass(raw[:, ch])
            d = SpectralAlpha(win=1000, on_db=on_db, off_db=off_db, n_on=2, n_off=3).run(hp, raw[:, ch])
            out[(slot, ch)] = d
    return out


def write_outputs(path, res):
    base = os.path.splitext(path)[0]
    with open(base + '_alpha.csv', 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['slot', 'channel', 't_s', 'prominence_db', 'peak_hz', 'artifact', 'is_alpha'])
        for (slot, ch), d in res.items():
            for k in range(len(d['t'])):
                w.writerow([slot, ch, f"{d['t'][k]:.3f}", f"{d['prom'][k]:.2f}", f"{d['iaf'][k]:.0f}",
                            int(d['art'][k]), int(d['state'][k])])
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    keys = sorted(res)
    fig, axs = plt.subplots(len(keys), 1, figsize=(10, 1.6 * len(keys)), sharex=True, squeeze=False)
    for ax, key in zip(axs[:, 0], keys):
        d = res[key]
        ax.plot(d['t'], d['prom'], color='#111827', lw=0.8)
        ax.fill_between(d['t'], -5, -5 + 3 * d['state'], step='post', color='#16a34a', alpha=0.8, lw=0)
        ax.fill_between(d['t'], -5, 20, where=d['art'], step='pre', color='#f59e0b', alpha=0.2, lw=0)
        ax.axhline(5, color='#16a34a', ls='--', lw=0.8)
        ax.set_ylim(-5, 20)
        ax.set_ylabel(f'D{key[0]} ch{key[1]}\ndB', fontsize=8)
    axs[-1, 0].set_xlabel('seconds')
    fig.tight_layout()
    fig.savefig(base + '_alpha.png', dpi=120)
    return base + '_alpha.csv', base + '_alpha.png'


def compare_marks(res, marks_path):
    marks = list(csv.DictReader(open(marks_path)))
    rep = {}
    for (slot, ch), d in res.items():
        m = np.zeros(len(d['t']), bool)
        for r in marks:
            if int(r['slot']) == slot and int(r['channel']) == ch:
                m |= (d['t'] >= float(r['start_s'])) & (d['t'] < float(r['end_s']))
        if m.any():
            rep[f'D{slot} ch{ch}'] = dict(marked_flagged=float(d['state'][m].mean()),
                                         unmarked_flagged=float(d['state'][~m].mean()))
    return rep


def selftest():
    """Write subjects 3 and 19 (Oz, O1, O2) as a two-device recording in the app's CSV format, score it,
    and check the eyes-closed / eyes-open split matches the analysis pipeline."""
    from data import load, block_labels, CHANNELS
    import tempfile
    tmp = tempfile.mkdtemp()
    path = os.path.join(tmp, 'selftest.csv')
    truth = {}
    lines = ['# meta: {"samplingRate": 500, "selftest": true}',
             'Slot,tWallMs,tStreamMs,Counter,Raw0,Raw1,Raw2,Filtered0,Filtered1,Filtered2']
    for slot, s in ((1, 3), (2, 19)):
        x, ec, eo = load(s)
        n = len(x)
        y = block_labels(n, ec, eo)
        raw = np.stack([to_device_counts(x[:, CHANNELS.index(c)], np.random.default_rng(s + i))
                        for i, c in enumerate(('Oz', 'O1', 'O2'))], axis=1)
        truth[slot] = y
        for i in range(n):
            lines.append(f'{slot},{i * 2},{i * 2},{i % 256},{int(raw[i, 0])},{int(raw[i, 1])},{int(raw[i, 2])},0,0,0')
    open(path, 'w').write('\n'.join(lines))
    devices, meta = read_recording(path)
    res = score(devices, 5.0, 2.0)
    csv_out, png_out = write_outputs(path, res)
    for (slot, ch), d in sorted(res.items()):
        y = truth[slot][np.clip((d['t'] * FS).astype(int) - 1, 0, len(truth[slot]) - 1)]
        print(f'D{slot} ch{ch}: eyes closed flagged {d["state"][y == 1].mean():.0%}, eyes open flagged {d["state"][y == -1].mean():.0%}')
    print('wrote', csv_out, png_out)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('csv', nargs='?')
    ap.add_argument('--on', type=float, default=5.0)
    ap.add_argument('--off', type=float, default=2.0)
    ap.add_argument('--marks')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        selftest()
    else:
        devices, meta = read_recording(a.csv)
        res = score(devices, a.on, a.off)
        print('wrote', *write_outputs(a.csv, res))
        if a.marks:
            print(json.dumps(compare_marks(res, a.marks), indent=1))
