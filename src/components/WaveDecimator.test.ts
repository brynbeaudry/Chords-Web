import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaveDecimator, type WaveBatch } from './WaveDecimator';

const FS = 500;

function decimate(x: (i: number) => number, nIn: number): WaveBatch[] {
    const d = new WaveDecimator();
    const out: WaveBatch[] = [];
    for (let i = 0; i < nIn; i++) {
        const b = d.push(x(i));
        if (b) out.push(b);
    }
    return out;
}

/** Hann-windowed power spectrum (one-sided, by DFT bin) of a 125 Hz series. */
function spectrum(y: number[]): { f: number; p: number }[] {
    const n = y.length, fs = FS / 4, out = [];
    for (let k = 0; k <= n / 2; k++) {
        let re = 0, im = 0;
        for (let i = 0; i < n; i++) {
            const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
            re += y[i] * w * Math.cos((2 * Math.PI * k * i) / n);
            im -= y[i] * w * Math.sin((2 * Math.PI * k * i) / n);
        }
        out.push({ f: (k * fs) / n, p: re * re + im * im });
    }
    return out;
}

test('500 -> 125 Hz: exactly 16 samples per 64-sample hop, averages of 4', () => {
    const d = new WaveDecimator();
    for (let hop = 0; hop < 10; hop++) {
        for (let i = 0; i < 63; i++) assert.equal(d.push(hop * 64 + i), null);
        const b = d.push(hop * 64 + 63);
        assert.ok(b);
        assert.equal(b!.w.length, 16);
        assert.equal(b!.w[0], hop * 64 + 1.5);   // mean of 4 consecutive integers
    }
});

test('n rises by 16 per batch with no gap, and restarts at 0 after reset', () => {
    const batches = decimate(() => 0, 64 * 50);
    assert.equal(batches.length, 50);
    batches.forEach((b, k) => assert.equal(b.n, 16 * k));
    const d = new WaveDecimator();
    for (let i = 0; i < 100; i++) d.push(1);
    d.reset();
    let first: WaveBatch | null = null;
    for (let i = 0; i < 64 && !first; i++) first = d.push(1);
    assert.equal(first!.n, 0);
});

test('a 70 Hz tone does not appear below 45 Hz in the 125 Hz stream', () => {
    const y = decimate((i) => Math.sin(2 * Math.PI * 70 * i / FS), FS * 8).flatMap((b) => b.w);
    const s = spectrum(y);
    const total = s.reduce((a, b) => a + b.p, 0);
    const below45 = s.filter((b) => b.f < 45).reduce((a, b) => a + b.p, 0);
    assert.ok(10 * Math.log10(below45 / total) < -40, `below 45 Hz: ${10 * Math.log10(below45 / total)} dB`);
    // it folds to 125 - 70 = 55 Hz, above the band the piece uses
    const peak = s.reduce((a, b) => (b.p > a.p ? b : a));
    assert.ok(Math.abs(peak.f - 55) < 1, `peak at ${peak.f} Hz`);
});

test('a 10 Hz tone keeps its amplitude within 1 dB', () => {
    const y = decimate((i) => Math.sin(2 * Math.PI * 10 * i / FS), FS * 8).flatMap((b) => b.w);
    const rms = Math.sqrt(y.slice(125).reduce((a, v) => a + v * v, 0) / (y.length - 125));
    const db = 20 * Math.log10(rms / Math.SQRT1_2);
    assert.ok(Math.abs(db) < 1, `10 Hz gain ${db} dB`);
});
