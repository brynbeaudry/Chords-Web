// Regenerates tests/fixtures/alpha_synthetic.json from the REFERENCE detector
// (docs/alpha-v2/analysis/SpectralAlphaDetector.ts, verified against the Python reference).
//   node --import ./scripts/ts-hooks.mjs tests/make-alpha-fixture.ts
// The app's detector (src/components/SpectralAlphaDetector.ts) is then tested against it.
// The real-recording fixture of the plan (alpha_s03_oz.json) needs the open dataset and
// numpy; this one uses the deterministic synthetic signals of tests/synth.ts instead.
import { writeFileSync, mkdirSync } from 'node:fs';
import { SpectralAlphaDetector } from '../docs/alpha-v2/analysis/SpectralAlphaDetector';
import { HighPassFilter } from '../src/components/filters';
import { FIXTURE_SIGNALS, FS, synthCounts } from './synth';

const PARAMS = { onDb: 5, offDb: 2, nOn: 2, nOff: 3, win: 1000, maxHoldHops: 24 };

const out: Record<string, unknown> = { generatedBy: 'tests/make-alpha-fixture.ts', params: PARAMS, signals: {} };
for (const [name, opts] of Object.entries(FIXTURE_SIGNALS)) {
    const counts = synthCounts(opts);
    const hp = new HighPassFilter();
    hp.setSamplingRate(FS);
    const det = new SpectralAlphaDetector(FS, PARAMS);
    const hops: number[][] = [];
    for (let i = 0; i < counts.length; i++) {
        const r = det.push(hp.process(counts[i]), counts[i]);
        if (r) hops.push([r.promDb, r.iafHz, r.artifact ? 1 : 0, r.isAlpha ? 1 : 0]);
    }
    (out.signals as Record<string, unknown>)[name] = { options: opts, hops };
    console.log(name, hops.length, 'hops');
}
mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
writeFileSync(new URL('./fixtures/alpha_synthetic.json', import.meta.url), JSON.stringify(out));
