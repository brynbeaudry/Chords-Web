"""Render every figure used by the two alpha-v2 documents into ../figs.

    python make_figures.py      # needs results.json from evaluate.py
"""
import sys, os, json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from scipy.signal import freqz, butter, lfilter
sys.path.insert(0, os.path.dirname(__file__))
from chords_dsp import *
from data import *

HERE = os.path.dirname(os.path.abspath(__file__))
FIGS = os.path.join(HERE, '..', 'figs')
os.makedirs(FIGS, exist_ok=True)
R = json.load(open(os.path.join(HERE, 'results.json')))
P = R['chosen']

# ── house style ────────────────────────────────────────────────────────────────
plt.rcParams.update({
    'font.family': 'DejaVu Sans', 'font.size': 9, 'axes.titlesize': 10, 'axes.titleweight': 'bold',
    'axes.labelsize': 9, 'xtick.labelsize': 8, 'ytick.labelsize': 8, 'legend.fontsize': 8,
    'axes.spines.top': False, 'axes.spines.right': False, 'axes.grid': True, 'grid.alpha': 0.25,
    'figure.dpi': 110, 'savefig.dpi': 200, 'savefig.bbox': 'tight', 'legend.frameon': False,
})
C = dict(d1='#2563eb', d2='#ea580c', ec='#ede9fe', ecedge='#a78bfa', cur='#dc2626', leg='#9ca3af',
         prop='#16a34a', bg='#6b7280', alpha='#7c3aed', art='#f59e0b', ink='#111827')
W = 7.2   # inches: full A4 text width


def save(fig, name):
    fig.savefig(os.path.join(FIGS, name))
    plt.close(fig)
    print('wrote', name)


def shade_open(ax, eo, t0=0, t1=1e9, label=True):
    first = True
    for o in eo:
        a, b = o, o + 10
        if b < t0 or a > t1:
            continue
        ax.axvspan(max(a, t0), min(b, t1), color='#f3f4f6', zorder=0, lw=0,
                   label='eyes open (instructed)' if (first and label) else None)
        first = False


def shade_blocks(ax, ec, t0=0, t1=1e9, settle=1.0, label=True):
    first = True
    for o in ec:
        a, b = o, o + 10
        if b < t0 or a > t1:
            continue
        ax.axvspan(max(a, t0), min(b, t1), color=C['ec'], zorder=0, lw=0,
                   label='eyes closed (instructed)' if (first and label) else None)
        first = False


def subject_counts(s, ch, mains_uv=0.0, inject=None):
    x, ec, eo = load(s)
    uv = x[:, CHANNELS.index(ch)].copy()
    if inject is not None:
        uv += inject(len(uv))
    c = to_device_counts(uv, np.random.default_rng(s), mains_uv=mains_uv)
    return c, app_highpass(c), ec, eo


def proposed(hp, c):
    return SpectralAlpha(win=P['win'], on_db=P['on_db'], off_db=P['off_db'],
                         n_on=P['n_on'], n_off=P['n_off']).run(hp, c)


# ── F0: one-glance summary ────────────────────────────────────────────────────
def fig_summary():
    L = json.load(open(os.path.join(HERE, 'robustness.json')))['latency']
    M = json.load(open(os.path.join(HERE, 'figure_numbers.json')))['mains']
    k = M['levels'].index(100)
    panels = (
        ('Noise + 100 µV mains:\n% called alpha', '%',
         [M['legacy'][k] * 100, M['rhythm'][k] * 100, M['proposed'][k] * 100], 'lower'),
        ('Eyes open:\n% flagged', '%',
         [R['legacy_test_occ']['eo_flag'] * 100, R['rhythm_test_occ']['eo_flag'] * 100, R['proposed_test_occ']['eo_flag'] * 100], 'lower'),
        ('Closed vs open:\nseparation (AUC)', '',
         [R['auc']['legacy']['median'], R['auc']['rhythm']['median'], R['auc']['proposed']['median']], 'higher'),
        ('Eyes open: time\nuntil flag clears', 's',
         [L['legacy']['off_med'], L['rhythm']['off_med'], L['proposed']['off_med']], 'lower'),
    )
    fig, axs = plt.subplots(1, 4, figsize=(W, 2.6), gridspec_kw=dict(wspace=0.35))
    labs = ['legacy', 'current', 'proposed']
    cols = [C['leg'], C['cur'], C['prop']]
    for ax, (title, unit, vals, better) in zip(axs, panels):
        ax.bar(labs, vals, color=cols, width=0.65)
        top = max(vals) * 1.25 if unit != '' else 1.1
        for i, v in enumerate(vals):
            txt = f'{v:.0f}{unit}' if unit == '%' else (f'{v:.1f} s' if unit == 's' else f'{v:.2f}')
            ax.text(i, v + top * 0.02, txt, ha='center', va='bottom', fontsize=8, fontweight='bold' if i == 2 else 'normal')
        ax.set_ylim(0.5 if unit == '' else 0, top)
        ax.set_title(title, fontsize=8.5)
        ax.set_yticks([])
        ax.spines['left'].set_visible(False)
        ax.grid(False)
        ax.tick_params(axis='x', labelsize=7, rotation=0)
        ax.set_xticks(range(3)); ax.set_xticklabels(['legacy', 'current', 'new'])
        ax.text(0.5, -0.3, f'{better} is better', transform=ax.transAxes, ha='center', fontsize=7, color=C['bg'])
    save(fig, 'f0_summary.png')


