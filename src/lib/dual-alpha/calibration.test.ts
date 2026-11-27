// The guided 15 s check (plan §P6): phases, the settling time each one discards, the blink
// liveness check, re-entry between people, and the thresholds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    Calibration, PHASE_S, SETTLE_S, BLINK_S, CLOSED_S, TOTAL_S, MIN_SAMPLES, LIVENESS_SHARE,
} from './calibration';
import type { Slot } from './engine';

const HOP_MS = 128;   // the detector's hop at fs 500

/** Which phase a given elapsed time belongs to. */
function phaseAt(s: number): 'blink' | 'closed' | 'open' {
    if (s < BLINK_S) return 'blink';
    if (s < BLINK_S + CLOSED_S) return 'closed';
    return 'open';
}

/**
 * Drive hops from `fromS` to `toS`, giving each person a prominence per phase. `blinking`
 * marks the blink phase's hops as artifacts, which is what a person actually blinking does.
 */
function run(
    cal: Calibration, fromS: number, toS: number,
    db: { blink: number; closed: number; open: number }, iaf = 10, blinking = true,
) {
    for (let t = fromS * 1000; t < toS * 1000; t += HOP_MS) {
        const ph = phaseAt(cal.elapsedS(t));
        for (const slot of [1, 2] as Slot[]) cal.push(slot, db[ph], iaf, t, ph === 'blink' && blinking);
    }
}

const DB = { blink: 6, closed: 14, open: 6 };

test('starts idle and enters the blink phase', () => {
    const cal = new Calibration();
    assert.equal(cal.phase, 'idle');
    assert.equal(cal.running, false);
    cal.start(0);
    assert.equal(cal.phase, 'blink');
    assert.equal(cal.running, true);
    assert.equal(cal.remainingS(0), TOTAL_S);
    assert.equal(cal.phaseRemainingS(0), BLINK_S);
});

test('advances blink -> closed -> open at each phase boundary, done at the end', () => {
    const cal = new Calibration();
    cal.start(0);
    assert.equal(cal.tick(1_000), 'blink');
    assert.equal(cal.tick(PHASE_S * 1000), 'closed');
    assert.equal(cal.tick(2 * PHASE_S * 1000 - 100), 'closed');
    assert.equal(cal.tick(2 * PHASE_S * 1000), 'open');
    assert.equal(cal.tick(TOTAL_S * 1000 - 100), 'open');
    assert.equal(cal.tick(TOTAL_S * 1000), 'done');
    assert.equal(cal.running, false);
    assert.equal(cal.remainingS(TOTAL_S * 1000 + 5_000), 0);
    assert.equal(TOTAL_S, 15, 'three 5 s phases');
});

test('each phase discards its settling time, so a median is only about that phase', () => {
    // The detector's prominence is a trailing 2 s average, so a reading taken sooner than
    // that after an instruction is partly measuring the previous phase. Those are dropped.
    const cal = new Calibration();
    cal.start(0);
    for (let t = 0; t < PHASE_S * 1000; t += HOP_MS) cal.push(1, 6, 10, t, true);
    const recorded = cal.counts(1).blink;
    const total = Math.ceil((PHASE_S * 1000) / HOP_MS);
    assert.ok(recorded > 0, 'something must be recorded');
    assert.ok(recorded < total, 'but not the settling hops');
    assert.ok(recorded >= MIN_SAMPLES * 3, `${recorded} hops is plenty for a median`);
    assert.equal(cal.settling(0), true, 'settling at the start of a phase');
    assert.equal(cal.settling(SETTLE_S * 1000 + 100), false, 'recording after that');

    // A reading that belongs to the previous instruction must not reach the next median: here
    // the closed phase opens with two seconds of the old eyes-open value.
    const cal2 = new Calibration();
    cal2.start(0);
    for (let t = PHASE_S * 1000; t < 2 * PHASE_S * 1000; t += HOP_MS) {
        const intoPhase = t / 1000 - PHASE_S;
        cal2.push(1, intoPhase < SETTLE_S ? 6 : 14, 10, t);
    }
    for (let t = 2 * PHASE_S * 1000; t < TOTAL_S * 1000; t += HOP_MS) cal2.push(1, 6, 10, t);
    cal2.tick(TOTAL_S * 1000);
    const r2 = cal2.result(1);
    assert.ok(r2);
    assert.equal(r2.ceilingDb, 14, 'the stale 6 dB readings were dropped, not averaged in');
});

