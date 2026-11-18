// Spectral alpha detector for the Dual Alpha page: one instance per device per channel.
// Built from the reference in docs/alpha-v2/analysis/SpectralAlphaDetector.ts (verified
// against the Python reference) with the additions of docs/alpha-v2/dual-alpha-route-2026-11-18.md §3.2:
// the DFT now covers 3-45 Hz (43 bins at 1 Hz), and each reading also carries `hfDb`
// (32-45 Hz power over the fitted 1/f line, mostly muscle: shown as "tension") and `slope`
// (the fitted 1/f exponent; computed, not shown or sent).
//
// Every `hop` samples it looks at the last `win` samples of the 1 Hz-highpassed signal,
// estimates the power spectrum with Welch's method (Hann segments of `seg` samples, 50 %
// overlap), fits a straight line to log10(power) vs log10(frequency) over the background
// bands (alpha and delta excluded) and reports how far 8-13 Hz power stands above that
// fitted 1/f background, in dB. A Schmitt trigger with confirmation counts turns that into
// isAlpha; windows containing an artifact hold the previous state.
//
// The detector is sample-driven: the same samples give the same readings, live or replayed,
// at any replay speed and whatever the chart's time base.

export interface AlphaDetectorParams {
    onDb: number;      // enter alpha when prominence >= onDb ...
    offDb: number;     // ... leave when prominence < offDb
    nOn: number;       // consecutive hops needed to enter
    nOff: number;      // consecutive hops needed to leave
    kArt: number;      // artifact if any sample deviates > kArt robust SDs
    win: number;       // analysis window (samples)
    seg: number;       // Welch segment (samples); frequency resolution = fs / seg
    hop: number;       // update interval (samples)
    scaleTauS: number; // time constant of the robust amplitude reference (s)
    maxHoldHops: number; // artifact longer than this many hops forces isAlpha off
}

/** The tuned parameters (analysis/results.json "chosen"): ON >= 5 dB for 2 hops, OFF < 2 dB for 3 hops. */
export const DEFAULT_ALPHA_PARAMS: AlphaDetectorParams = {
    onDb: 5.0, offDb: 2.0, nOn: 2, nOff: 3, kArt: 6,
    win: 1000, seg: 500, hop: 64, scaleTauS: 30, maxHoldHops: 24,
};

const ALPHA_HZ: [number, number] = [8, 13];
const FIT_LO_HZ: [number, number] = [3, 7];
const FIT_HI_HZ: [number, number] = [14, 30];
const HF_HZ: [number, number] = [32, 45];
const DFT_HZ: [number, number] = [3, 45];

export interface AlphaReading {
    isAlpha: boolean;
    promDb: number;    // alpha prominence over the 1/f background (dB)
    iafHz: number;     // frequency of the largest alpha-band excess (individual alpha frequency)
    artifact: boolean; // this window was rejected; isAlpha is being held
    hfDb: number;      // 32-45 Hz power over the extrapolated 1/f fit (dB): muscle / "tension"
    slope: number;     // slope of the 1/f fit, log10 power per log10 Hz (about -1 to -2 for EEG)
}

const EMPTY_READING: AlphaReading = { isAlpha: false, promDb: 0, iafHz: 0, artifact: false, hfDb: 0, slope: 0 };

export class SpectralAlphaDetector {
    private readonly p: AlphaDetectorParams;
    private readonly hp: Float32Array;    // ring of highpassed samples (length win)
    private readonly raw: Uint16Array;    // ring of raw ADC counts (saturation check)
    private pos = 0;
    private filled = 0;
    private sinceHop = 0;

    // DFT tables for the bins we use (3-45 Hz): cheaper than a full FFT and works for any seg.
    private readonly freqs: number[] = [];
    private readonly cosT: Float32Array[] = [];
    private readonly sinT: Float32Array[] = [];
    private readonly hann: Float32Array;
    private readonly isAlphaBin: boolean[] = [];
    private readonly isFitBin: boolean[] = [];
    private readonly isHfBin: boolean[] = [];

    private scale = -1;
    private readonly scaleA: number;
    private state = false;
    private cnt = 0;
    private held = 0;
    private last: AlphaReading = { ...EMPTY_READING };