# ── F11: the method, step by step on real data ────────────────────────────────
def fig_method(s=3, ch='Oz'):
    c, hp, ec, eo = subject_counts(s, ch)
    det = SpectralAlpha(win=P['win'])
    d = proposed(hp, c)
    uv = hp * UV_PER_COUNT
    t = np.arange(len(uv)) / FS
    picks = ((eo[1] + 5.0, 'eyes open', C['bg']), (ec[2] + 5.0, 'eyes closed', C['alpha']))
    fig = plt.figure(figsize=(W, 6.3))
    gs = fig.add_gridspec(3, 2, height_ratios=[1, 1.35, 1.25], hspace=0.65, wspace=0.28)
    f = det.f
    ax_s = fig.add_subplot(gs[1, :])
    for k, (t_end, name, col) in enumerate(picks):
        ax = fig.add_subplot(gs[0, k])
        i = int(t_end * FS)
        x = hp[i - det.WIN:i]
        ax.plot(np.arange(det.WIN) / FS, x * UV_PER_COUNT, color=col, lw=0.6)
        ax.set_ylim(-60, 60); ax.set_xlim(0, 2)
        ax.set_title(f'① the last 2 s, as the detector sees it ({name})', fontsize=8.5, color=col)
        ax.set_xlabel('seconds'); ax.set_ylabel('µV' if k == 0 else '')
        prom, iaf, slope, pw, bg = det.prominence(x)
        m = (f >= 1) & (f <= 40)
        ax_s.plot(f[m], pw[m], color=col, lw=1.6, label=f'② spectrum, {name}')
        ax_s.plot(f[m], bg[m], color=col, lw=1, ls='--', label=f'③ fitted 1/f background, {name}')
        a = det.m_alpha
        if name == 'eyes closed':
            ax_s.fill_between(f[a], bg[a], pw[a], color=C['alpha'], alpha=0.25, lw=0)
        ax_s.text(13.6, pw[a].max() * (1.0 if name == 'eyes closed' else 0.6), f'④ {prom:+.1f} dB', color=col,
                  fontsize=9, fontweight='bold', va='center')
    ax_s.axvspan(*det.FIT_LO, color=C['bg'], alpha=0.08, lw=0)
    ax_s.axvspan(*det.FIT_HI, color=C['bg'], alpha=0.08, lw=0)
    ax_s.axvspan(*det.ALPHA, color=C['alpha'], alpha=0.06, lw=0)
    ax_s.text(4.6, 1.02, 'fit band', transform=ax_s.get_xaxis_transform(), ha='center', fontsize=7, color=C['bg'])
    ax_s.text(20.5, 1.02, 'fit band', transform=ax_s.get_xaxis_transform(), ha='center', fontsize=7, color=C['bg'])
    ax_s.text(10.2, 1.02, 'alpha 8-13 Hz', transform=ax_s.get_xaxis_transform(), ha='center', fontsize=7, color=C['alpha'])
    ax_s.set_xscale('log'); ax_s.set_yscale('log')
    ax_s.set_xticks([1, 2, 3, 4, 7, 8, 13, 20, 30, 40]); ax_s.set_xticklabels(['1', '2', '3', '4', '7', '8', '13', '20', '30', '40'])
    ax_s.set_xlabel('frequency (Hz, log)'); ax_s.set_ylabel('power (log)')
    ax_s.set_yticklabels([])
    ax_s.legend(fontsize=7, loc='lower left', ncol=2)
    ax_s.set_title('②–④ spectrum, 1/f background fitted on the grey bands, and how far alpha stands above it', fontsize=9, pad=14)
    ax = fig.add_subplot(gs[2, :])
    t0, t1 = eo[1] - 2, ec[2] + 14
    shade_blocks(ax, ec, t0, t1, label=False)
    shade_open(ax, eo, t0, t1, label=False)
    mm = (d['t'] > t0) & (d['t'] < t1)
    ax.plot(d['t'][mm], d['prom'][mm], color=C['ink'], lw=1)
    ax.axhline(P['on_db'], color=C['prop'], lw=1, ls='--'); ax.axhline(P['off_db'], color=C['prop'], lw=1, ls=':')
    xm = 0.5 * (eo[1] + 10 + ec[2])
    ax.text(xm, P['on_db'] + 0.6, f'⑤ turn ON at {P["on_db"]:g} dB', ha='center', fontsize=7.5, color=C['prop'],
            bbox=dict(facecolor='white', edgecolor='none', pad=1))
    ax.text(xm, P['off_db'] - 2.4, f'turn OFF below {P["off_db"]:g} dB', ha='center', fontsize=7.5, color=C['prop'],
            bbox=dict(facecolor='white', edgecolor='none', pad=1))
    st = d['state'][mm].astype(float)
    ax.fill_between(d['t'][mm], -6, -6 + 3 * st, step='post', color=C['prop'], alpha=0.85, lw=0)
    ax.text(t0 + 0.3, -4.5, 'is_alpha', fontsize=7.5, color='white' if st[0] else C['prop'], va='center')
    for t_end, name, col in picks:
        ax.axvline(t_end, color=col, lw=1.2)
    ax.set_xlim(t0, t1); ax.set_ylim(-6, 18)
    ax.set_xlabel('session time (s)'); ax.set_ylabel('prominence (dB)')
    ax.set_title('⑤ prominence every 128 ms → hysteresis → is_alpha (vertical lines = the two windows above)', fontsize=9)
    save(fig, 'f11_method.png')


