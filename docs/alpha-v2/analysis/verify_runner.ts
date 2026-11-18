// Runs SpectralAlphaDetector over a signal dumped by verify_ts.py and prints its readings as JSON.
import { readFileSync } from 'node:fs';
import { SpectralAlphaDetector } from './SpectralAlphaDetector.ts';

const [, , path, paramsJson] = process.argv;
const buf = readFileSync(path);
const n = buf.length / 16;
const hp = new Float64Array(buf.buffer, buf.byteOffset, n);
const raw = new Float64Array(buf.buffer, buf.byteOffset + n * 8, n);
const det = new SpectralAlphaDetector(500, JSON.parse(paramsJson));
const out: number[][] = [];
const t0 = performance.now();
for (let i = 0; i < n; i++) {
    const r = det.push(hp[i], raw[i]);
    if (r) out.push([r.promDb, r.iafHz, r.artifact ? 1 : 0, r.isAlpha ? 1 : 0]);
}
const ms = performance.now() - t0;
console.log(JSON.stringify({ out, msPerSecondOfSignal: ms / (n / 500) }));
