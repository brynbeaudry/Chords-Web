// The whole path the page uses: rows -> signalChain -> DyadState -> WaveDecimator -> contract v2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DualAlphaEngine, MAIN_CHANNEL, type TdMessageV2 } from './engine';
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

test('the waveform sent to TouchDesigner falls back off a dead electrode', () => {
    const engine = new DualAlphaEngine();
    assert.equal(engine.waveChannel(1), MAIN_CHANNEL, 'Oz is the preferred electrode');

    // The operator switches Oz out: the next usable one takes over rather than TD being fed
    // a channel nobody is looking at.
    engine.excluded[1].add(MAIN_CHANNEL);
    const after = engine.waveChannel(1);
    assert.notEqual(after, MAIN_CHANNEL);
    assert.ok(!engine.excluded[1].has(after));

    // It does not drift back while the new choice is still fine -- a switch is a step in the
    // waveform, and a step is a visible jolt on the projection.
    engine.excluded[1].delete(MAIN_CHANNEL);
    assert.equal(engine.waveChannel(1), after, 'no re-pick while the current electrode works');

    // With every electrode switched out there is nothing better, so it keeps what it had.
    engine.excluded[1].add(0);
    engine.excluded[1].add(1);
    engine.excluded[1].add(2);
    assert.equal(engine.waveChannel(1), after);

    // reset() puts the preference back, so a reconnect starts from Oz again.
    engine.excluded[1].clear();
    engine.reset(1);
    assert.equal(engine.waveChannel(1), MAIN_CHANNEL);

    // The other device is unaffected throughout.
    assert.equal(engine.waveChannel(2), MAIN_CHANNEL);
});

test("a 20 s check sets that person's own thresholds, not everybody's", () => {
    const engine = new DualAlphaEngine();
    assert.equal(engine.chains[1].detectorParams.onDb, 5, 'the default entry level');
    assert.equal(engine.chains[2].detectorParams.onDb, 5);

    // Someone on a weak montage: their eyes-closed alpha barely clears 4 dB, so the fixed
    // 5 dB entry would never fire for them.
    engine.setCalibration(1, 6.5, 4.0, 1.0);
    assert.equal(engine.chains[1].detectorParams.onDb, 4.0);
    assert.equal(engine.chains[1].detectorParams.offDb, 1.0);
    assert.equal(engine.ceilingDb[1], 6.5);

    assert.equal(engine.chains[2].detectorParams.onDb, 5, 'the other person is untouched');
    assert.equal(engine.ceilingDb[2], undefined);

    // Their thresholds survive a reset: a reconnect must not silently put them back on the
    // default after the operator has already run their check.
    engine.reset(1);
    assert.equal(engine.chains[1].detectorParams.onDb, 4.0);
    assert.equal(engine.chains[1].detectorParams.offDb, 1.0);
});

test('railing is reported with enough detail to tell a knock from a pinned input', () => {
    // Pinned against the high rail: a bad reference or ground, not a knock.
    const pinned = new DualAlphaEngine({ fs: 500 });
    for (let i = 0; i < 1600; i++) pinned.ingest(1, [4095, 2048, 2048], i * 2);
    const p = pinned.chains[1].status[0];
    assert.ok(p.reading, 'the 2 s window should have filled');
    assert.equal(p.railed, true);
    assert.equal(p.railSide, 'high');
    assert.equal(p.railShare, 1, 'every sample was against the rail');
    assert.equal(p.rawMax, 4095);
    assert.equal(p.quality, 'red');

    // A healthy channel in the same device is untouched.
    assert.equal(pinned.chains[1].status[1].railed, false);
    assert.equal(pinned.chains[1].status[1].railSide, '');

    // An occasional knock: railed, but a small share, which reads as a cable rather than a
    // reference problem.
    const knocked = new DualAlphaEngine({ fs: 500 });
    for (let i = 0; i < 1600; i++) {
        knocked.ingest(1, [i % 50 === 0 ? 4095 : 2048 + (i % 7), 2048, 2048], i * 2);
    }
    const k = knocked.chains[1].status[0];
    assert.equal(k.railed, true);
    assert.ok(k.railShare > 0 && k.railShare < 0.2, `expected a small share, got ${k.railShare}`);

    // A channel the device never sends is absent, not railed. It used to read as `?? 0`,
    // which is the low rail, so it looked like a dead electrode all session.
    const short = new DualAlphaEngine({ fs: 500 });
    for (let i = 0; i < 1600; i++) short.ingest(1, [2048 + (i % 5)], i * 2);
    const a = short.chains[1].status[2];
    assert.equal(a.absent, true);
    assert.equal(a.railed, false, 'an unreported channel must not be called railed');
    assert.equal(a.quality, 'none');
    assert.equal(short.chains[1].status[0].absent, false);
});


test('the reading electrode is the first usable input, and the rest cannot claim alpha', () => {
    // Why this matters: every channel on this board is measured against the same reference
    // electrode, so whatever the reference picks up appears in all of them — and the detector
    // is scale-free, reporting prominence in dB over each channel's own background. A faint
    // copy of a signal containing alpha therefore reports the *same* prominence as the
    // original, which is why an input with no electrode of its own can show a green alpha
    // flag. Only the reading electrode is allowed to mean anything.
    const engine = new DualAlphaEngine({ fs: 500 });
    assert.equal(engine.readingChannel(1), 0, 'the positive, O1');

    engine.excluded[1].add(0);
    assert.equal(engine.readingChannel(1), 1, 'switching it out promotes the next input');

    engine.excluded[1].add(1);
    engine.excluded[1].add(2);
    assert.equal(engine.readingChannel(1), MAIN_CHANNEL, 'with none left, back to the preferred one');

    engine.excluded[1].clear();
    assert.equal(engine.readingChannel(2), 0, 'and it is per device');
});