# ── F1: what the device records ───────────────────────────────────────────────
def fig_raw_trace(s=3, ch='Oz'):
    c, hp, ec, eo = subject_counts(s, ch)
    from scipy.signal import sosfiltfilt
    view = sosfiltfilt(butter(4, [1, 40], 'band', fs=FS, output='sos'), hp * UV_PER_COUNT)   # clinical 1-40 Hz view
    alpha = sosfiltfilt(butter(4, [8, 13], 'band', fs=FS, output='sos'), hp * UV_PER_COUNT)
    t = np.arange(len(view)) / FS
    fig = plt.figure(figsize=(W, 4.2))
    gs = fig.add_gridspec(2, 2, height_ratios=[1, 1], hspace=0.55, wspace=0.08)
    segs = ((eo[1] + 4, 'Eyes open: low and irregular', C['bg']),
            (ec[2] + 4, 'Eyes closed: a ~10 Hz rhythm appears', C['alpha']))
    for k, (a, title, col) in enumerate(segs):
        ax = fig.add_subplot(gs[0, k])
        m = (t >= a) & (t < a + 4)
        ax.plot(t[m] - a, view[m], color=col, lw=0.7)
        ax.set_ylim(-60, 60); ax.set_xlim(0, 4)
        ax.set_title(title, fontsize=9, color=col)
        ax.set_xlabel('seconds')
        if k == 0:
            ax.set_ylabel('µV')
        else:
            ax.set_yticklabels([])
    ax = fig.add_subplot(gs[1, :])
    a = ec[2] + 5
    m = (t >= a) & (t < a + 1.5)
    ax.plot(t[m] - a, view[m], color=C['ink'], lw=0.8, label='EEG (1-40 Hz view)')
    ax.plot(t[m] - a, alpha[m], color=C['alpha'], lw=1.8, alpha=0.85, label='its 8-13 Hz component')
    # count peaks of the alpha component to annotate the frequency
    seg = alpha[m]
    pk = np.sum((seg[1:-1] > seg[:-2]) & (seg[1:-1] > seg[2:]) & (seg[1:-1] > 0))
    ax.set_title(f'Zoom on 1.5 s of eyes closed: {pk} waves = {pk / 1.5:.0f} per second (alpha)', fontsize=9)
    ax.set_xlim(0, 1.5); ax.set_ylim(-50, 50)
    ax.set_xlabel('seconds'); ax.set_ylabel('µV')
    ax.legend(loc='upper right', ncol=2)
    save(fig, 'f1_raw_trace.png')


# ── F2: spectrum, 1/f background and why the 3-way ratio fails ────────────────
def fig_spectrum(s=3, ch='Oz'):
    c, hp, ec, eo = subject_counts(s, ch)
    det = SpectralAlpha(win=P['win'])
    y = block_labels(len(hp), ec, eo)
    spec = {}
    for lab, name in ((1, 'closed'), (-1, 'open')):
        idx = np.where(y == lab)[0]
        ps = []
        for i in range(idx[0] + det.WIN, idx[-1], det.WIN):
            if y[i - det.WIN:i].min() == lab and y[i - det.WIN:i].max() == lab:
                ps.append(det.psd(hp[i - det.WIN:i]))
        spec[name] = np.mean(ps, axis=0)
    f = det.f
    scale = UV_PER_COUNT ** 2 / (FS * (det.win ** 2).sum()) * 2   # -> uV^2/Hz
    fig, axs = plt.subplots(1, 2, figsize=(W, 3.2), gridspec_kw=dict(width_ratios=[1.5, 1], wspace=0.45))
    ax = axs[0]
    for name, col in (('open', C['bg']), ('closed', C['alpha'])):
        p = spec[name] * scale
        lp = np.log10(spec[name] + 1e-20)
        A = np.vstack([det.lf[det.m_fit], np.ones(det.m_fit.sum())]).T
        sl, ic = np.linalg.lstsq(A, lp[det.m_fit], rcond=None)[0]
        bgl = 10 ** (sl * det.lf + ic) * scale
        m = (f >= 1) & (f <= 40)
        ax.plot(f[m], p[m], color=col, lw=1.6, label=f'eyes {name}')
        ax.plot(f[m], bgl[m], color=col, lw=1, ls='--')
        if name == 'closed':
            a = det.m_alpha
            ax.fill_between(f[a], bgl[a], p[a], color=C['alpha'], alpha=0.25, lw=0)
            pr = 10 * np.log10(spec[name][a].sum() / (bgl[a] / scale).sum())
            ax.annotate(f'alpha peak stands\n{pr:.0f} dB above its\n1/f background', xy=(10, p[a].max()),
                        xytext=(16, p[a].max() * 0.35), fontsize=8, color=C['alpha'],
                        arrowprops=dict(arrowstyle='->', color=C['alpha']))
    ax.set_xscale('log'); ax.set_yscale('log')
    ax.set_xticks([1, 2, 4, 8, 13, 20, 40]); ax.set_xticklabels(['1', '2', '4', '8', '13', '20', '40'])
    ax.axvspan(*det.FIT_LO, color=C['bg'], alpha=0.07, lw=0)
    ax.axvspan(*det.FIT_HI, color=C['bg'], alpha=0.07, lw=0, label='background-fit bands')
    ax.set_xlabel('frequency (Hz, log scale)'); ax.set_ylabel('power (µV²/Hz, log scale)')
    ax.set_title('Power spectrum (Oz, one person)', fontsize=9)
    ax.legend(loc='lower left')
    # right: band shares as the legacy rule computes them
    ax = axs[1]
    _, ra = legacy_ratio(hp)
    pa, _ = band_power(hp, 'alpha'); pt, _ = band_power(hp, 'theta'); pd, _ = band_power(hp, 'delta')
    tot = pa + pt + pd
    shares = {}
    for lab, name in ((1, 'eyes\nclosed'), (-1, 'eyes\nopen')):
        k = y == lab
        shares[name] = [np.mean(pd[k] / tot[k]), np.mean(pt[k] / tot[k]), np.mean(pa[k] / tot[k])]
    bottom = np.zeros(2)
    names = list(shares)
    for j, (bn, col) in enumerate((('delta', '#d1d5db'), ('theta', '#9ca3af'), ('alpha', C['alpha']))):
        v = np.array([shares[nm][j] for nm in names])
        ax.bar(names, v, bottom=bottom, color=col, label=bn, width=0.55)
        for i in range(2):
            if v[i] > 0.06:
                ax.text(i, bottom[i] + v[i] / 2, f'{v[i]:.0%}', ha='center', va='center', fontsize=8,
                        color='white' if bn == 'alpha' else C['ink'])
        bottom += v
    ax.axhline(0.5, color=C['cur'], lw=1.2, ls='--')
    ax.text(1.32, 0.51, 'legacy rule needs\nalpha ≥ 50%', fontsize=7.5, color=C['cur'], va='bottom', ha='right')
    ax.set_ylim(0, 1); ax.set_ylabel('share of (alpha + theta + delta) power')
    ax.set_title('Same data, as the legacy rule sees it', fontsize=9)
    ax.legend(loc='upper left', bbox_to_anchor=(1.0, 1.0))
    ax.grid(False)
    save(fig, 'f2_spectrum.png')


