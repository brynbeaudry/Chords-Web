// The operator settings: defaults, the stored value, and the old query parameters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_SETTINGS, normalise, loadSettings, qualityLimitsFor, saveSettings, clearSettings,
} from './settings';

test('mains pickup does not reject an electrode by default', () => {
    // The 50 µV limit was measured against the previous detector. Left on, it stops a person
    // showing good alpha from ever reaching `ok` in a noisy room, which greys their side of
    // the projection out for the whole piece.
    assert.equal(DEFAULT_SETTINGS.mainsRedEnabled, false);
    assert.equal(qualityLimitsFor(DEFAULT_SETTINGS).mainsRedUv, 0, '0 means never red on mains');
    assert.equal(qualityLimitsFor(DEFAULT_SETTINGS).artifactShareRed, 0.5);

    // Switching it on uses the limit beside it.
    const on = { ...DEFAULT_SETTINGS, mainsRedEnabled: true, mainsRedUv: 120 };
    assert.equal(qualityLimitsFor(on).mainsRedUv, 120);
});

test('all three electrodes are in use by default', () => {
    assert.equal(DEFAULT_SETTINGS.chans, 3);
});

test('a stored value that is wrong or hostile falls back to the default', () => {
    assert.deepEqual(normalise(null), DEFAULT_SETTINGS);
    assert.deepEqual(normalise({}), DEFAULT_SETTINGS);
    assert.equal(normalise({ chans: 99 }).chans, 3, 'out of range: back to the default');
    assert.equal(normalise({ chans: 0 }).chans, 3);
    assert.equal(normalise({ chans: 2.4 }).chans, 2, 'in range, rounded');
    // Out of range falls back rather than clamping. A stored 0 clamped to the bottom of the
    // range would silently become the strictest setting there is.
    assert.equal(normalise({ artifactRed: 5 }).artifactRed, 0.5);
    assert.equal(normalise({ artifactRed: 0 }).artifactRed, 0.5);
    assert.equal(normalise({ artifactRed: 0.8 }).artifactRed, 0.8);
    assert.equal(normalise({ mainsRedUv: -10 }).mainsRedUv, 50);
    // @ts-expect-error -- what a hand-edited localStorage entry can look like
    assert.equal(normalise({ mainsRedEnabled: 'yes' }).mainsRedEnabled, false);
});

test('the old query parameters still override, and ?mainsred=0 still means off', () => {
    assert.equal(loadSettings('?chans=1').chans, 1);
    assert.equal(loadSettings('?artifact=0.8').artifactRed, 0.8);

    const off = loadSettings('?mainsred=0');
    assert.equal(off.mainsRedEnabled, false);

    const on = loadSettings('?mainsred=120');
    assert.equal(on.mainsRedEnabled, true);
    assert.equal(on.mainsRedUv, 120);

    // No parameter: the defaults, not an accidental reset of something else.
    assert.deepEqual(loadSettings(''), DEFAULT_SETTINGS);
});

test('a stored setting survives a reload, and a parameter beats it for that load', () => {
    // A minimal localStorage, since this runs in node.
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    };
    try {
        saveSettings({ ...DEFAULT_SETTINGS, chans: 1, artifactRed: 0.9 });
        const back = loadSettings('');
        assert.equal(back.chans, 1, 'a reload keeps what the operator chose');
        assert.equal(back.artifactRed, 0.9);

        assert.equal(loadSettings('?chans=3').chans, 3, 'the address wins for this load');

        clearSettings();
        assert.deepEqual(loadSettings(''), DEFAULT_SETTINGS);
    } finally {
        delete (globalThis as { localStorage?: unknown }).localStorage;
    }
});
