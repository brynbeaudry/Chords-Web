// The guided 20 s check (plan §P6): phases, re-entry between people, and the thresholds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Calibration, CLOSED_S, TOTAL_S, MIN_SAMPLES } from './calibration';
import type { Slot } from './engine';

const HOP_MS = 128;   // the detector's hop at fs 500

/** Drive hops from `fromS` to `toS`, giving each person a fixed prominence per half. */
function run(cal: Calibration, fromS: number, toS: number, closedDb: number, openDb: number, iaf = 10) {
    for (let t = fromS * 1000; t < toS * 1000; t += HOP_MS) {
        const db = cal.elapsedS(t) < CLOSED_S ? closedDb : openDb;
        for (const slot of [1, 2] as Slot[]) cal.push(slot, db, iaf, t);
    }
}

test('starts idle and enters the eyes-closed half', () => {
    const cal = new Calibration();
    assert.equal(cal.phase, 'idle');
    assert.equal(cal.running, false);
    cal.start(0);
    assert.equal(cal.phase, 'closed');
    assert.equal(cal.running, true);
    assert.equal(cal.remainingS(0), TOTAL_S);
});

test('advances closed -> open at 10 s and done at 20 s', () => {
    const cal = new Calibration();
    cal.start(0);
    assert.equal(cal.tick(5_000), 'closed');
    assert.equal(cal.tick(10_000), 'open');
    assert.equal(cal.tick(19_900), 'open');
    assert.equal(cal.tick(20_000), 'done');
    assert.equal(cal.running, false);
    assert.equal(cal.remainingS(25_000), 0);
});

test('a full check gives ceiling = eyes-closed median, onDb = mean of the halves, offDb = onDb - 3', () => {
    const cal = new Calibration();
    cal.start(0);
    run(cal, 0, TOTAL_S, 14, 6);
    cal.tick(TOTAL_S * 1000);
    assert.equal(cal.phase, 'done');
    const r = cal.result(1);
    assert.ok(r, 'expected a result');
    assert.equal(r.ceilingDb, 14);
    assert.equal(r.closedMedianDb, 14);
    assert.equal(r.openMedianDb, 6);
    assert.equal(r.onDb, 10);        // (14 + 6) / 2
    assert.equal(r.offDb, 7);        // onDb - 3
    assert.equal(r.closedIafHz, 10);
    assert.ok(r.closedSamples >= MIN_SAMPLES && r.openSamples >= MIN_SAMPLES);
});

test('onDb never falls below 4 dB, however weak the person', () => {
    const cal = new Calibration();
    cal.start(0);
    run(cal, 0, TOTAL_S, 2, 1);
    const r = cal.result(2);
    assert.ok(r);
    assert.equal(r.onDb, 4);         // max(4, 1.5)
    assert.equal(r.offDb, 1);
    assert.equal(r.ceilingDb, 2);
});

test('the Calibrate button re-enters the check and discards the previous person', () => {
    const cal = new Calibration();
    cal.start(0);
    run(cal, 0, TOTAL_S, 14, 6);
    cal.tick(TOTAL_S * 1000);
    assert.equal(cal.phase, 'done');
    assert.equal(cal.result(1)?.ceilingDb, 14);

    // the next pair sits down and the operator calibrates again
    const t1 = 60_000;
    cal.start(t1);
    assert.equal(cal.phase, 'closed', 'start must re-enter from done');
    assert.equal(cal.result(1), null, 'the previous person must be discarded');
    run(cal, 60, 60 + TOTAL_S, 9, 3);
    cal.tick(t1 + TOTAL_S * 1000);
    assert.equal(cal.result(1)?.ceilingDb, 9);
});

test('confirming early keeps what was measured; too thin a half keeps the person uncalibrated', () => {
    const enough = new Calibration();
    enough.start(0);
    run(enough, 0, 12, 11, 5);           // 10 s closed + 2 s open
    enough.confirm(12_000);
    assert.equal(enough.phase, 'done');
    const r = enough.result(1);
    assert.ok(r, 'two seconds of eyes-open is enough');
    assert.equal(r.ceilingDb, 11);

    const thin = new Calibration();
    thin.start(0);
    run(thin, 0, 10.2, 11, 5);           // barely into the eyes-open half
    thin.confirm(10_200);
    assert.equal(thin.result(1), null, 'an eyes-open half under MIN_SAMPLES is not trusted');
});

test('dropouts are dropped, not averaged in; cancel keeps nothing', () => {
    const cal = new Calibration();
    cal.start(0);
    for (let t = 0; t < TOTAL_S * 1000; t += HOP_MS) {
        const closed = cal.elapsedS(t) < CLOSED_S;
        // every third hop has no usable channel at all
        const db = t % (HOP_MS * 3) === 0 ? NaN : (closed ? 14 : 6);
        cal.push(1, db, closed ? 10 : NaN, t);
    }
    cal.tick(TOTAL_S * 1000);
    const r = cal.result(1);
    assert.ok(r);
    assert.equal(r.ceilingDb, 14, 'NaN hops must not move the median');
    assert.equal(r.openMedianDb, 6);

    cal.cancel();
    assert.equal(cal.phase, 'idle');
    assert.equal(cal.running, false);
});

test('pushes outside a running check are ignored', () => {
    const cal = new Calibration();
    cal.push(1, 20, 10, 0);                     // idle
    assert.equal(cal.counts(1).closed, 0);
    cal.start(0);
    run(cal, 0, TOTAL_S, 14, 6);
    cal.tick(TOTAL_S * 1000);
    const after = cal.counts(1);
    cal.push(1, 99, 10, TOTAL_S * 1000 + 500);  // done
    assert.deepEqual(cal.counts(1), after, 'a hop after the check must not be recorded');
});