# ── F3: the app's alpha filter, as built ──────────────────────────────────────
def fig_filter():
    hpf, lpf = BAND['alpha']
    w, h1 = freqz(*hpf, worN=16384, fs=FS)
    _, h2 = freqz(*lpf, worN=16384, fs=FS)
    H = np.abs(h1 * h2); H /= H.max()
    fig, axs = plt.subplots(1, 2, figsize=(W, 2.8))
    ax = axs[0]
    ax.plot(w, 20 * np.log10(H + 1e-12), color=C['cur'], lw=1.6, label='app "8-12 Hz" bandpass (as coded)')
    ideal = np.where((w >= 8) & (w <= 13), 0, -60)
    ax.plot(w, ideal, color=C['prop'], lw=1.2, ls='--', label='intended 8-13 Hz band')
    m = H >= 1 / np.sqrt(2)
    lo, hi = w[m][0], w[m][-1]
    ax.axhline(-3, color=C['bg'], lw=0.7, ls=':')
    ax.annotate(f'-3 dB passband\n{lo:.1f}-{hi:.1f} Hz', xy=(hi, -3), xytext=(25, -12), fontsize=8,
                arrowprops=dict(arrowstyle='->', color=C['bg']))
    for fm in (50, 60):
        g = 20 * np.log10(H[np.argmin(abs(w - fm))])
        ax.plot(fm, g, 'o', color=C['art'], ms=4)
    ax.annotate('mains 50/60 Hz:\nonly ~25 dB down', xy=(60, -25.6), xytext=(62, -45), fontsize=8,
                arrowprops=dict(arrowstyle='->', color=C['art']))
    ax.set_xlim(0, 80); ax.set_ylim(-60, 3)
    ax.set_xlabel('frequency (Hz)'); ax.set_ylabel('gain (dB)')
    ax.set_title('Frequency response')
    ax.legend(loc='lower right', fontsize=7)
    ax = axs[1]
    f = w[1:]
    S = f ** -1.5
    G = H[1:] ** 2
    out = S * G
    inb = (f >= 8) & (f <= 13)
    ax.fill_between(f, out / out.max(), where=inb, color=C['alpha'], alpha=0.5, lw=0, label='from 8-13 Hz')
    ax.fill_between(f, out / out.max(), where=~inb, color=C['cur'], alpha=0.35, lw=0, label='from outside')
    ax.plot(f, out / out.max(), color=C['ink'], lw=0.8)
    leak = 1 - out[inb].sum() / out.sum()
    ax.set_xlim(0, 30)
    ax.set_xlabel('frequency (Hz)'); ax.set_ylabel('relative output power')
    ax.set_title(f'Filter output on a 1/f background:\n{leak:.0%} comes from outside the alpha band')
    ax.legend(loc='upper right')
    fig.tight_layout()
    save(fig, 'f3_filter.png')
    return leak, lo, hi


