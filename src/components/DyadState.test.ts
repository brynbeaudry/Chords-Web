import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelQuality, dyadState, personState, levelFromProm, type ChannelInput, type PersonInput } from './DyadState';

const ch = (isAlpha: boolean, promDb = isAlpha ? 8 : 1, extra: Partial<ChannelInput> = {}): ChannelInput =>
    ({ included: true, quality: 'green', isAlpha, promDb, ...extra });
const person = (channels: ChannelInput[], extra: Partial<PersonInput> = {}): PersonInput =>
    ({ channels, msSinceLastSample: 10, ...extra });

test('vote: 2 of 3 is in alpha, 1 of 3 is not', () => {
    assert.equal(personState(person([ch(true), ch(true), ch(false)])).inAlpha, true);
    assert.equal(personState(person([ch(true), ch(false), ch(false)])).inAlpha, false);
});

test('vote: 1 of 2 and 1 of 1 usable channels are in alpha', () => {
    const red = { quality: 'red' as const };
    const excluded = { included: false };
    // one excluded: 1 of 2
    assert.equal(personState(person([ch(true), ch(false), ch(false, 1, excluded)])).inAlpha, true);
    // two excluded: 1 of 1
    const one = personState(person([ch(true), ch(true, 9, excluded), ch(false, 1, excluded)]));
    assert.equal(one.inAlpha, true);
    assert.equal(one.usable, 1);
    // a red channel does not vote (and makes the person not ok)
    const withRed = personState(person([ch(true), ch(false), ch(false, 1, red)]));
    assert.equal(withRed.inAlpha, true);
    assert.equal(withRed.ok, false);
    assert.equal(withRed.level, 0);
});

test('ok is lost when the device stops, when every channel is excluded, or when none has a reading yet', () => {
    assert.equal(personState(person([ch(true), ch(true), ch(true)], { msSinceLastSample: 1500 })).ok, false);
    assert.equal(personState(person([ch(true, 8, { included: false })])).ok, false);
    assert.equal(personState(person([ch(false, 0, { quality: 'none' })])).ok, false);
    assert.equal(personState(person([ch(true), ch(true), ch(true, 8, { quality: 'amber' })])).ok, true);
});

test('level: uncalibrated uses a 12 dB ceiling, calibrated uses the person ceiling, 0 when out of alpha', () => {
    const p = [ch(true, 7), ch(true, 7), ch(false, 1)];      // median prom 7 dB
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
