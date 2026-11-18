// Deterministic synthetic NPG Lite signals for tests and scripts (no dataset needed).
// Output is raw ADC counts (0..4095, mid-scale 2048) at 500 Hz, like a BLE sample.
// Every generator takes a seed, so the same call always returns the same samples.

export const FS = 500;
export const UV_PER_COUNT = 3.3 / 4095 / 1470 * 1e6; // about 0.55 µV per count

/** mulberry32: small, fast, deterministic PRNG returning [0, 1). */
export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function gaussian(r: () => number): () => number {
    return () => {
        const u = Math.max(r(), 1e-12), v = r();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
}

/** Pink (1/f power) noise via Paul Kellet's filter, scaled to roughly unit SD. */
export function pinkNoise(n: number, seed: number): Float64Array {
    const g = gaussian(rng(seed));
    const out = new Float64Array(n);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
        const w = g();
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.2;
        b6 = w * 0.115926;
    }
    return out;
}

export function whiteNoise(n: number, seed: number): Float64Array {
    const g = gaussian(rng(seed));
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = g();
    return out;
}

/** True during the eyes-closed blocks: 10 s open, 10 s closed, alternating (open first). */
export function eyesClosedAt(i: number, blockS = 10): boolean {
    return Math.floor(i / (blockS * FS)) % 2 === 1;
}

export interface SynthOptions {
    seconds: number;
    seed: number;
    pinkCounts?: number;   // SD of the 1/f background, counts
    alphaCounts?: number;  // amplitude of the 10 Hz rhythm during eyes-closed blocks, counts (0 = none)
    alphaHz?: number;
    mainsCounts?: number;  // amplitude of the mains hum, counts
    mainsHz?: number;
    whiteCounts?: number;  // SD of white (flat-spectrum) noise, counts
    emgCounts?: number;    // muscle-like noise: differenced white noise, power rising with frequency
    railFromS?: number;    // pin the output at 4095 from this time ...
    railForS?: number;     // ... for this long
}

/** Raw ADC counts: 2048 + background + alpha in the eyes-closed blocks + hum + white noise. */
export function synthCounts(o: SynthOptions): Float64Array {
    const n = Math.round(o.seconds * FS);
    const pink = pinkNoise(n, o.seed);
    const white = whiteNoise(n, o.seed + 1000);
    const emg = whiteNoise(n + 1, o.seed + 3000);
    const r = rng(o.seed + 2000);
    const alphaHz = o.alphaHz ?? 10, mainsHz = o.mainsHz ?? 60;
    const phA = r() * 2 * Math.PI, phM = r() * 2 * Math.PI;
    const out = new Float64Array(n);
    let env = 0; // alpha waxes and wanes over ~0.3 s instead of switching on a sample
    for (let i = 0; i < n; i++) {
        const t = i / FS;
        env += ((eyesClosedAt(i) ? 1 : 0) - env) * (1 / (0.3 * FS));
        let v = 2048 + (o.pinkCounts ?? 0) * pink[i] + (o.whiteCounts ?? 0) * white[i];
        if (o.emgCounts) v += o.emgCounts * (emg[i + 1] - emg[i]);
        if (o.alphaCounts) v += o.alphaCounts * env * Math.sin(2 * Math.PI * alphaHz * t + phA);
        if (o.mainsCounts) v += o.mainsCounts * Math.sin(2 * Math.PI * mainsHz * t + phM);
        if (o.railFromS !== undefined && t >= o.railFromS && t < o.railFromS + (o.railForS ?? 0)) v = 4095;
        out[i] = Math.min(4095, Math.max(0, Math.round(v)));
    }
    return out;
}

/** The four fixture signals of the detector test (P1). */
export const FIXTURE_SIGNALS: Record<string, SynthOptions> = {
    alpha: { seconds: 60, seed: 11, pinkCounts: 40, alphaCounts: 30 },
    mains: { seconds: 60, seed: 12, pinkCounts: 40, mainsCounts: 180 },  // ~100 µV of 60 Hz, no alpha
    noise: { seconds: 60, seed: 13, whiteCounts: 8 },                      // no EEG at all
    railed: { seconds: 60, seed: 14, pinkCounts: 40, alphaCounts: 30, railFromS: 33, railForS: 10 },
};

/**
 * A two-person session as recording rows ([slot, tWallMs, tStreamMs, counter, raw0..2, f0..2]),
 * interleaved in 10-sample BLE packets like the live page. Person 2's eyes-closed blocks
 * start 5 s before person 1's, so the pair is "together" for about 5 s of every 20.
 */
export function synthDualRows(seconds: number, seed = 100): number[][] {
    const n = seconds * FS;
    // person 2 is the same kind of signal started 5 s into its block clock
    const dev = (slot: number, skip: number) => [0, 1, 2].map((ch) =>
        synthCounts({ seconds: seconds + skip, seed: seed + slot * 10 + ch, pinkCounts: 40, alphaCounts: 30 })
            .subarray(skip * FS, skip * FS + n));
    const d1 = dev(1, 0), d2 = dev(2, 5);
    const rows: number[][] = [];
    for (let p = 0; p < n; p += 10) {
        for (const [slot, d] of [[1, d1], [2, d2]] as const) {
            for (let i = p; i < Math.min(n, p + 10); i++) {
                const t = (i * 1000) / FS;
                rows.push([slot, t, t, i % 256, d[0][i], d[1][i], d[2][i], 0, 0, 0]);
            }
        }
    }
    return rows;
}