# ── F4: noise-only false alarms vs mains pickup ───────────────────────────────
def fig_mains():
    levels = [0, 10, 20, 30, 50, 100, 200]
    rows = {k: [] for k in ('legacy', 'rhythm', 'proposed')}
    for m in levels:
        r = {k: [] for k in rows}
        for k in range(2):
            rng = np.random.default_rng(500 + k)
            uv = 15 * pink_noise(FS * 60, rng, exponent=1.5)
            c = to_device_counts(uv, rng, mains_uv=m)
            hp = app_highpass(c)
            lg, _ = legacy_ratio(hp)
            rl, _ = harness_rhythm(hp)
            r['legacy'].append(stage_c(lg)[FS * 5:].mean())
            r['rhythm'].append(stage_c(rl)[FS * 5:].mean())
            r['proposed'].append(proposed(hp, c)['state'].mean())
        for kk in rows:
            rows[kk].append(np.mean(r[kk]))
    fig, ax = plt.subplots(figsize=(W * 0.62, 2.6))
    ax.plot(levels, np.array(rows['rhythm']) * 100, 'o-', color=C['cur'], label='current default (rhythmicity)')
    ax.plot(levels, np.array(rows['legacy']) * 100, 's-', color=C['leg'], label='legacy 3-way ratio')
    ax.plot(levels, np.array(rows['proposed']) * 100, 'D-', color=C['prop'], label='proposed (spectral prominence)')
    ax.set_xlabel('60 Hz mains pickup at the electrode (µV amplitude)')
    ax.set_ylabel('% of time is_alpha = 1')
    ax.set_title('Pure noise, no brain signal at all: how often is "alpha" reported?')
    ax.set_ylim(-3, 103)
    ax.legend(loc='center right')
    fig.tight_layout()
    save(fig, 'f4_mains.png')
    return dict(levels=levels, **rows)


# ── F5: the two-device picture ────────────────────────────────────────────────
def fig_two_devices(s1=3, s2=19, ch='Oz', t0=10, t1=95):
    fig, axs = plt.subplots(7, 1, figsize=(W, 7.8), sharex=True,
                            gridspec_kw=dict(height_ratios=[1.1, 1.1, 0.33, 0.33, 0.33, 0.33, 0.33], hspace=0.5))
    states = {}
    for k, (s, col, name) in enumerate(((s1, C['d1'], 'Device 1'), (s2, C['d2'], 'Device 2'))):
        c, hp, ec, eo = subject_counts(s, ch)
        d = proposed(hp, c)
        rl, _ = harness_rhythm(hp)
        cur = stage_c(rl)
        t = d['t']
        ax = axs[k]
        shade_blocks(ax, ec, t0, t1, label=(k == 0))
        shade_open(ax, eo, t0, t1, label=(k == 0))
        ax.plot(t, d['prom'], color=col, lw=1)
        ax.axhline(P['on_db'], color=C['prop'], lw=0.8, ls='--')
        ax.axhline(P['off_db'], color=C['prop'], lw=0.8, ls=':')
        ax.set_ylabel('alpha\nprominence (dB)')
        ax.set_ylim(-4, 21)
        ax.set_title(f'{name} ({ch}, participant {"A" if k == 0 else "B"}): alpha prominence above the 1/f background',
                     loc='left', fontsize=9)
        if k == 0:
            ax.text(t1 - 0.5, P['on_db'] + 0.4, f'enter {P["on_db"]:g} dB', ha='right', fontsize=7, color=C['prop'])
            ax.text(t1 - 0.5, P['off_db'] - 2.2, f'exit {P["off_db"]:g} dB', ha='right', fontsize=7, color=C['prop'])
            ax.legend(loc='upper center', fontsize=7, ncol=2, bbox_to_anchor=(0.5, 1.0))
        ts = np.arange(len(cur)) / FS
        states[name] = (t, d['state'], ts, cur, ec)
    rows = [('Device 1 · current', 'cur', 'Device 1'), ('Device 1 · proposed', 'prop', 'Device 1'),
            ('Device 2 · current', 'cur', 'Device 2'), ('Device 2 · proposed', 'prop', 'Device 2')]
    for ax, (lab, kind, dev) in zip(axs[2:6], rows):
        t, st, ts, cur, ec = states[dev]
        shade_blocks(ax, ec, t0, t1, label=False)
        if kind == 'cur':
            ax.fill_between(ts, 0, cur.astype(float), step='post', color=C['cur'], alpha=0.8, lw=0)
        else:
            ax.fill_between(t, 0, st.astype(float), step='post', color=C['prop'], alpha=0.85, lw=0)
        ax.set_yticks([]); ax.set_ylim(0, 1); ax.grid(False)
        ax.set_ylabel(lab, rotation=0, ha='right', va='center', fontsize=8)
    # both-in-alpha (what TouchDesigner compares)
    ax = axs[6]
    t1s, st1 = states['Device 1'][0], states['Device 1'][1]
    t2s, st2 = states['Device 2'][0], states['Device 2'][1]
    n = min(len(st1), len(st2))
    both = st1[:n] & st2[:n]
    shade_blocks(ax, states['Device 1'][4], t0, t1, label=False)
    ax.fill_between(t1s[:n], 0, both.astype(float), step='post', color=C['alpha'], alpha=0.85, lw=0)
    ax.set_yticks([]); ax.set_ylim(0, 1); ax.grid(False)
    ax.set_ylabel('both in alpha\n(proposed)', rotation=0, ha='right', va='center', fontsize=8)
    ax.set_xlim(t0, t1)
    ax.set_xlabel('session time (s)')
    fig.align_ylabels(axs)
    save(fig, 'f5_two_devices.png')


