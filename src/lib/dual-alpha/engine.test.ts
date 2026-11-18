// The whole path the page uses: rows -> signalChain -> DyadState -> WaveDecimator -> contract v2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DualAlphaEngine, type TdMessageV2 } from './engine';
import { synthDualRows } from '../../../tests/synth';

const KEYS = ['v', 'fs', 'n', 'd1_level', 'd1_ok', 'd2_level', 'd2_ok', 'pair_level', 'd1_w', 'd2_w'];

function run(rows: number[][], engine = new DualAlphaEngine()): [number, TdMessageV2][] {
    const out: [number, TdMessageV2][] = [];
    for (const r of rows) {
        const m = engine.ingest(r[0] === 2 ? 2 : 1, [r[4], r[5], r[6]], r[1]).message;
        if (m) out.push([r[1], m]);
    }
    return out;
}

const rows = synthDualRows(30);

test('one 10-key message per 128 ms hop, n continuous, 16 + 16 waveform samples', () => {
    const msgs = run(rows);
    const rate = (msgs.length - 1) / ((msgs.at(-1)![0] - msgs[0][0]) / 1000);
    assert.ok(Math.abs(rate - 1000 / 128) < 0.05, `rate ${rate}`);
    msgs.forEach(([, m], i) => {
        assert.deepEqual(Object.keys(m), KEYS);
        assert.equal(m.v, 2);
        assert.equal(m.fs, 125);
        assert.equal(m.n, 16 * i);
        assert.equal(m.d1_w.length, 16);
        assert.equal(m.d2_w.length, 16);
        assert.ok(m.pair_level <= Math.min(m.d1_level, m.d2_level) + 1e-9);
        if (!(m.d1_ok && m.d2_ok)) assert.equal(m.pair_level, 0);
    });
    assert.ok(msgs.some(([, m]) => m.pair_level > 0), 'the pair is together at some point');
});

test('a replay is deterministic, whatever the pace', () => {
    assert.deepEqual(run(rows), run(rows));
});

test('a device that stops turns not ok within a second; the other device keeps the messages going', () => {
    const cut = 15000;   // device 2 stops at 15 s, device 1 at 22 s
    const partial = rows.filter((r) => (r[0] === 2 ? r[1] < cut : r[1] < 22000));
    const tail = rows.filter((r) => r[0] === 2 && r[1] >= 22000).map((r) => r);   // device 2 comes back alone
    const msgs = run([...partial, ...tail]);
    const after = msgs.filter(([t]) => t > cut + 1000 && t < 22000);
    assert.ok(after.length > 0 && after.every(([, m]) => m.d2_ok === 0 && m.pair_level === 0));
    const alone = msgs.filter(([t]) => t > 25000);
    assert.ok(alone.length > 0, 'device 2 drives once device 1 has stopped');
    assert.ok(alone.every(([, m]) => m.d1_ok === 0));
    for (let i = 1; i < msgs.length; i++) assert.equal(msgs[i][1].n, msgs[i - 1][1].n + 16);
});
