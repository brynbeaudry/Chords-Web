// The settings an operator actually changes during a show, as settings rather than as things
// you have to know to type into the address bar.
//
// These started as `?chans=`, `?mainsred=` and `?artifact=`. A query parameter is a poor home
// for them: you cannot discover it, you cannot see its current value, and changing it means a
// reload, which drops the Bluetooth connections and the calibration with them. They are now in
// the Settings panel, applied live, and remembered on this machine so a reload mid-show does
// not quietly undo them.
//
// The old query parameters still work as a one-off override, because they are in the operator
// guide and in people's bookmarks. A parameter in the address wins for that page load and is
// then saved like any other change.

export interface DualAlphaSettings {
    /**
     * How many of the three electrode inputs actually have an electrode on them (`?chans=`).
     *
     * This is not cosmetic. `ok` requires that *no included electrode is red*, so an input
     * with nothing plugged into it floats, rails, goes red, and holds that whole person at
     * `not ok` for the entire show -- which greys their side out in TouchDesigner and keeps
     * `pair_level` at 0 no matter how good the one real electrode is. A headset wired as a
     * single channel (one active, plus reference and ground on the mastoids) must say
     * `?chans=1`, and then inputs 2 and 3 start switched out instead of poisoning the vote.
     */
    chans: number;
    /**
     * Whether mains pickup alone may make an electrode red -- and so drop it from the vote
     * and force that person to `not ok`.
     *
     * **Off by default.** The 50 µV limit in the plan was measured against the *previous*
     * detector, which reported false alpha 56-100 % of the time at that level. The current
     * detector analyses 3-45 Hz, so a 50 or 60 Hz line is not in the band it looks at at all;
     * mains is a contact-quality measure here, not a detection one. Left on, it stops people
     * who are showing perfectly good alpha from ever reaching `ok` in an electrically noisy
     * room, which greys their side of the projection out for the whole piece. The µV figure
     * is still measured, still shown, and still turns the chip amber.
     */
    mainsRedEnabled: boolean;
    /** The limit used when the rule above is on, in µV. */
    mainsRedUv: number;
    /** Share of the last 10 s that may be artifact before an electrode goes red. */
    artifactRed: number;
}

export const DEFAULT_SETTINGS: DualAlphaSettings = {
    chans: 3,
    mainsRedEnabled: false,
    mainsRedUv: 50,
    artifactRed: 0.5,
};

const KEY = 'dual-alpha.settings.v1';

/**
 * A value in range, or the default. Deliberately not a clamp: a corrupt stored `0` for the
 * restlessness limit would clamp to the *strictest* setting there is and quietly reject every
 * electrode above 5 %. Out of range means the value cannot be trusted, so it is not used.
 */
function inRange(v: unknown, lo: number, hi: number, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
}

/** Keep a loaded object honest: wrong types and silly values fall back to the default. */
export function normalise(o: Partial<DualAlphaSettings> | null | undefined, maxChans = 3): DualAlphaSettings {
    const s = { ...DEFAULT_SETTINGS };
    if (!o) return s;
    s.chans = Math.round(inRange(o.chans, 1, maxChans, DEFAULT_SETTINGS.chans));
    if (typeof o.mainsRedEnabled === 'boolean') s.mainsRedEnabled = o.mainsRedEnabled;
    s.mainsRedUv = inRange(o.mainsRedUv, 1, 10_000, DEFAULT_SETTINGS.mainsRedUv);
    s.artifactRed = inRange(o.artifactRed, 0.05, 1, DEFAULT_SETTINGS.artifactRed);
    return s;
}

/**
 * Settings for this page load: the defaults, then whatever this machine remembers, then any
 * query parameter in the address. A reload with no parameters keeps what the operator chose.
 */
export function loadSettings(search = '', maxChans = 3): DualAlphaSettings {
    let stored: Partial<DualAlphaSettings> | null = null;
    try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
        if (raw) stored = JSON.parse(raw) as Partial<DualAlphaSettings>;
    } catch {
        stored = null;                       // private mode, or someone else's JSON in the slot
    }
    const s = normalise(stored, maxChans);

    const q = new URLSearchParams(search);
    const chans = q.get('chans');
    if (chans !== null) s.chans = Math.round(inRange(Number(chans), 1, maxChans, s.chans));
    const mainsred = q.get('mainsred');
    if (mainsred !== null && Number.isFinite(Number(mainsred))) {
        // `?mainsred=0` was the way to switch the rule off; keep that meaning.
        const uv = Number(mainsred);
        s.mainsRedEnabled = uv > 0;
        if (uv > 0) s.mainsRedUv = inRange(uv, 1, 10_000, s.mainsRedUv);
    }
    const artifact = q.get('artifact');
    if (artifact !== null) s.artifactRed = inRange(Number(artifact), 0.05, 1, s.artifactRed);
    return s;
}

export function saveSettings(s: DualAlphaSettings): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
        /* nothing to do: the settings still apply to this page load */
    }
}

export function clearSettings(): void {
    try {
        localStorage.removeItem(KEY);
    } catch {
        /* as above */
    }
}

/** What `channelQuality` should use, given these settings. 0 means "never red on mains". */
export function qualityLimitsFor(s: DualAlphaSettings): { mainsRedUv: number; artifactShareRed: number } {
    return {
        mainsRedUv: s.mainsRedEnabled ? s.mainsRedUv : 0,
        artifactShareRed: s.artifactRed,
    };
}