# ── F6: held-out population result ────────────────────────────────────────────
def fig_population():
    fig, axs = plt.subplots(1, 2, figsize=(W, 3.0), gridspec_kw=dict(width_ratios=[1.6, 1]))
    ax = axs[0]
    kinds = (('legacy', 'legacy\n3-way ratio', C['leg']), ('rhythm', 'current default\n(rhythmicity)', C['cur']),
             ('proposed', 'proposed\n(spectral)', C['prop']))
    for j, (k, lab, col) in enumerate(kinds):
        per = R[f'{k}_test_occ']['per']
        ecv = np.array([v[0] for v in per.values()]) * 100
        eov = np.array([v[1] for v in per.values()]) * 100
        x0 = j * 3
        for a, b in zip(eov, ecv):
            ax.plot([x0, x0 + 1], [a, b], color=col, alpha=0.25, lw=0.8)
        ax.scatter(np.full(len(eov), x0), eov, color=col, s=10, zorder=3)
        ax.scatter(np.full(len(ecv), x0 + 1), ecv, color=col, s=10, zorder=3)
        ax.plot([x0, x0 + 1], [eov.mean(), ecv.mean()], color=col, lw=3, zorder=4)
        ax.text(x0 + 0.5, 106, lab, ha='center', fontsize=8, color=col, fontweight='bold')
    ax.set_xticks([0, 1, 3, 4, 6, 7]); ax.set_xticklabels(['open', 'closed'] * 3)
    ax.set_ylabel('% of block flagged is_alpha')
    ax.set_ylim(-3, 118)
    ax.set_title('Held-out subjects, O1/Oz/O2: each line = one channel of one person', fontsize=9)
    ax = axs[1]
    labs = ['legacy\nratio', 'current\nrhythm', 'old plan\nenvelope', 'proposed\nspectral']
    keys = ['legacy', 'rhythm', 'envelope', 'proposed']
    cols = [C['leg'], C['cur'], C['art'], C['prop']]
    med = [R['auc'][k]['median'] for k in keys]
    lo = [R['auc'][k]['median'] - R['auc'][k]['q25'] for k in keys]
    hi = [R['auc'][k]['q75'] - R['auc'][k]['median'] for k in keys]
    ax.bar(labs, med, color=cols, yerr=[lo, hi], capsize=3, width=0.6)
    ax.axhline(0.5, color=C['bg'], lw=0.8, ls=':')
    ax.text(3.45, 0.505, 'chance', fontsize=7, color=C['bg'], ha='right', va='bottom')
    for i, v in enumerate(med):
        ax.text(i, 0.36, f'{v:.2f}', ha='center', fontsize=8, color='white', fontweight='bold')
    ax.set_ylim(0.3, 1.02)
    ax.set_ylabel('AUC: closed vs open')
    ax.set_title('Separation, all 20 subjects', fontsize=9)
    ax.tick_params(axis='x', labelsize=7)
    fig.tight_layout()
    save(fig, 'f6_population.png')


# ── F7: electrode placement ───────────────────────────────────────────────────
def fig_placement():
    chans = ['O1', 'Oz', 'O2', 'Pz', 'Cz', 'Fz', 'Fp1']
    vals = []
    import glob
    for ch in chans:
        v = []
        for s in subjects():
            d = np.load(os.path.join(HERE, 'cache', f's{s:02d}_{ch}_m0.npz'))
            t = d[f'w{P["win"]}_t']
            y = d['y'][np.clip((t * FS).astype(int) - 1, 0, len(d['y']) - 1)]
            p = d[f'w{P["win"]}_prom']
            v.append(np.median(p[y == 1]) - np.median(p[y == -1]))
        vals.append(v)
    fig, ax = plt.subplots(figsize=(W * 0.62, 2.6))
    bp = ax.boxplot(vals, tick_labels=chans, patch_artist=True, widths=0.55, showfliers=False, medianprops=dict(color=C['ink']))
    for i, b in enumerate(bp['boxes']):
        b.set_facecolor(C['prop'] if i < 3 else (C['art'] if i < 5 else '#fca5a5'))
        b.set_alpha(0.6)
    for i, v in enumerate(vals):
        ax.scatter(np.random.default_rng(i).normal(i + 1, 0.06, len(v)), v, s=6, color=C['ink'], alpha=0.5, zorder=3)
    ax.axhline(0, color=C['bg'], lw=0.8)
    ax.set_ylabel('eyes-closed minus eyes-open\nprominence (dB)')
    ax.set_title('Where the electrode goes matters more than the algorithm', fontsize=9, pad=18)
    ax.set_ylim(-1.5, 12)
    ax.legend(handles=[Patch(color=C['prop'], alpha=0.6, label='occipital'),
                       Patch(color=C['art'], alpha=0.6, label='parietal / central'),
                       Patch(color='#fca5a5', alpha=0.6, label='frontal')], loc='upper center', fontsize=7, ncol=3, bbox_to_anchor=(0.5, 1.02))
    fig.tight_layout()
    save(fig, 'f7_placement.png')
    return {ch: float(np.median(v)) for ch, v in zip(chans, vals)}


