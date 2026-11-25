// The guided 20 s check (plan §P6): 10 s eyes closed, then 10 s eyes open, per person.
// Stores each person's median prominence and peak frequency for both halves and turns them
// into that person's thresholds:
//   ceiling = eyes-closed median      (what `level` scales against; DyadState.levelFromProm)
//   onDb    = max(4, (ec + eo) / 2)
//   offDb   = onDb - 3
// Pure state, no timers of its own: the page drives it with the hop clock, the same clock
// the detector runs on, so a replay calibrates exactly as a live session does.
//
// The operator may re-enter the check at any time (`start`), which is how a new pair moving
// through the piece gets its own ceilings, and may end it early (`confirm`) when the room
// does not allow a full 20 s. Ending early keeps whatever was measured, as long as both
// halves have at least MIN_SAMPLES hops; otherwise that person stays uncalibrated and falls
// back to the 12 dB default.
import { median } from '@/components/DyadState';
import type { Slot } from './engine';

export type CalPhase = 'idle' | 'closed' | 'open' | 'done';

/** Seconds in each half of the check. */
export const CLOSED_S = 10;
export const OPEN_S = 10;
export const TOTAL_S = CLOSED_S + OPEN_S;

/** A half with fewer accepted hops than this is not trusted (about 0.6 s at a 128 ms hop). */
export const MIN_SAMPLES = 5;

export interface PersonCalibration {
    ceilingDb: number;      // eyes-closed median prominence
    onDb: number;           // max(4, (ec + eo) / 2)
    offDb: number;          // onDb - 3
    closedMedianDb: number;
    openMedianDb: number;
    closedIafHz: number;    // median eyes-closed peak frequency, for the operator to sanity-check
    closedSamples: number;
    openSamples: number;
}

interface Half {
    prom: number[];
    iaf: number[];
}

const emptyHalf = (): Half => ({ prom: [], iaf: [] });

export class Calibration {
    phase: CalPhase = 'idle';
    private t0 = 0;              // when the current check started
    private endedAt: number | null = null;
    private halves: Record<Slot, { closed: Half; open: Half }> = {
        1: { closed: emptyHalf(), open: emptyHalf() },
        2: { closed: emptyHalf(), open: emptyHalf() },
    };

    /**
     * Enter (or re-enter) the check, discarding anything measured before. Safe from any
     * phase: this is the operator's "Calibrate" button between people.
     */
    start(tMs: number): void {
        this.phase = 'closed';
        this.t0 = tMs;
        this.endedAt = null;
        this.halves = {
            1: { closed: emptyHalf(), open: emptyHalf() },
            2: { closed: emptyHalf(), open: emptyHalf() },
        };
    }

    /** End the check now and keep what was measured. No effect unless it is running. */
    confirm(tMs: number): void {
        if (!this.running) return;
        this.phase = 'done';
        this.endedAt = tMs;
    }

    /** Leave the check without keeping anything. */
    cancel(): void {
        this.phase = 'idle';
        this.endedAt = null;
    }

    get running(): boolean {
        return this.phase === 'closed' || this.phase === 'open';
    }

    elapsedS(tMs: number): number {
        if (this.phase === 'idle') return 0;
        const end = this.endedAt ?? tMs;
        return Math.max(0, (end - this.t0) / 1000);
    }

    /** Seconds left in the whole check; 0 once it is over. */
    remainingS(tMs: number): number {
        if (!this.running) return 0;
        return Math.max(0, TOTAL_S - this.elapsedS(tMs));
    }

    /**
     * Advance the phase for the current time. Call once per hop before `push`, so a hop
     * lands in the half it belongs to. Returns the phase after advancing.
     */
    tick(tMs: number): CalPhase {
        if (!this.running) return this.phase;
        const e = this.elapsedS(tMs);
        if (e >= TOTAL_S) {
            this.phase = 'done';
            this.endedAt = this.t0 + TOTAL_S * 1000;
        } else if (e >= CLOSED_S) {
            this.phase = 'open';
        }
        return this.phase;
    }

    /**
     * Record one hop for a person. `medianPromDb` is that person's median prominence over
     * the usable channels (NaN when none are usable) and `iafHz` its peak frequency; both
     * are dropped unless they are finite, so a dropout does not pull the median down.
     */
    push(slot: Slot, medianPromDb: number, iafHz: number, tMs: number): void {
        if (this.tick(tMs) === 'done' || this.phase === 'idle') return;
        if (!Number.isFinite(medianPromDb)) return;
        const half = this.phase === 'closed' ? this.halves[slot].closed : this.halves[slot].open;
        half.prom.push(medianPromDb);
        if (Number.isFinite(iafHz)) half.iaf.push(iafHz);
    }

    /** How many hops each half has so far, for the operator's progress readout. */
    counts(slot: Slot): { closed: number; open: number } {
        return { closed: this.halves[slot].closed.prom.length, open: this.halves[slot].open.prom.length };
    }

    /**
     * That person's thresholds, or null when either half is too thin to trust (they then
     * stay uncalibrated on the 12 dB default).
     */
    result(slot: Slot): PersonCalibration | null {
        const { closed, open } = this.halves[slot];
        if (closed.prom.length < MIN_SAMPLES || open.prom.length < MIN_SAMPLES) return null;
        const ec = median(closed.prom);
        const eo = median(open.prom);
        const onDb = Math.max(4, (ec + eo) / 2);
        return {
            ceilingDb: ec,
            onDb,
            offDb: onDb - 3,
            closedMedianDb: ec,
            openMedianDb: eo,
            closedIafHz: closed.iaf.length ? median(closed.iaf) : NaN,
            closedSamples: closed.prom.length,
            openSamples: open.prom.length,
        };
    }
}
