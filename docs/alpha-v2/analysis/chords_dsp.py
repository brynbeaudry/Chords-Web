"""Python port of the Chords-Web dual-stream alpha pipeline, plus the proposed detector.

Every filter below uses the exact biquad coefficients from src/components/filters.tsx
(500 Hz branch). The TypeScript biquads are Direct Form II:

    x1  = in - a1*z1 - a2*z2
    out = b0*x1 + b1*z1 + b2*z2

which is exactly scipy.signal.lfilter(b, [1, a1, a2], ...), so lfilter is used for speed.

Detectors:
  legacy_ratio()     - the original 3-way ratio (rA >= 0.50, lead >= 0.15), page.tsx runStageC `legacy`
  harness_rhythm()   - the current default harness metric (autocorrelation >= 0.4), page.tsx alphaRhythmicity
  stage_c()          - longest-run-in-visible-window rule that turns per-sample labels into is_alpha
  envelope_prom()    - the May-2026 plan's P_alpha / P_ref biquad envelope ratio (tested, not adopted)
  SpectralAlpha      - the proposed detector: sliding Welch PSD, 1/f background fit, prominence in dB,
                       artifact gate, hysteresis
"""
import numpy as np
from scipy.signal import lfilter

FS = 500

# ── filters.tsx coefficients, 500 Hz ───────────────────────────────────────────
# (b, a) with a = [1, a1, a2]; signs exactly as in the TS source.
HP_1HZ = ([0.99911182, -1.99822364, 0.99911182], [1, -1.99822285, 0.99822443])        # HighPassFilter
NOTCH_50 = [([0.96508099, -1.56202714, 0.96508099], [1, -1.56858163, 0.96424138]),     # Notch type 1
            ([1.0, -1.61854514, 1.0], [1, -1.61100358, 0.96592171])]
NOTCH_60 = [([0.96508099, -1.40747202, 0.96508099], [1, -1.40810535, 0.96443153]),     # Notch type 2
            ([1.0, -1.45839783, 1.0], [1, -1.45687509, 0.96573127])]
BAND = {  # BandpassFilter: highpass biquad then lowpass biquad
    'alpha': (([0.93137886, -1.86275772, 0.93137886], [1, -1.85804330, 0.86747213]),   # HP 8 Hz
              ([0.00512927, 0.01025854, 0.00512927], [1, -1.78743252, 0.80794959])),   # LP 12 Hz
    'theta': (([0.96508099, -1.93016197, 0.96508099], [1, -1.92894226, 0.93138168]),   # HP 4 Hz
              ([0.00208057, 0.00416113, 0.00208057], [1, -1.86689228, 0.87521455])),   # LP 7.5 Hz
    'delta': (([0.99115360, -1.98230719, 0.99115360], [1, -1.98222893, 0.98238545]),   # HP 1 Hz
              ([0.00060985, 0.00121971, 0.00060985], [1, -1.92894226, 0.93138168])),   # LP 4 Hz
}

# ── device model ───────────────────────────────────────────────────────────────
# Upside Down Labs (email, 2026-04-11): default BioAmp gain x1470 (x882 via GAIN_PIN 14).
# 12-bit ESP32-C6 ADC, ~3.3 V full scale  ->  1 count = 3.3/4095/1470 V = 0.548 uV.
GAIN = 1470.0
VREF = 3.3
UV_PER_COUNT = VREF / 4095 / GAIN * 1e6


def to_device_counts(uv, rng, adc_noise_counts=3.0, mains_uv=0.0, mains_hz=60.0, fs=FS):
    """Model what the NPG Lite would emit for a scalp signal given in microvolts.

    The amplifier output sits at mid-rail (2048), is scaled by the gain, quantised to
    integers and clipped to the 12-bit range. adc_noise_counts is white ADC noise (rms, counts)
    [assumption: ESP32 SAR ADCs typically show a few LSB rms]. mains_uv adds a sinusoid of
    that amplitude (uV) to model power-line pickup.
    """
    t = np.arange(len(uv)) / fs
    sig = uv + mains_uv * np.sin(2 * np.pi * mains_hz * t)
    counts = 2048 + sig / UV_PER_COUNT + rng.normal(0, adc_noise_counts, len(uv))
    return np.clip(np.round(counts), 0, 4095)


def biquad(x, ba):
    return lfilter(ba[0], ba[1], x)


def app_highpass(counts):
    """hpOutput in page.tsx ingestSample: the 1 Hz highpass applied to raw counts."""
    return biquad(counts, HP_1HZ)


def band_signal(hp, band):
    hpf, lpf = BAND[band]
    return biquad(biquad(hp, hpf), lpf)


def ema(x, alpha):
    """BandPowerEnvelope: power = (1-a)*power + a*v^2  ==  lfilter([a], [1, -(1-a)], v^2)."""
    return lfilter([alpha], [1, -(1 - alpha)], x)