# ── F8: artifacts ─────────────────────────────────────────────────────────────
def fig_artifacts(s=11, ch='Oz'):
    x, ec, eo = load(s)
    o = ec[2]          # an eyes-closed block: alpha should stay detected through the artifacts
    rng = np.random.default_rng(7)
    events = []

    def inj(n):
        a = np.zeros(n)
        for dt in (1.5, 3.0, 4.5):                                   # three blinks
            i = int((o + dt) * FS); b = blink(amp_uv=90.0); a[i:i + len(b)] += b
            events.append(('blink', o + dt))
        i = int((o + 6.0) * FS)                                      # 1 s jaw clench (EMG)
        b, aa = butter(4, [20, 120], 'band', fs=FS)
        a[i:i + FS] += 25 * lfilter(b, aa, rng.normal(size=FS)) / 0.35
        events.append(('jaw clench', o + 6.0))
        i = int((o + 8.0) * FS)                                      # electrode pop
        a[i:i + 40] += np.linspace(400, 0, 40)
        events.append(('electrode pop', o + 8.0))
        return a
    c, hp, _, _ = subject_counts(s, ch, inject=inj)
    d = proposed(hp, c)
    lg, _ = legacy_ratio(hp)
    leg = stage_c(lg)
    t = np.arange(len(hp)) / FS
    A = json.load(open(os.path.join(HERE, 'artifacts.json')))
    fig = plt.figure(figsize=(W, 5.0))
    gs = fig.add_gridspec(4, 2, width_ratios=[1.7, 1], height_ratios=[1.3, 1, 0.32, 0.32], hspace=0.45, wspace=0.35)
    ax = fig.add_subplot(gs[0, 0])
    m = (t > o - 1) & (t < o + 11)
    ax.plot(t[m] - o, hp[m] * UV_PER_COUNT, color=C['ink'], lw=0.4)
    for name, te in events[:5]:
        ax.annotate(name, xy=(te - o, 100), fontsize=7, color=C['art'], ha='center')
    ax.set_ylim(-90, 115); ax.set_ylabel('µV'); ax.set_xlim(-1, 11)
    ax.set_title(f'Eyes-closed block ({ch}) with artifacts added', fontsize=9)
    ax.tick_params(labelbottom=False)
    ax = fig.add_subplot(gs[1, 0], sharex=ax)
    tm = (d['t'] > o - 1) & (d['t'] < o + 11)
    ax.plot(d['t'][tm] - o, d['prom'][tm], color=C['prop'], lw=1)
    ax.fill_between(d['t'][tm] - o, -8, 20, where=d['art'][tm], color=C['art'], alpha=0.25, lw=0, step='pre',
                    label='artifact gate: hold last state')
    ax.axhline(P['on_db'], color=C['prop'], lw=0.8, ls='--')
    ax.set_ylim(-8, 20); ax.set_ylabel('prominence\n(dB)')
    ax.legend(loc='lower left', fontsize=7)
    ax.tick_params(labelbottom=False)
    for k, (lab, x_, y_, col) in enumerate((('legacy', t, leg, C['leg']), ('proposed', d['t'], d['state'], C['prop']))):
        ax = fig.add_subplot(gs[2 + k, 0], sharex=ax)
        mm = (x_ > o - 1) & (x_ < o + 11)
        ax.fill_between(x_[mm] - o, 0, y_[mm].astype(float), step='post', color=col, alpha=0.85, lw=0)
        ax.set_yticks([]); ax.set_ylim(0, 1); ax.grid(False)
        ax.set_ylabel(lab, rotation=0, ha='right', va='center', fontsize=8)
        if k == 0:
            ax.tick_params(labelbottom=False)
    ax.set_xlabel('seconds into the block')
    # population bars
    ax = fig.add_subplot(gs[:, 1])
    kinds = (('legacy', 'legacy', C['leg']), ('rhythm', 'current', C['cur']), ('proposed', 'proposed', C['prop']))
    y0 = np.arange(3)
    for j, (k, lab, col) in enumerate(kinds):
        cl, ar = A[f'{k}_clean']['ec'] * 100, A[f'{k}_artifacts']['ec'] * 100
        ax.barh(j + 0.18, cl, height=0.34, color=col, alpha=0.45)
        ax.barh(j - 0.18, ar, height=0.34, color=col)
        ax.text(cl + 1, j + 0.18, f'{cl:.0f}% clean', va='center', fontsize=7)
        ax.text(ar + 1, j - 0.18, f'{ar:.0f}% with artifacts', va='center', fontsize=7)
    ax.set_yticks(y0); ax.set_yticklabels([k[1] for k in kinds])
    ax.set_xlim(0, 135); ax.set_xticks([0, 25, 50, 75, 100])
    ax.set_xlabel('% of eyes-closed time detected')
    ax.set_title('All 20 subjects (Oz)', fontsize=9)
    ax.grid(axis='y', visible=False)
    save(fig, 'f8_artifacts.png')
    return A


