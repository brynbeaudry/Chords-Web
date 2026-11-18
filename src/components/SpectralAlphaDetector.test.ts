// P1: the app's detector against the reference implementation, plus the new fields.
//   npm test   (node --test with scripts/ts-hooks.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SpectralAlphaDetector, DEFAULT_ALPHA_PARAMS, type AlphaReading } from './SpectralAlphaDetector';
import { HighPassFilter } from './filters';
import { FIXTURE_SIGNALS, FS, eyesClosedAt, synthCounts, type SynthOptions } from '../../tests/synth';

interface Fixture { params: Record<string, number>; signals: Record<string, { options: SynthOptions; hops: number[][] }> }
const fixture: Fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/alpha_synthetic.json', import.meta.url), 'utf8'));

/** Runs a detector over counts, through the app's 1 Hz high-pass. Returns [sampleIndex, reading] per hop. */
function run(counts: Float64Array, params = {}): [number, AlphaReading][] {
    const hp = new HighPassFilter();
    hp.setSamplingRate(FS);
    const det = new SpectralAlphaDetector(FS, params);
    const out: [number, AlphaReading][] = [];
    for (let i = 0; i < counts.length; i++) {
        const r = det.push(hp.process(counts[i]), counts[i]);
        if (r) out.push([i, r]);
    }
    return out;
}

const frac = (xs: boolean[]) => xs.filter(Boolean).length / Math.max(1, xs.length);

test('defaults are the tuned parameters: ON 5 dB / 2 hops, OFF 2 dB / 3 hops', () => {
    assert.equal(DEFAULT_ALPHA_PARAMS.onDb, 5);
    assert.equal(DEFAULT_ALPHA_PARAMS.offDb, 2);
    assert.equal(DEFAULT_ALPHA_PARAMS.nOn, 2);
    assert.equal(DEFAULT_ALPHA_PARAMS.nOff, 3);
    assert.equal(new SpectralAlphaDetector(FS).binCount, 43);
});

for (const [name, opts] of Object.entries(FIXTURE_SIGNALS)) {
    test(`matches the reference detector hop for hop: ${name}`, () => {
        const ref = fixture.signals[name].hops;
        const got = run(synthCounts(opts), fixture.params);
        assert.equal(got.length, ref.length);
        let maxDiff = 0;
        got.forEach(([, r], k) => {
            maxDiff = Math.max(maxDiff, Math.abs(r.promDb - ref[k][0]));
            assert.equal(r.iafHz, ref[k][1], `iaf at hop ${k}`);
            assert.equal(r.artifact ? 1 : 0, ref[k][2], `artifact at hop ${k}`);
            assert.equal(r.isAlpha ? 1 : 0, ref[k][3], `state at hop ${k}`);
        });
        assert.ok(maxDiff < 1e-4, `max promDb difference ${maxDiff} dB`);
    });
}

test('sane: alpha in eyes-closed blocks, little in eyes-open', () => {
    const hops = run(synthCounts(FIXTURE_SIGNALS.alpha));
    // judge from 3 s into each block (2 s window + confirmation)
    const settled = hops.filter(([i]) => (i / FS) % 10 >= 3);
    const ec = frac(settled.filter(([i]) => eyesClosedAt(i)).map(([, r]) => r.isAlpha));
    const eo = frac(settled.filter(([i]) => !eyesClosedAt(i)).map(([, r]) => r.isAlpha));
    assert.ok(ec > 0.8, `eyes closed flagged ${ec}`);
    assert.ok(eo < 0.1, `eyes open flagged ${eo}`);
    const iaf = settled.filter(([i, r]) => eyesClosedAt(i) && r.isAlpha).map(([, r]) => r.iafHz);
    assert.ok(iaf.every((f) => f >= 9 && f <= 11), 'peak frequency near 10 Hz');
});

test('sane: mains hum and pure noise are not alpha', () => {
    const mains = run(synthCounts(FIXTURE_SIGNALS.mains));
    assert.ok(frac(mains.map(([, r]) => r.isAlpha)) <= 0.02, 'mains');
    const noise = run(synthCounts(FIXTURE_SIGNALS.noise));
    // white ADC-level noise: measured 2.6 % here (the plan's 0.4 % is on its own noise model)
    const fa = frac(noise.map(([, r]) => r.isAlpha));
    assert.ok(fa <= 0.05, `noise ${fa}`);
});

test('sane: a railed electrode is an artifact and forces the flag off within ~3.2 s', () => {
    const o = FIXTURE_SIGNALS.railed;
    const hops = run(synthCounts(o));
    const from = o.railFromS! * FS, to = (o.railFromS! + o.railForS!) * FS;
    const during = hops.filter(([i]) => i >= from + 2 * 64 && i < to);
    assert.ok(during.every(([, r]) => r.artifact), 'artifact throughout the rail');
    assert.ok(hops.some(([i, r]) => i > from - FS && i < from && r.isAlpha), 'in alpha just before');
    const firstOff = hops.find(([i, r]) => i >= from && !r.isAlpha);
    assert.ok(firstOff && (firstOff[0] - from) / FS < 3.5, `forced off after ${firstOff && (firstOff[0] - from) / FS} s`);
});

test('hfDb: about 0 dB on a 1/f background, high with added broadband (muscle-like) noise; slope about -1', () => {
    const pink = run(synthCounts({ seconds: 20, seed: 21, pinkCounts: 40 }));
    const hfPink = median(pink.map(([, r]) => r.hfDb));
    const slope = median(pink.map(([, r]) => r.slope));
    assert.ok(Math.abs(hfPink) < 2, `pink hfDb ${hfPink}`);
    assert.ok(slope < -0.6 && slope > -1.4, `pink slope ${slope}`);
    const tense = run(synthCounts({ seconds: 20, seed: 21, pinkCounts: 40, emgCounts: 100 }));
    const hfTense = median(tense.map(([, r]) => r.hfDb));
    assert.ok(hfTense > hfPink + 3, `muscle hfDb ${hfTense} vs ${hfPink}`);
});

test('deterministic: the same samples give the same readings', () => {
    const c = synthCounts({ seconds: 10, seed: 5, pinkCounts: 40, alphaCounts: 30 });
    assert.deepEqual(run(c), run(c));
});

function median(a: number[]): number {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
}
