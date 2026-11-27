// The guided 15 s check (plan §P6, revised): three phases of 5 s, per person.
//
//   1. eyes OPEN, blink 5 times     a liveness check against a known signal
//   2. eyes CLOSED                  the alpha ceiling
//   3. eyes OPEN, still             the clean alpha floor
//
// Five seconds a phase, not ten, and the medians are *better* for it rather than worse. The
// detector's prominence is a trailing 2 s average, so for the first two seconds after an
// instruction every reading is a blend of this phase and the one before it. The old 10 s
// phases put those contaminated readings straight into the median along with the good ones.
// Now each phase discards its first SETTLE_S and keeps only readings whose whole 2 s window
// lies inside the phase -- about 23 hops, far more than MIN_SAMPLES needs. Half the time in
// the chair, and a cleaner ceiling and floor.
//
// and from them, that person's own thresholds:
//   ceiling = eyes-closed median      (what `level` scales against; DyadState.levelFromProm)
//   onDb    = max(4, (ec + eo) / 2)
//   offDb   = onDb - 3
//
// Why the blink phase is first
// ----------------------------
// A flat electrode and a person with weak alpha look identical in the numbers, and that
// ambiguity cost real time: an electrode reading nothing was read as "this person has no
// alpha" more than once. A blink is the one signal we can *ask for* and be sure of. It is
// large, it is deliberate, and on a frontal or temple electrode it is unmissable; even on an
// occipital one it moves the trace. So the check opens by asking for five of them, and reports
// whether that electrode saw them. If it did not, nothing after it means anything, and the
// honest readout is "this electrode is not picking this person up" rather than a ceiling
// measured from noise.
//
// It also keeps the alpha measurement cleaner than the old two-phase version did. There, the
// eyes-open half was whatever the person happened to do, blinks included, and blinks inflate
// prominence. Now the blinking is over before the measurement starts, and the final phase is
// explicitly "open and still", so the floor is a floor.
//
// Pure state, no timers of its own: the page drives it with the hop clock, the same clock the
// detector runs on, so a replay calibrates exactly as a live session does.
//
// The operator may re-enter the check at any time (`start`), which is how a new pair moving
// through the piece gets its own ceilings, and may end it early (`confirm`). Ending early
// keeps whatever was measured, as long as the two measuring phases have at least MIN_SAMPLES
// hops each; otherwise that person stays uncalibrated and falls back to the 12 dB default.
import { median } from '@/components/DyadState';
import type { Slot } from './engine';

export type CalPhase = 'idle' | 'blink' | 'closed' | 'open' | 'done';

/** Seconds in each phase. */
export const PHASE_S = 5;
export const BLINK_S = PHASE_S;
export const CLOSED_S = PHASE_S;
export const OPEN_S = PHASE_S;
export const TOTAL_S = BLINK_S + CLOSED_S + OPEN_S;

/**
 * Seconds discarded at the start of each phase.
 *
 * The detector reports prominence over a trailing 2 s window, so a reading taken less than 2 s
 * after an instruction is partly measuring the previous phase. Set to the detector's window so
 * only fully-inside readings reach the median. It also absorbs the moment it takes someone to
 * actually close their eyes.
 */
export const SETTLE_S = 2;

/** How many blinks to ask for, and the phase they belong to. */
export const BLINKS = 5;

/** A phase with fewer accepted hops than this is not trusted (about 0.6 s at a 128 ms hop). */
export const MIN_SAMPLES = 5;

/** Phase boundaries in seconds from the start of the check. */
const PHASE_END = { blink: BLINK_S, closed: BLINK_S + CLOSED_S, open: TOTAL_S } as const;

/**
 * Share of the blink phase's hops that must show an artifact for the electrode to count as
 * picking this person up.
 *
 * Deliberately a low bar. Five blinks about a second apart, each disturbing roughly the 2 s
 * window it falls in, should flag a large fraction of the recorded hops -- so anything near
 * zero means the electrode is not seeing the person at all. It is a yes/no liveness answer,
 * not a measure of blink size, and it is reported rather than enforced: a weak result is a
 * warning to the operator, never a reason to refuse a calibration they asked for.
 */
export const LIVENESS_SHARE = 0.15;

export interface PersonCalibration {
    ceilingDb: number;      // eyes-closed median prominence
    onDb: number;           // max(4, (ec + eo) / 2)
    offDb: number;          // onDb - 3
    closedMedianDb: number;
    openMedianDb: number;   // from the final still phase, with no blinks in it
    closedIafHz: number;    // median eyes-closed peak frequency, for the operator to sanity-check
    closedSamples: number;
    openSamples: number;
    /** Hops recorded in the blink phase, and the share of them that showed an artifact. */
    blinkSamples: number;
    blinkArtifactShare: number;
    /** The electrode responded to the blinks, so it is picking this person up. */
    liveness: boolean;
}

interface Phase {
    prom: number[];
    iaf: number[];
    artifacts: number;
    hops: number;
}

const emptyPhase = (): Phase => ({ prom: [], iaf: [], artifacts: 0, hops: 0 });
const emptySet = () => ({ blink: emptyPhase(), closed: emptyPhase(), open: emptyPhase() });