def band_power(hp, band, ema_ms=500, fs=FS):
    v = band_signal(hp, band)
    return ema(v * v, 1 / ((ema_ms / 1000) * fs)), v


# ── current detector 1: legacy 3-way ratio ─────────────────────────────────────
def legacy_ratio(hp, dominance=0.5, margin=0.15):
    pa, _ = band_power(hp, 'alpha')
    pt, _ = band_power(hp, 'theta')
    pd, _ = band_power(hp, 'delta')
    tot = pa + pt + pd + 1e-12
    ra, rt, rd = pa / tot, pt / tot, pd / tot
    label = (ra >= dominance) & (ra - np.maximum(rt, rd) >= margin)
    return label, ra


# ── current detector 2: the default harness metric (rhythmicity) ───────────────
def harness_rhythm(hp, rmin=0.4, win=512, every=32, fs=FS):
    """page.tsx alphaRhythmicity on the alpha-bandpassed signal.

    Recomputed every `every` samples (RHYTHM_EVERY=8 ticks x 8 ms tick = 64 ms = 32 samples);
    the verdict is held between updates, matching combinedAlphaRef being stamped per sample.
    """
    _, sig = band_power(hp, 'alpha')
    lag_lo, lag_hi = max(2, round(fs * 0.077)), round(fs * 0.125)
    n = len(sig)
    label = np.zeros(n, bool)
    rhythm = np.zeros(n)
    cur_l, cur_r = False, 0.0
    for i in range(n):
        if i % every == 0 and i >= win:
            t = sig[i - win:i] - sig[i - win:i].mean()
            den = np.dot(t, t)
            if den > 1e-9:
                ac = np.array([np.dot(t[:-tau], t[tau:]) for tau in range(lag_lo, lag_hi + 1)]) / den
                k = int(np.argmax(ac))
                peak, best = ac[k], lag_lo + k
                r2x = np.dot(t[:-2 * best], t[2 * best:]) / den if 2 * best < win else 0.0
                cur_r = max(peak, 0.0)
                cur_l = (peak >= rmin) and (r2x >= 0)
        label[i] = cur_l
        rhythm[i] = cur_r
    return label, rhythm


# ── current Stage C: longest run in the visible window ─────────────────────────
def stage_c(label, window=2000, min_run_frac=0.12, every=4):
    """is_alpha = (longest consecutive run of label==1 inside the last `window` samples)
    >= min_run_frac*window. timeBase 4 s at 500 Hz -> window 2000, min run 240 samples (0.48 s).
    Evaluated every `every` samples (8 ms stream-clock tick = 4 samples)."""
    n = len(label)
    min_run = int(min_run_frac * window)
    # run length ending at each sample
    run = np.zeros(n, int)
    r = 0
    for i, v in enumerate(label):
        r = r + 1 if v else 0
        run[i] = r
    out = np.zeros(n, bool)
    from collections import deque
    # sliding max of run-length clipped to window start: a run that started before the window
    # only counts the part inside the window.
    cur = False
    for i in range(0, n, every):
        lo = max(0, i - window + 1)
        seg = run[lo:i + 1]
        idx = np.arange(lo, i + 1)
        inside = np.minimum(seg, idx - lo + 1)
        cur = inside.max() >= min_run if len(inside) else False
        out[i:i + every] = cur
    return out


# ── the May-2026 plan: biquad envelope prominence (evaluated, not adopted) ─────
def envelope_prom(hp, ema_ms=250, fs=FS):
    """P_alpha / P_ref where P_ref is flank power (6-7 Hz + 13-15 Hz) from 2nd-order
    Butterworth bandpasses, as proposed in ALPHA_DETECTION_PLAN.md section 5."""
    from scipy.signal import butter
    a = 1 / ((ema_ms / 1000) * fs)

    def bp(lo, hi):
        b, aa = butter(2, [lo, hi], btype='band', fs=fs)
        v = lfilter(b, aa, hp)
        return ema(v * v, a)
    p_alpha = bp(8, 13)
    p_ref = 0.5 * (bp(6, 7) + bp(13, 15))
    return p_alpha / (p_ref + 1e-12)


