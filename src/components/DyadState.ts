// Turns the per-channel detector readings of two people into the five alpha values of
// contract v2: d1_level, d1_ok, d2_level, d2_ok, pair_level.
// Rules: docs/alpha-v2/dual-alpha-route-2026-11-18.md §4.2. Pure functions, no state.

export type Quality = 'none' | 'green' | 'amber' | 'red';

/**
 * Thresholds from the plan, §4.2 (`ALPHA_DETECTION_ENGINEERING_PLAN.md` line 305: "Amber
 * above 20 µV, red above 50 µV"). The 50 µV figure comes from the *old* detector, which
 * `ALPHA_DETECTION_CLINICAL_REVIEW.md` measured reporting false alpha 56-100 % of the time at
 * that level. The current detector is far less sensitive to it -- its DFT covers 3-45 Hz, so
 * a 50 or 60 Hz line is not even in the analysed band -- which makes 50 µV a conservative
 * limit here, and a contact-quality proxy rather than a detection one.
 *
 * It matters because red is not advisory: a red electrode leaves the vote and forces that
 * person to `not ok`, which greys their side of the projection out. In a room with a lot of
 * mains pickup that can mean a person showing clear alpha never reaches `ok`, so the limits
 * are adjustable from the address bar (`?mainsred=`, `?artifact=`). Changing them applies to
 * both people -- `channelQuality` is the single place quality is decided.
 */
export const QUALITY_LIMITS = {
    mainsAmberUv: 20,
    mainsRedUv: 50,
    artifactShareRed: 0.5,   // artifact gate holding for more than half of the last 10 s
};

/**
 * Override the quality limits for this session. `mainsRedUv: 0` means mains pickup never on
 * its own makes an electrode red (it still shows amber, and the µV figure is still the best
 * guide to contact), which is the setting for a noisy room where the signal is otherwise fine.
 */
export function setQualityLimits(o: Partial<typeof QUALITY_LIMITS>): void {
    if (o.mainsRedUv !== undefined) QUALITY_LIMITS.mainsRedUv = o.mainsRedUv;
    if (o.mainsAmberUv !== undefined) QUALITY_LIMITS.mainsAmberUv = o.mainsAmberUv;
    if (o.artifactShareRed !== undefined) QUALITY_LIMITS.artifactShareRed = o.artifactShareRed;
    // Amber above red would make a channel red before it ever warned.
    if (QUALITY_LIMITS.mainsRedUv > 0) {
        QUALITY_LIMITS.mainsAmberUv = Math.min(QUALITY_LIMITS.mainsAmberUv, QUALITY_LIMITS.mainsRedUv);
    }
}

export interface QualityInput {
    hasReading: boolean;     // false until the detector's 2 s window has filled
    mainsUv: number;         // larger of the 50 Hz and 60 Hz pickup, µV (approximate)
    railed: boolean;         // a raw count at 0 or 4095 in the last hop
    artifactShare: number;   // 0..1 over the last 10 s
}

export function channelQuality(q: QualityInput): Quality {
    if (!q.hasReading) return 'none';
    // mainsRedUv 0 switches the mains rule off entirely rather than making everything red.
    const mainsRed = QUALITY_LIMITS.mainsRedUv > 0 && q.mainsUv > QUALITY_LIMITS.mainsRedUv;
    if (q.railed || mainsRed || q.artifactShare > QUALITY_LIMITS.artifactShareRed) return 'red';
    if (q.mainsUv > QUALITY_LIMITS.mainsAmberUv) return 'amber';
    return 'green';
}

export interface ChannelInput {
    /**
     * The operator has not excluded this electrode. The first included, non-red channel is
     * the *reading electrode*, and it alone decides whether the person is in alpha.
     */
    included: boolean;
    quality: Quality;
    isAlpha: boolean;
    promDb: number;
}

export interface PersonInput {
    channels: ChannelInput[];
    msSinceLastSample: number;   // device sending within the last second, or not ok
    ceilingDb?: number;          // eyes-closed median from the 20 s check; undefined = uncalibrated
    /** This person's own exit threshold from the 20 s check; falls back to the shared one. */
    offDb?: number;
}

export interface DyadParams {
    offDb: number;               // the detector's exit level (2 dB; enter - 3 with ?enter=)
    defaultCeilingDb: number;    // used when a person has no 20 s check (12 dB)
    staleMs: number;             // device silent this long -> not ok (1000 ms)
}

export const DEFAULT_DYAD_PARAMS: DyadParams = { offDb: 2, defaultCeilingDb: 12, staleMs: 1000 };

export interface PersonState {
    ok: boolean;
    /** The reading electrode says so. One differential channel: nothing to vote between. */
    inAlpha: boolean;
    level: number;         // 0..1; 0 = not in alpha or not ok
    medianPromDb: number;  // the reading electrode's prominence (NaN if it is not usable)
    usable: number;
    voting: number;        // usable channels seeing alpha; reported, not used to decide
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

    // The reading electrode decides, on its own and at once.
    //
    // These headsets are wired as a *single differential channel*: one reading electrode --
    // the positive, which the page calls O1 -- with a reference and a ground completing it.
    // All three leads are on the head; only one of them is a channel. So there is nothing to
    // vote between, and the vote that used to be here ("at least half the usable electrodes
    // agree") was actively harmful: the two inputs with no electrode of their own float and
    // go red, and one real electrode against two of those is one of three, which is not half
    // of three. A person could show unmistakable alpha on O1 and the page would send nothing.
    //
    // `ok` follows the same principle: the reading electrode's health is the person's health.
    // A floating input alongside it is not a fault in the person's signal, so it no longer
    // drags them to `not ok` either.
    const reader = usable[0];
    const inAlpha = !!reader?.isAlpha;
    const voting = usable.filter((c) => c.isAlpha).length;   // reported, not used to decide
    const sending = p.msSinceLastSample < params.staleMs;
    const ok = sending && reader !== undefined;
    const medianPromDb = reader ? reader.promDb : NaN;
    const calibrated = p.ceilingDb !== undefined;
    const ceiling = p.ceilingDb ?? params.defaultCeilingDb;
    // The floor of the level scale must be the same number the detector switches off at, or
    // a person calibrated to a weak montage reads as deeper than they are.
    const offDb = p.offDb ?? params.offDb;
    const level = inAlpha && ok ? levelFromProm(medianPromDb, offDb, ceiling) : 0;
    return { ok, inAlpha, level, medianPromDb, usable: usable.length, voting, calibrated };
}

export function dyadState(p1: PersonInput, p2: PersonInput, params: DyadParams = DEFAULT_DYAD_PARAMS): DyadResult {
    const d1 = personState(p1, params);
    const d2 = personState(p2, params);
    const pairLevel = d1.ok && d2.ok ? Math.min(d1.level, d2.level) : 0;
    return { d1, d2, pairLevel };
}
