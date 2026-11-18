// Turns the per-channel detector readings of two people into the five alpha values of
// contract v2: d1_level, d1_ok, d2_level, d2_ok, pair_level.
// Rules: docs/alpha-v2/dual-alpha-route-2026-11-18.md §4.2. Pure functions, no state.

export type Quality = 'none' | 'green' | 'amber' | 'red';

/** Proposed thresholds (§4.2; tune in P8). */
export const QUALITY_LIMITS = {
    mainsAmberUv: 20,
    mainsRedUv: 50,
    artifactShareRed: 0.5,   // artifact gate holding for more than half of the last 10 s
};

export interface QualityInput {
    hasReading: boolean;     // false until the detector's 2 s window has filled
    mainsUv: number;         // larger of the 50 Hz and 60 Hz pickup, µV (approximate)
    railed: boolean;         // a raw count at 0 or 4095 in the last hop
    artifactShare: number;   // 0..1 over the last 10 s
}

export function channelQuality(q: QualityInput): Quality {
    if (!q.hasReading) return 'none';
    if (q.railed || q.mainsUv > QUALITY_LIMITS.mainsRedUv || q.artifactShare > QUALITY_LIMITS.artifactShareRed) return 'red';
    if (q.mainsUv > QUALITY_LIMITS.mainsAmberUv) return 'amber';
    return 'green';
}

export interface ChannelInput {
    included: boolean;   // the operator has not excluded this electrode
    quality: Quality;
    isAlpha: boolean;
    promDb: number;
}

export interface PersonInput {
    channels: ChannelInput[];
    msSinceLastSample: number;   // device sending within the last second, or not ok
    ceilingDb?: number;          // eyes-closed median from the 20 s check; undefined = uncalibrated
}

export interface DyadParams {
    offDb: number;               // the detector's exit level (2 dB; enter - 3 with ?enter=)
    defaultCeilingDb: number;    // used when a person has no 20 s check (12 dB)
    staleMs: number;             // device silent this long -> not ok (1000 ms)
}

export const DEFAULT_DYAD_PARAMS: DyadParams = { offDb: 2, defaultCeilingDb: 12, staleMs: 1000 };

export interface PersonState {
    ok: boolean;
    inAlpha: boolean;      // the vote: at least half of the usable channels in alpha
    level: number;         // 0..1; 0 = not in alpha or not ok
    medianPromDb: number;  // over the usable channels (NaN if none)
    usable: number;
    voting: number;        // usable channels with isAlpha
    calibrated: boolean;
}

export interface DyadResult {
    d1: PersonState;
    d2: PersonState;
    pairLevel: number;
}

/** `level` from a prominence: clamp((prom - offDb) / (ceiling - offDb), 0.05, 1). */
export function levelFromProm(promDb: number, offDb: number, ceilingDb: number): number {
    const span = Math.max(0.5, ceilingDb - offDb);
    return Math.min(1, Math.max(0.05, (promDb - offDb) / span));
}

export function median(xs: number[]): number {
    if (xs.length === 0) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

export function personState(p: PersonInput, params: DyadParams = DEFAULT_DYAD_PARAMS): PersonState {
    const included = p.channels.filter((c) => c.included && c.quality !== 'none');
    const usable = included.filter((c) => c.quality !== 'red');
    const voting = usable.filter((c) => c.isAlpha).length;
    const inAlpha = usable.length > 0 && voting * 2 >= usable.length;   // 2 of 3, 1 of 2, 1 of 1
    const sending = p.msSinceLastSample < params.staleMs;
    // ok: sending, at least one usable channel, and no included channel is red.
    const ok = sending && usable.length > 0 && usable.length === included.length;
    const medianPromDb = median(usable.map((c) => c.promDb));
    const calibrated = p.ceilingDb !== undefined;
    const ceiling = p.ceilingDb ?? params.defaultCeilingDb;
    const level = inAlpha && ok ? levelFromProm(medianPromDb, params.offDb, ceiling) : 0;
    return { ok, inAlpha, level, medianPromDb, usable: usable.length, voting, calibrated };
}

export function dyadState(p1: PersonInput, p2: PersonInput, params: DyadParams = DEFAULT_DYAD_PARAMS): DyadResult {
    const d1 = personState(p1, params);
    const d2 = personState(p2, params);
    const pairLevel = d1.ok && d2.ok ? Math.min(d1.level, d2.level) : 0;
    return { d1, d2, pairLevel };
}
