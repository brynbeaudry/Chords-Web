// Per-person "how are they meant to get into alpha" mode.
//
// **Eyes open is the default, because that is what the piece asks of people.** They are
// sitting in front of a projection and reaching alpha through calm focus on it; being told to
// shut their eyes would remove the thing they are responding to. Eyes closed is the exception,
// useful for a demonstration or for showing someone what their own alpha looks like.
//
// That default matters for the numbers. Alpha roughly doubles when the eyes shut (Berger's
// original observation), and the detector's 5 dB entry level was tuned on eyes-closed
// recordings. Eyes open, the same person's alpha is several dB smaller, so a fixed 5 dB entry
// can sit above everything they produce and the piece never responds to them however relaxed
// they get. Defaulting to eyes closed therefore meant defaulting to a threshold the audience
// could not reach.
//
// The mode only moves the thresholds. It does not change what is measured, and it never
// touches the person's ceiling, which is a measurement of them rather than a decision about
// the piece.
import type { PersonCalibration } from './calibration';

export type AlphaMode = 'closed' | 'open';

/** What a person starts on: the piece is watched with the eyes open. */
export const DEFAULT_MODE: AlphaMode = 'open';

/** Thresholds when nothing has been measured for this person. */
export const MODE_PRESET: Record<AlphaMode, number> = {
    closed: 5,     // the tuned default (analysis/results.json "chosen")
    open: 3,       // lower, because eyes-open alpha is smaller; more false positives, by choice
};

/** The exit level sits this far below the entry level everywhere in the app. */
export const HYSTERESIS_DB = 3;

/**
 * The range the entry level may be set to, by any route -- mode, nudge buttons or dragging.
 *
 * Below 0.5 dB the detector would fire on the background itself; above 14 it leaves the top of
 * the lane, where it could neither be seen nor dragged back.
 */
export const MIN_ENTER_DB = 0.5, MAX_ENTER_DB = 14;

/**
 * The entry level for a person in this mode, using their own 15 s check when there is one.
 *
 * Calibrated, eyes closed: the check's own `onDb`, which is the midpoint between their
 * eyes-closed and eyes-open medians -- comfortably reachable by closing their eyes.
 *
 * Calibrated, eyes open: just above their measured eyes-open baseline. That is the point of
 * the mode; sitting at the midpoint would mean they had to close their eyes to reach it. One
 * dB of margin keeps the background itself from tripping it.
 */
export function enterDbFor(mode: AlphaMode, cal: PersonCalibration | null): number {
    if (!cal) return MODE_PRESET[mode];
    if (mode === 'closed') return cal.onDb;
    return Math.max(1.5, cal.openMedianDb + 1);
}

/** `{ onDb, offDb }` for a mode, with the shared hysteresis applied. */
export function thresholdsFor(mode: AlphaMode, cal: PersonCalibration | null): { onDb: number; offDb: number } {
    const onDb = enterDbFor(mode, cal);
    return { onDb, offDb: onDb - HYSTERESIS_DB };
}
