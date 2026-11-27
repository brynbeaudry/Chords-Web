// Per-person eyes-open / eyes-closed mode, and the thresholds it chooses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODE_PRESET, HYSTERESIS_DB, enterDbFor, thresholdsFor } from './alphaMode';
import type { PersonCalibration } from './calibration';

const cal = (closed: number, open: number): PersonCalibration => ({
    ceilingDb: closed,
    onDb: Math.max(4, (closed + open) / 2),
    offDb: Math.max(4, (closed + open) / 2) - 3,
    closedMedianDb: closed,
    openMedianDb: open,
    closedIafHz: 10,
    closedSamples: 20,
    openSamples: 20,
    blinkSamples: 20,
    blinkArtifactShare: 0.4,
    liveness: true,
});

test('eyes open sits lower than eyes closed, calibrated or not', () => {
    assert.ok(MODE_PRESET.open < MODE_PRESET.closed);
    assert.equal(enterDbFor('closed', null), MODE_PRESET.closed);
    assert.equal(enterDbFor('open', null), MODE_PRESET.open);

    const c = cal(14, 6);
    assert.ok(enterDbFor('open', c) < enterDbFor('closed', c));
});

test('calibrated eyes-open sits just above that person own measured eyes-open baseline', () => {
    // The whole point of the mode: at the eyes-closed midpoint they would have to shut their
    // eyes to reach it, which is the thing eyes-open mode exists to avoid.
    const c = cal(14, 6);
    assert.equal(enterDbFor('closed', c), 10);      // (14 + 6) / 2
    assert.equal(enterDbFor('open', c), 7);         // 6 + 1, reachable with the eyes open
});

test('a very weak person still gets a threshold above the background', () => {
    const weak = cal(2, 0.2);
    assert.ok(enterDbFor('open', weak) >= 1.5, 'never low enough to fire on the background itself');
});

test('the exit level always follows the entry level by the shared hysteresis', () => {
    for (const mode of ['closed', 'open'] as const) {
        for (const c of [null, cal(14, 6), cal(3, 1)]) {
            const t = thresholdsFor(mode, c);
            assert.equal(t.offDb, t.onDb - HYSTERESIS_DB);
        }
    }
});