# ── F9: response time (spliced eyes-open | eyes-closed | eyes-open) ───────────
def fig_latency():
    L = json.load(open(os.path.join(HERE, 'robustness.json')))['latency']
    fig, axs = plt.subplots(1, 2, figsize=(W, 2.7), sharey=True, gridspec_kw=dict(wspace=0.3))
    kinds = (('legacy', 'legacy ratio', C['leg']), ('rhythm', 'current default', C['cur']), ('proposed', 'proposed', C['prop']))
    for ax, key, title in ((axs[0], 'on_all', 'eyes close: time until is_alpha turns ON'),
                           (axs[1], 'off_all', 'eyes open: time until is_alpha turns OFF')):
        data = [L[k][key] for k, _, _ in kinds]
        bp = ax.boxplot(data, vert=False, widths=0.5, patch_artist=True, showfliers=False,
                        medianprops=dict(color=C['ink'], lw=1.5))
        for i, (b, (_, _, col)) in enumerate(zip(bp['boxes'], kinds)):
            b.set_facecolor(col); b.set_alpha(0.55)
            ax.scatter(data[i], np.random.default_rng(i).normal(i + 1, 0.07, len(data[i])), s=6, color=col, zorder=3)
            ax.text(8.6, i + 1, f'median\n{np.median(data[i]):.1f} s', va='center', ha='left', fontsize=7.5, color=C['ink'])
        ax.set_yticks([1, 2, 3]); ax.set_yticklabels([lab for _, lab, _ in kinds])
        ax.set_xlim(0, 8.5); ax.set_xlabel('seconds after the change')
        ax.set_title(title, fontsize=9)
    save(fig, 'f9_latency.png')
    return {k: dict(on_med=L[k]['on_med'], off_med=L[k]['off_med'], on_p90=L[k]['on_p90'], off_p90=L[k]['off_p90'])
            for k, _, _ in kinds}


# ── F10: the threshold is a dial ──────────────────────────────────────────────
def fig_operating():
    rows = json.load(open(os.path.join(HERE, 'robustness.json')))['operating'][str(P['win'])]
    pers = json.load(open(os.path.join(HERE, 'personal.json')))['4.0']
    on = np.array([r['on'] for r in rows])
    eo = np.array([r['eo'] for r in rows]) * 100
    ec = np.array([r['ec'] for r in rows]) * 100
    p10 = np.array([r['ec_p10'] for r in rows]) * 100
    null = np.array([r['null'] for r in rows]) * 100
    fig, axs = plt.subplots(1, 2, figsize=(W, 3.1), gridspec_kw=dict(width_ratios=[1.45, 1], wspace=0.35))
    ax = axs[0]
    ax.plot(eo, ec, 'o-', color=C['alpha'], ms=4, label='fixed threshold: average channel')
    ax.plot(eo, p10, 'o--', color=C['alpha'], alpha=0.5, ms=3, label='fixed threshold: weakest 10%')
    for x_, y_, o_ in zip(eo, ec, on):
        if o_ in (3.0, 4.0, 5.0, 6.0, 7.0):
            ax.annotate(f'{o_:g} dB', (x_, y_), textcoords='offset points', xytext=(-4, 6), fontsize=7, color=C['alpha'], ha='right')
    ax.scatter([pers['pers_eo']['mean'] * 100], [pers['pers_ec']['mean'] * 100], marker='*', s=140, color=C['art'], zorder=5,
               label='20 s personal check: average')
    ax.scatter([pers['pers_eo']['mean'] * 100], [pers['pers_ec']['p10'] * 100], marker='*', s=90, color=C['art'], alpha=0.6, zorder=5,
               label='20 s personal check: weakest 10%')
    k = np.argmin(abs(on - P['on_db']))
    ax.scatter([eo[k]], [ec[k]], s=90, facecolor='none', edgecolor=C['prop'], lw=2, zorder=6, label=f'default ({P["on_db"]:g} dB)')
    ax.set_xlabel('eyes open: % of time flagged  (lower is better)')
    ax.set_ylabel('eyes closed: % of time detected\n(higher is better)')
    ax.set_xlim(0, 80); ax.set_ylim(0, 102)
    ax.set_title('Trade-off as the enter threshold moves', fontsize=9)
    ax.legend(fontsize=6.5, loc='lower right')
    ax = axs[1]
    ax.plot(on, null, 'D-', color=C['cur'], ms=4)
    ax.axvline(P['on_db'], color=C['prop'], lw=1.2)
    ax.text(P['on_db'] + 0.15, 30, f'default\n{P["on_db"]:g} dB:\n{null[k]:.1f}%', color=C['prop'], fontsize=7.5)
    ax.set_xlabel('enter threshold (dB)')
    ax.set_ylabel('pure noise: % of time flagged')
    ax.set_title('False alarms with no brain signal', fontsize=9)
    save(fig, 'f10_operating.png')


if __name__ == '__main__':
    extra = {}
    fig_summary()
    fig_method()
    fig_raw_trace()
    fig_spectrum()
    leak, lo, hi = fig_filter()
    extra['filter'] = dict(leak=leak, lo=lo, hi=hi)
    extra['mains'] = fig_mains()
    fig_two_devices()
    fig_population()
    extra['placement'] = fig_placement()
    extra['artifacts'] = fig_artifacts()
    extra['latency'] = fig_latency()
    fig_operating()
    json.dump(extra, open(os.path.join(HERE, 'figure_numbers.json'), 'w'), indent=1, default=float)
    print(json.dumps(extra, indent=1, default=float))