    constructor(fs: number, params: Partial<AlphaDetectorParams> = {}) {
        this.p = { ...DEFAULT_ALPHA_PARAMS, ...params };
        const { win, seg, hop } = this.p;
        this.hp = new Float32Array(win);
        this.raw = new Uint16Array(win);
        this.scaleA = hop / (this.p.scaleTauS * fs);
        this.hann = new Float32Array(seg);
        for (let n = 0; n < seg; n++) this.hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (seg - 1));
        for (let k = 1; k <= seg / 2; k++) {
            const f = (k * fs) / seg;
            if (f < DFT_HZ[0] || f > DFT_HZ[1]) continue;
            this.freqs.push(f);
            this.isAlphaBin.push(f >= ALPHA_HZ[0] && f <= ALPHA_HZ[1]);
            this.isFitBin.push((f >= FIT_LO_HZ[0] && f <= FIT_LO_HZ[1]) || (f >= FIT_HI_HZ[0] && f <= FIT_HI_HZ[1]));
            this.isHfBin.push(f >= HF_HZ[0] && f <= HF_HZ[1]);
            const c = new Float32Array(seg), s = new Float32Array(seg);
            for (let n = 0; n < seg; n++) {
                c[n] = Math.cos((2 * Math.PI * k * n) / seg);
                s[n] = Math.sin((2 * Math.PI * k * n) / seg);
            }
            this.cosT.push(c);
            this.sinT.push(s);
        }
    }

    get params(): Readonly<AlphaDetectorParams> { return this.p; }

    /** Number of DFT bins evaluated per Welch segment (43 at fs = 500, seg = 500). */
    get binCount(): number { return this.freqs.length; }

    reset(): void {
        this.pos = this.filled = this.sinceHop = 0;
        this.scale = -1;
        this.state = false;
        this.cnt = 0;
        this.held = 0;
        this.last = { ...EMPTY_READING };
    }

    /** Feed one sample. Returns a new reading every `hop` samples once the window is full, else null. */
    push(hpSample: number, rawCount: number): AlphaReading | null {
        const { win, hop } = this.p;
        this.hp[this.pos] = hpSample;
        this.raw[this.pos] = rawCount;
        this.pos = (this.pos + 1) % win;
        if (this.filled < win) this.filled++;
        this.sinceHop++;
        if (this.filled < win || this.sinceHop < hop) return null;
        this.sinceHop = 0;
        this.last = this.evaluate();
        return this.last;
    }

    get reading(): AlphaReading { return this.last; }

    private evaluate(): AlphaReading {
        const { win, seg, hop, kArt } = this.p;
        // Unroll the ring into time order (oldest first).
        const x = new Float32Array(win);
        let rawMin = 4095, rawMax = 0;
        for (let i = 0; i < win; i++) {
            const j = (this.pos + i) % win;
            x[i] = this.hp[j];
            const r = this.raw[j];
            if (r < rawMin) rawMin = r;
            if (r > rawMax) rawMax = r;
        }

        // ── artifact gate (scale-free: compared with this channel's own recent amplitude) ──
        const lastHop = x.subarray(win - hop);
        const hopMed = median(lastHop);
        const mad = median(lastHop.map((v) => Math.abs(v - hopMed))) * 1.4826 + 1e-9;
        if (this.scale < 0) this.scale = mad;
        const winMed = median(x);
        let maxDev = 0;
        for (let i = win >> 1; i < win; i++) maxDev = Math.max(maxDev, Math.abs(x[i] - winMed));
        const artifact = maxDev > kArt * this.scale || rawMin <= 0 || rawMax >= 4095;
        if (!artifact) this.scale = (1 - this.scaleA) * this.scale + this.scaleA * mad;

        // ── Welch power at the bins we need ──
        const nb = this.freqs.length;
        const pw = new Float64Array(nb);
        let nSeg = 0;
        for (let s0 = 0; s0 + seg <= win; s0 += seg >> 1) {
            let mean = 0;
            for (let n = 0; n < seg; n++) mean += x[s0 + n];
            mean /= seg;
            for (let b = 0; b < nb; b++) {
                const c = this.cosT[b], s = this.sinT[b];
                let re = 0, im = 0;
                for (let n = 0; n < seg; n++) {
                    const v = (x[s0 + n] - mean) * this.hann[n];
                    re += v * c[n];
                    im -= v * s[n];
                }
                pw[b] += re * re + im * im;
            }
            nSeg++;
        }

        // ── 1/f background: least squares on log10(power) vs log10(f) over the fit bins ──
        let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
        for (let b = 0; b < nb; b++) {
            if (!this.isFitBin[b]) continue;
            const lx = Math.log10(this.freqs[b]);
            const ly = Math.log10(pw[b] / nSeg + 1e-20);
            sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly; m++;
        }
        const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx);
        const icpt = (sy - slope * sx) / m;

        // ── prominence (dB), individual alpha frequency, high-frequency excess (dB) ──
        let pa = 0, ba = 0, bestResid = -Infinity, iaf = 0;
        let ph = 0, bh = 0;
        for (let b = 0; b < nb; b++) {
            const isA = this.isAlphaBin[b], isH = this.isHfBin[b];
            if (!isA && !isH) continue;
            const p = pw[b] / nSeg;
            const bg = Math.pow(10, slope * Math.log10(this.freqs[b]) + icpt);
            if (isH) { ph += p; bh += bg; continue; }
            pa += p; ba += bg;
            const resid = Math.log10(p + 1e-20) - Math.log10(bg);
            if (resid > bestResid) { bestResid = resid; iaf = this.freqs[b]; }
        }
        const promDb = 10 * Math.log10(pa / ba);
        const hfDb = 10 * Math.log10((ph + 1e-20) / (bh + 1e-20));

        // ── Schmitt trigger; artifact windows hold the state, but not for longer than maxHoldHops ──
        if (artifact) {
            if (++this.held > this.p.maxHoldHops) { this.state = false; this.cnt = 0; }
        } else {
            this.held = 0;
            const want = this.state ? promDb >= this.p.offDb : promDb >= this.p.onDb;
            if (want !== this.state) {
                this.cnt++;
                if (this.cnt >= (this.state ? this.p.nOff : this.p.nOn)) { this.state = want; this.cnt = 0; }
            } else {
                this.cnt = 0;
            }
        }
        return { isAlpha: this.state, promDb, iafHz: iaf, artifact, hfDb, slope };
    }
}

function median(a: Float32Array): number {
    const s = Float32Array.from(a).sort();
    const n = s.length;
    return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}