test('a full check gives ceiling = eyes-closed median, onDb = mean of the two alpha phases', () => {
    const cal = new Calibration();
    cal.start(0);
    run(cal, 0, TOTAL_S, DB);
    cal.tick(TOTAL_S * 1000);
    assert.equal(cal.phase, 'done');
    const r = cal.result(1);
    assert.ok(r, 'expected a result');
    assert.equal(r.ceilingDb, 14);
    assert.equal(r.closedMedianDb, 14);
    assert.equal(r.openMedianDb, 6, 'from the final still phase, not the blinking one');
    assert.equal(r.onDb, 10);        // (14 + 6) / 2
    assert.equal(r.offDb, 7);        // onDb - 3
    assert.equal(r.closedIafHz, 10);
    assert.ok(r.closedSamples >= MIN_SAMPLES && r.openSamples >= MIN_SAMPLES);
});

test('the blink phase is a liveness check: seen, and not seen', () => {
    const seen = new Calibration();
    seen.start(0);
    run(seen, 0, TOTAL_S, DB, 10, true);
    seen.tick(TOTAL_S * 1000);
    const a = seen.result(1);
    assert.ok(a);
    assert.equal(a.liveness, true);
    assert.ok(a.blinkArtifactShare >= LIVENESS_SHARE);

    // The same person, same alpha, but the electrode never reacted to the blinks. The
    // thresholds are still returned -- the check never refuses -- but flagged, because an
    // electrode that cannot see a blink is not making contact, and anything it measured
    // after that was measured off noise.
    const blind = new Calibration();
    blind.start(0);
    run(blind, 0, TOTAL_S, DB, 10, false);
    blind.tick(TOTAL_S * 1000);
    const b = blind.result(1);
    assert.ok(b, 'a missed blink check must not throw the calibration away');
    assert.equal(b.liveness, false);
    assert.equal(b.blinkArtifactShare, 0);
    assert.equal(b.ceilingDb, 14, 'the alpha phases are unaffected');
});

test('liveness is reported live, per person, while the check runs', () => {
    const cal = new Calibration();
    cal.start(0);
    assert.equal(cal.liveness(1), false, 'nothing recorded yet');
    // Person 1 blinks; person 2's electrode sees nothing.
    for (let t = 0; t < BLINK_S * 1000; t += HOP_MS) {
        cal.push(1, 6, 10, t, true);
        cal.push(2, 6, 10, t, false);
    }
    assert.equal(cal.liveness(1), true);
    assert.equal(cal.liveness(2), false);
    assert.ok(cal.counts(1).blinkArtifacts > 0);
    assert.equal(cal.counts(2).blinkArtifacts, 0);
});

test('onDb never falls below 4 dB, however weak the person', () => {
    const cal = new Calibration();
    cal.start(0);
    run(cal, 0, TOTAL_S, { blink: 1, closed: 2, open: 1 });
    const r = cal.result(2);
    assert.ok(r);
    assert.equal(r.onDb, 4);         // max(4, 1.5)
    assert.equal(r.offDb, 1);
    assert.equal(r.ceilingDb, 2);
});

test('the Calibrate button re-enters the check and discards the previous person', () => {
    const cal = new Calibration();
    cal.start(0);
    run(cal, 0, TOTAL_S, DB);
    cal.tick(TOTAL_S * 1000);
    assert.equal(cal.phase, 'done');
    assert.equal(cal.result(1)?.ceilingDb, 14);

    // the next pair sits down and the operator calibrates again
    const t1 = 60_000;
    cal.start(t1);
    assert.equal(cal.phase, 'blink', 'start must re-enter from the blinks');
    assert.equal(cal.result(1), null, 'the previous person must be discarded');
    assert.equal(cal.counts(1).blinkArtifacts, 0);
    run(cal, 60, 60 + TOTAL_S, { blink: 3, closed: 9, open: 3 });
    cal.tick(t1 + TOTAL_S * 1000);
    assert.equal(cal.result(1)?.ceilingDb, 9);
});

