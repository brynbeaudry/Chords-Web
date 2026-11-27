import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelQuality, dyadState, personState, levelFromProm, setQualityLimits, type ChannelInput, type PersonInput } from './DyadState';

const ch = (isAlpha: boolean, promDb = isAlpha ? 8 : 1, extra: Partial<ChannelInput> = {}): ChannelInput =>
    ({ included: true, quality: 'green', isAlpha, promDb, ...extra });
const person = (channels: ChannelInput[], extra: Partial<PersonInput> = {}): PersonInput =>
    ({ channels, msSinceLastSample: 10, ...extra });

test('the reading electrode decides on its own: no vote between electrodes', () => {
    // One differential channel -- the positive plus a reference and a ground -- so the first
    // included, non-red input is the only one that can say anything. It used to take half the
    // usable electrodes to agree, which meant one real electrode beside two floating ones
    // (one of three) sent nothing at all while showing clear alpha on the chip.
    assert.equal(personState(person([ch(true), ch(false), ch(false)])).inAlpha, true);
    assert.equal(personState(person([ch(false), ch(true), ch(true)])).inAlpha, false,
        'the other inputs cannot outvote it either way');

    // And it is the reading electrode's prominence that scales `level`, not a median.
    const only = personState(person([ch(true, 7), ch(true, 13), ch(true, 13)]));
    assert.equal(only.medianPromDb, 7);
});

test('a floating input beside the reading electrode no longer costs the person', () => {
    const red = { quality: 'red' as const };
    // Two inputs with nothing on them float and go red. That is the open wire, not the
    // person: they must not drag the reading electrode's owner to not ok.
    const withRed = personState(person([ch(true), ch(false, 1, red), ch(false, 1, red)]));
    assert.equal(withRed.inAlpha, true);
    assert.equal(withRed.ok, true);
    assert.ok(withRed.level > 0, 'and the level reaches TouchDesigner');
    assert.equal(withRed.usable, 1);

    // The reading electrode itself going red is a real fault, and still is one.
    const readerRed = personState(person([ch(true, 8, red), ch(false), ch(false)]));
    assert.equal(readerRed.ok, true, 'the next usable input takes over as the reader');
    assert.equal(readerRed.inAlpha, false, 'and it is not seeing alpha');
    const allRed = personState(person([ch(true, 8, red), ch(false, 1, red), ch(false, 1, red)]));
    assert.equal(allRed.ok, false);
    assert.equal(allRed.level, 0);
});

test('ok is lost when the device stops, when every channel is excluded, or when none has a reading yet', () => {
    assert.equal(personState(person([ch(true), ch(true), ch(true)], { msSinceLastSample: 1500 })).ok, false);
    assert.equal(personState(person([ch(true, 8, { included: false })])).ok, false);
    assert.equal(personState(person([ch(false, 0, { quality: 'none' })])).ok, false);
    assert.equal(personState(person([ch(true), ch(true), ch(true, 8, { quality: 'amber' })])).ok, true);
});

test('level: uncalibrated uses a 12 dB ceiling, calibrated uses the person ceiling, 0 when out of alpha', () => {
    const p = [ch(true, 7), ch(true, 7), ch(false, 1)];      // the reader reads 7 dB
    const uncal = personState(person(p));
    assert.equal(uncal.calibrated, false);
    assert.ok(Math.abs(uncal.level - (7 - 2) / (12 - 2)) < 1e-12);
    const cal = personState(person(p, { ceilingDb: 8 }));
    assert.equal(cal.calibrated, true);
    assert.ok(Math.abs(cal.level - (7 - 2) / (8 - 2)) < 1e-12);
    assert.equal(personState(person([ch(false), ch(false), ch(true)])).level, 0);
    // clamped to 0.05 .. 1
    assert.equal(levelFromProm(2.1, 2, 12), 0.05);
    assert.equal(levelFromProm(30, 2, 12), 1);
    // ?enter=4 moves the exit level to 1 dB
    assert.ok(Math.abs(personState(person(p), { offDb: 1, defaultCeilingDb: 12, staleMs: 1000 }).level - 6 / 11) < 1e-12);
});

test('pair_level is the lower level, and 0 unless both are ok', () => {
    const deep = person([ch(true, 11), ch(true, 11), ch(true, 11)]);
    const light = person([ch(true, 4), ch(true, 4), ch(false, 1)]);
    const both = dyadState(deep, light);
    assert.equal(both.pairLevel, Math.min(both.d1.level, both.d2.level));
    assert.ok(both.pairLevel > 0);
    assert.equal(dyadState(deep, { ...light, msSinceLastSample: 5000 }).pairLevel, 0);
    assert.equal(dyadState(deep, person([ch(false), ch(false), ch(false)])).pairLevel, 0);
});

test('channel quality: mains amber above 20 µV, red above 50; railed red; artifact share red above half', () => {
    const base = { hasReading: true, mainsUv: 5, railed: false, artifactShare: 0 };
    assert.equal(channelQuality(base), 'green');
    assert.equal(channelQuality({ ...base, mainsUv: 25 }), 'amber');
    assert.equal(channelQuality({ ...base, mainsUv: 55 }), 'red');
    assert.equal(channelQuality({ ...base, railed: true }), 'red');
    assert.equal(channelQuality({ ...base, artifactShare: 0.6 }), 'red');
    assert.equal(channelQuality({ ...base, hasReading: false }), 'none');
});

test('mains can be stopped from forcing not ok, and it applies to both people alike', () => {
    const base = { hasReading: true, mainsUv: 0, railed: false, artifactShare: 0 };
    const noisy = { ...base, mainsUv: 120 };
    assert.equal(channelQuality(noisy), 'red', 'the default limit rejects it');

    // A room with a lot of mains pickup, where the signal is otherwise fine: without this a
    // person showing clear alpha can never reach `ok`, so their side stays grey all show.
    try {
        setQualityLimits({ mainsRedUv: 0 });
        assert.equal(channelQuality(noisy), 'amber', 'still warned, no longer rejected');
        assert.equal(channelQuality({ ...noisy, railed: true }), 'red', 'railing still rejects');
        assert.equal(channelQuality({ ...noisy, artifactShare: 0.9 }), 'red', 'restless still rejects');

        // The limits live in one place, so a person built from these channels is ok on either
        // side. Nothing here is per-slot.
        const person = (mainsUv: number): PersonInput => ({
            channels: [{ included: true, quality: channelQuality({ ...base, mainsUv }), isAlpha: true, promDb: 8 }],
            msSinceLastSample: 0,
        });
        const d = dyadState(person(120), person(120));
        assert.equal(d.d1.ok, true);
        assert.equal(d.d2.ok, true);
        assert.ok(d.pairLevel > 0, 'and they can still reach a pair');
    } finally {
        setQualityLimits({ mainsRedUv: 50, mainsAmberUv: 20, artifactShareRed: 0.5 });
    }
    assert.equal(channelQuality(noisy), 'red', 'the default is restored');
});