export class Calibration {
    phase: CalPhase = 'idle';
    private t0 = 0;              // when the current check started
    private endedAt: number | null = null;
    private phases: Record<Slot, ReturnType<typeof emptySet>> = { 1: emptySet(), 2: emptySet() };

    /**
     * Enter (or re-enter) the check, discarding anything measured before. Safe from any
     * phase: this is the operator's "Calibrate" button between people.
     */
    start(tMs: number): void {
        this.phase = 'blink';
        this.t0 = tMs;
        this.endedAt = null;
        this.phases = { 1: emptySet(), 2: emptySet() };
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
        return this.phase === 'blink' || this.phase === 'closed' || this.phase === 'open';
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

    /** Seconds left in the phase running now; 0 once the check is over. */
    phaseRemainingS(tMs: number): number {
        if (!this.running) return 0;
        return Math.max(0, PHASE_END[this.phase as 'blink' | 'closed' | 'open'] - this.elapsedS(tMs));
    }

    /** Seconds since the phase running now began. */
    phaseElapsedS(tMs: number): number {
        if (!this.running) return 0;
        const end = PHASE_END[this.phase as 'blink' | 'closed' | 'open'];
        return Math.max(0, this.elapsedS(tMs) - (end - PHASE_S));
    }

    /**
     * True while the current phase is still inside its settling time, so nothing is being
     * recorded yet. Shown in the panel: an operator watching the counts stay at 0 for two
     * seconds should see why.
     */
    settling(tMs: number): boolean {
        return this.running && this.phaseElapsedS(tMs) < SETTLE_S;
    }

    /**
     * Advance the phase for the current time. Call once per hop before `push`, so a hop
     * lands in the phase it belongs to. Returns the phase after advancing.
     */
    tick(tMs: number): CalPhase {
        if (!this.running) return this.phase;
        const e = this.elapsedS(tMs);
        if (e >= TOTAL_S) {
            this.phase = 'done';
            this.endedAt = this.t0 + TOTAL_S * 1000;
        } else if (e >= PHASE_END.closed) {
            this.phase = 'open';
        } else if (e >= PHASE_END.blink) {
            this.phase = 'closed';
        }
        return this.phase;
    }

    /**
     * Record one hop for a person. `medianPromDb` is that person's median prominence over the
     * usable channels (NaN when none are usable) and `iafHz` its peak frequency; both are
     * dropped unless they are finite, so a dropout does not pull the median down. `artifact`
     * is whether any electrode still in the vote rejected this window -- which during the
     * blink phase is the blinks being seen, and is what the liveness answer is built from.
     * Hops inside a phase's settling time are ignored entirely.
     */
    push(slot: Slot, medianPromDb: number, iafHz: number, tMs: number, artifact = false): void {
        if (this.tick(tMs) === 'done' || this.phase === 'idle') return;
        // Readings whose 2 s window straddles the instruction are measuring the previous
        // phase as much as this one, so they are dropped rather than averaged in.
        if (this.phaseElapsedS(tMs) < SETTLE_S) return;
        const p = this.phases[slot][this.phase as 'blink' | 'closed' | 'open'];
        p.hops++;
        if (artifact) p.artifacts++;
        if (!Number.isFinite(medianPromDb)) return;
        p.prom.push(medianPromDb);
        if (Number.isFinite(iafHz)) p.iaf.push(iafHz);
    }

    /** How many hops each phase has so far, for the operator's progress readout. */
    counts(slot: Slot): { blink: number; closed: number; open: number; blinkArtifacts: number } {
        const s = this.phases[slot];
        return {
            blink: s.blink.prom.length,
            closed: s.closed.prom.length,
            open: s.open.prom.length,
            blinkArtifacts: s.blink.artifacts,
        };
    }

    /** Whether the blinks have been seen on this person so far, for live feedback. */
    liveness(slot: Slot): boolean {
        const b = this.phases[slot].blink;
        return b.hops > 0 && b.artifacts / b.hops >= LIVENESS_SHARE;
    }

    /**
     * That person's thresholds, or null when either measuring phase is too thin to trust
     * (they then stay uncalibrated on the 12 dB default).
     *
     * The blink phase is reported but never required: a person whose electrode missed the
     * blinks still gets whatever the alpha phases measured, with `liveness` false so the
     * operator knows how much to believe it.
     */
    result(slot: Slot): PersonCalibration | null {
        const { blink, closed, open } = this.phases[slot];
        if (closed.prom.length < MIN_SAMPLES || open.prom.length < MIN_SAMPLES) return null;
        const ec = median(closed.prom);
        const eo = median(open.prom);
        const onDb = Math.max(4, (ec + eo) / 2);
        const share = blink.hops > 0 ? blink.artifacts / blink.hops : 0;
        return {
            ceilingDb: ec,
            onDb,
            offDb: onDb - 3,
            closedMedianDb: ec,
            openMedianDb: eo,
            closedIafHz: closed.iaf.length ? median(closed.iaf) : NaN,
            closedSamples: closed.prom.length,
            openSamples: open.prom.length,
            blinkSamples: blink.prom.length,
            blinkArtifactShare: share,
            liveness: blink.hops > 0 && share >= LIVENESS_SHARE,
        };
    }
}