# ── proposed detector ──────────────────────────────────────────────────────────
class SpectralAlpha:
    """Alpha-prominence detector for one channel.

    Every HOP samples, take the last WIN samples of the highpassed signal, estimate the power
    spectrum with Welch's method (SEG-sample Hann segments, 50 % overlap), fit a straight line to
    log10(power) vs log10(frequency) over the background bands (FIT_LO and FIT_HI: alpha excluded,
    delta excluded), and measure how far the 8-13 Hz band power stands above that fitted 1/f
    background, in dB. That number is `prom_db`.

    An artifact gate marks windows that contain a sample beyond K_ART robust standard deviations
    of the channel's own recent history, or ADC saturation. In an artifact window the state is
    held (no update), for at most `max_hold` hops; past that it is forced off. A Schmitt
    trigger with an enter level, an exit level and confirmation counts turns prom_db into
    is_alpha.
    """
    HOP = 64            # 128 ms update rate
    WIN = 1000          # 2.0 s analysis window
    SEG = 500           # 1.0 s Welch segments -> 1 Hz resolution, 3 segments at 50 % overlap
    ALPHA = (8.0, 13.0)
    FIT_LO = (3.0, 7.0)
    FIT_HI = (14.0, 30.0)

    def __init__(self, fs=FS, on_db=3.0, off_db=1.5, n_on=3, n_off=4, k_art=6.0,
                 scale_tau_s=30.0, win=None, max_hold=24):
        self.fs = fs
        self.max_hold = max_hold
        if win:
            self.WIN = win
        self.on_db, self.off_db = on_db, off_db
        self.n_on, self.n_off = n_on, n_off
        self.k_art = k_art
        self.win = np.hanning(self.SEG)
        f = np.fft.rfftfreq(self.SEG, 1 / fs)
        self.f = f
        self.m_alpha = (f >= self.ALPHA[0]) & (f <= self.ALPHA[1])
        self.m_fit = ((f >= self.FIT_LO[0]) & (f <= self.FIT_LO[1])) | \
                     ((f >= self.FIT_HI[0]) & (f <= self.FIT_HI[1]))
        self.lf = np.log10(np.where(f > 0, f, 1))
        # robust scale: EMA of the per-hop median absolute deviation
        self.scale = None
        self.scale_a = self.HOP / (scale_tau_s * fs)

    def psd(self, x):
        segs = [x[s:s + self.SEG] for s in range(0, len(x) - self.SEG + 1, self.SEG // 2)]
        p = np.mean([np.abs(np.fft.rfft((s - s.mean()) * self.win)) ** 2 for s in segs], axis=0)
        return p

    def prominence(self, x):
        p = self.psd(x)
        lp = np.log10(p + 1e-20)
        A = np.vstack([self.lf[self.m_fit], np.ones(self.m_fit.sum())]).T
        slope, icpt = np.linalg.lstsq(A, lp[self.m_fit], rcond=None)[0]
        bg = 10 ** (slope * self.lf + icpt)
        prom_db = 10 * np.log10(p[self.m_alpha].sum() / bg[self.m_alpha].sum())
        resid = lp - np.log10(bg)
        band = np.where(self.m_alpha)[0]
        iaf = self.f[band[np.argmax(resid[band])]]
        return prom_db, iaf, slope, p, bg

    def features(self, hp, raw=None):
        """Per-hop prominence, peak frequency and artifact flag (no decision yet)."""
        n = len(hp)
        out = dict(t=[], prom=[], iaf=[], art=[])
        for i in range(self.WIN, n, self.HOP):
            x = hp[i - self.WIN:i]
            hop = hp[i - self.HOP:i]
            mad = np.median(np.abs(hop - np.median(hop))) * 1.4826 + 1e-9
            if self.scale is None:
                self.scale = mad
            art = np.max(np.abs(x[-self.WIN // 2:] - np.median(x))) > self.k_art * self.scale
            if raw is not None:
                r = raw[i - self.WIN:i]
                art = art or (r.min() <= 0) or (r.max() >= 4095)
            if not art:
                self.scale = (1 - self.scale_a) * self.scale + self.scale_a * mad
            prom, iaf, _, _, _ = self.prominence(x)
            out['t'].append(i / self.fs)
            out['prom'].append(prom)
            out['iaf'].append(iaf)
            out['art'].append(art)
        return {k: np.array(v) for k, v in out.items()}

    def run(self, hp, raw=None):
        d = self.features(hp, raw)
        d['state'] = hysteresis(d['prom'], d['art'], self.on_db, self.off_db, self.n_on, self.n_off, self.max_hold)
        return d


def hysteresis(prom, art, on_db, off_db, n_on, n_off, max_hold=24):
    """Schmitt trigger with confirmation counts. Artifact hops hold the current state, but
    after more than `max_hold` consecutive artifact hops (24 x 128 ms ~ 3 s: electrode off,
    saturation, sustained movement) the state is forced off rather than frozen."""
    state, cnt, held = False, 0, 0
    out = np.zeros(len(prom), bool)
    for k, (p, a) in enumerate(zip(prom, art)):
        if a:
            held += 1
            if held > max_hold:
                state, cnt = False, 0
        else:
            held = 0
            want = (p >= on_db) if not state else (p >= off_db)
            if want != state:
                cnt += 1
                if cnt >= (n_on if not state else n_off):
                    state, cnt = want, 0
            else:
                cnt = 0
        out[k] = state
    return out


def hop_to_samples(times, values, n, fs=FS):
    """Expand a per-hop series to per-sample (zero-order hold)."""
    out = np.zeros(n, dtype=np.asarray(values).dtype)
    idx = (np.asarray(times) * fs).astype(int)
    for k, i in enumerate(idx):
        j = idx[k + 1] if k + 1 < len(idx) else n
        out[i:j] = values[k]
    return out