test('confirming early keeps what was measured; too thin a phase keeps the person uncalibrated', () => {
    // The whole check bar the last second of the still phase: past its settle, so usable.
    const enough = new Calibration();
    enough.start(0);
    run(enough, 0, TOTAL_S - 1, DB);
    enough.confirm((TOTAL_S - 1) * 1000);
    assert.equal(enough.phase, 'done');
    const r = enough.result(1);
    assert.ok(r, 'the still phase got past its settling time, so it counts');
    assert.equal(r.ceilingDb, 14);

    // Stopped inside the still phase's settling time: nothing was recorded for it.
    const thin = new Calibration();
    thin.start(0);
    run(thin, 0, 2 * PHASE_S + SETTLE_S - 0.5, DB);
    thin.confirm((2 * PHASE_S + SETTLE_S - 0.5) * 1000);
    assert.equal(thin.counts(1).open, 0, 'the settling hops are not recorded');
    assert.equal(thin.result(1), null, 'a final phase under MIN_SAMPLES is not trusted');

    // Stopping before the eyes-closed phase has run leaves nothing to measure a ceiling from.
    const early = new Calibration();
    early.start(0);
    run(early, 0, PHASE_S - 0.5, DB);
    early.confirm((PHASE_S - 0.5) * 1000);
    assert.equal(early.result(1), null);
});

test('dropouts are dropped, not averaged in; cancel keeps nothing', () => {
    const cal = new Calibration();
    cal.start(0);
    for (let t = 0; t < TOTAL_S * 1000; t += HOP_MS) {
        const ph = phaseAt(cal.elapsedS(t));
        // every third hop has no usable channel at all
        const db = t % (HOP_MS * 3) === 0 ? NaN : DB[ph];
        cal.push(1, db, ph === 'closed' ? 10 : NaN, t, ph === 'blink');
    }
    cal.tick(TOTAL_S * 1000);
    const r = cal.result(1);
    assert.ok(r);
    assert.equal(r.ceilingDb, 14, 'NaN hops must not move the median');
    assert.equal(r.openMedianDb, 6);
    assert.equal(r.liveness, true, 'a dropped prominence still counts as a hop for liveness');

    cal.cancel();
    assert.equal(cal.phase, 'idle');
    assert.equal(cal.running, false);
});

test('pushes outside a running check are ignored', () => {
    const cal = new Calibration();
    cal.push(1, 20, 10, 0);                     // idle
    assert.equal(cal.counts(1).blink, 0);
    cal.start(0);
    run(cal, 0, TOTAL_S, DB);
    cal.tick(TOTAL_S * 1000);
    const after = cal.counts(1);
    cal.push(1, 99, 10, TOTAL_S * 1000 + 500);  // done
    assert.deepEqual(cal.counts(1), after, 'a hop after the check must not be recorded');
});

test('one person calibrates on their own when the other device is not connected', () => {
    const cal = new Calibration();
    cal.start(0);
    // only person 1 is streaming: nothing is ever pushed for slot 2
    for (let t = 0; t < TOTAL_S * 1000; t += HOP_MS) {
        const ph = phaseAt(cal.elapsedS(t));
        cal.push(1, ph === 'closed' ? 13 : 5, 10, t, ph === 'blink');
    }
    cal.tick(TOTAL_S * 1000);
    const r1 = cal.result(1);
    assert.ok(r1, 'person 1 must calibrate with no second device present');
    assert.equal(r1.ceilingDb, 13);
    assert.equal(r1.liveness, true);
    assert.equal(cal.result(2), null, 'person 2 stays uncalibrated rather than blocking person 1');
    assert.deepEqual(cal.counts(2), { blink: 0, closed: 0, open: 0, blinkArtifacts: 0 });
    assert.equal(cal.liveness(2), false);
});
