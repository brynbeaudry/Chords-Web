// Everything between a sample and a TouchDesigner message, for two devices, with no
// React and no browser APIs, so the page, a replay and a Node script run the same code.
//   ingest(slot, raw, tMs) -> SignalChain (filters + 3 detectors) -> DyadState -> contract v2
// One message per detector hop of the "driving" device: device 1 while it streams,
// else device 2 (plan §4.5, §5.3).
import { SignalChain, type ChannelStatus, type IngestResult, type Mains } from './signalChain';
import { WaveDecimator } from '@/components/WaveDecimator';
import { dyadState, DEFAULT_DYAD_PARAMS, type DyadParams, type DyadResult, type PersonInput } from '@/components/DyadState';
import type { AlphaDetectorParams } from '@/components/SpectralAlphaDetector';

export type Slot = 1 | 2;
/**
 * The electrode whose waveform is sent to TouchDesigner as `d1_w` / `d2_w`, 0-based.
 *
 * The **reading electrode**, the same one that decides whether the person is in alpha
 * (`DyadState.personState`). These headsets are one differential channel, so it is the only
 * input carrying a real signal; sending any other would send TouchDesigner a floating wire,
 * and every bit of the live texture over there -- the object's height, the noise layers, the
 * colour rotations, the trail -- comes from this one waveform.
 *
 * Preferred, not fixed: `waveChannel()` falls back if this input is red or switched out.
 */
export const MAIN_CHANNEL = 0;   // O1, the positive
export const WAVE_FS = 125;
export const WAVE_PER_MSG = 16;

/** Contract v2 (plan §4.1): exactly these 10 keys. */
export interface TdMessageV2 {
    v: 2;
    fs: 125;
    n: number;
    d1_level: number;
    d1_ok: 0 | 1;
    d2_level: number;
    d2_ok: 0 | 1;
    pair_level: number;
    d1_w: number[];
    d2_w: number[];
}

export interface EngineOptions {
    fs?: number;
    mains?: Mains;
    enterDb?: number;            // ?enter=: exit follows at enter - 3
    staleMs?: number;
}

export interface HopEvent {
    slot: Slot;
    result: IngestResult;
    status: ChannelStatus[];
    dyad: DyadResult;
}

const round = (v: number, k: number) => Math.round(v * k) / k;

export class DualAlphaEngine {
    readonly chains: Record<Slot, SignalChain>;
    readonly dyadParams: DyadParams;
    readonly detectorParams: Partial<AlphaDetectorParams>;
    /** Electrodes the operator excluded, per slot (indices 0..2). */
    readonly excluded: Record<Slot, Set<number>> = { 1: new Set(), 2: new Set() };
    /** Personal ceilings from a 20 s check (P6); undefined = uncalibrated. */
    readonly ceilingDb: Record<Slot, number | undefined> = { 1: undefined, 2: undefined };
    /**
     * Personal on/off thresholds from the same check. The check always measured these; until
     * now only the ceiling was applied and these were thrown away, which left everybody on a
     * fixed 5 dB entry -- too high for a montage where alpha is weak, such as a forehead or
     * behind-the-ear electrode rather than an occipital one.
     */
    readonly thresholdDb: Record<Slot, { onDb: number; offDb: number } | undefined> = { 1: undefined, 2: undefined };
    dyad: DyadResult;

    private readonly decimators: Record<Slot, WaveDecimator> = { 1: new WaveDecimator(), 2: new WaveDecimator() };
    private readonly waveQueue: Record<Slot, number[]> = { 1: [], 2: [] };
    private readonly lastWave: Record<Slot, number> = { 1: 0, 2: 0 };
    private readonly lastT: Record<Slot, number> = { 1: -Infinity, 2: -Infinity };
    /** The electrode currently feeding the waveform, per slot. See waveChannel(). */
    private readonly waveChan: Record<Slot, number> = { 1: MAIN_CHANNEL, 2: MAIN_CHANNEL };
    private n = 0;

    constructor(o: EngineOptions = {}) {
        const enter = o.enterDb ?? 5;
        this.detectorParams = { onDb: enter, offDb: enter - 3 };
        this.dyadParams = { ...DEFAULT_DYAD_PARAMS, offDb: enter - 3, staleMs: o.staleMs ?? DEFAULT_DYAD_PARAMS.staleMs };
        const fs = o.fs ?? 500, mains = o.mains ?? 60;
        this.chains = { 1: new SignalChain(fs, mains, this.detectorParams), 2: new SignalChain(fs, mains, this.detectorParams) };
        this.dyad = this.evaluate(0);
    }

    /** Clear one device's filters, detectors and waveform (connect, replay start/stop). */
    reset(slot: Slot): void {
        this.chains[slot].reset();
        this.decimators[slot].reset();
        this.waveQueue[slot] = [];
        this.lastWave[slot] = 0;
        this.lastT[slot] = -Infinity;
        this.waveChan[slot] = MAIN_CHANNEL;
    }

    /** Clear everything, including the message index. */
    resetAll(): void {
        this.reset(1);
        this.reset(2);
        this.n = 0;
    }

    isStreaming(slot: Slot, nowMs: number): boolean {
        return nowMs - this.lastT[slot] < this.dyadParams.staleMs;
    }

    /**
     * Apply one person's 20 s check: their ceiling, and their own on/off thresholds.
     *
     * Per person, not shared. Two people on different montages -- or just two different
     * heads -- produce different peak sizes, and one pair of global numbers has to be wrong
     * for at least one of them.
     */
    setCalibration(slot: Slot, ceilingDb: number, onDb: number, offDb: number): void {
        this.ceilingDb[slot] = ceilingDb;
        this.setThresholds(slot, onDb, offDb);
    }

    /**
     * Move one person's alpha thresholds without touching their ceiling.
     *
     * This is the operator dragging the on-line in the detector lane, or picking an
     * eyes-open/eyes-closed mode. Separate from `setCalibration` because the ceiling is a
     * *measurement* of that person and the thresholds are a *choice* about how easily the
     * piece should respond: changing your mind about the second must not discard the first.
     */
    setThresholds(slot: Slot, onDb: number, offDb: number): void {
        this.thresholdDb[slot] = { onDb, offDb };
        this.chains[slot].setThresholds(onDb, offDb);
    }

    /**
     * Which electrode's waveform goes to TouchDesigner for this device.
     *
     * Prefers `MAIN_CHANNEL`, then the others in order, skipping any that is red or that the
     * operator has switched out. Only re-picks when the current choice has actually failed,
     * which is what stops it flapping between two marginal electrodes: a switch is a step in
     * the waveform, and a step is a visible jolt in the projection. If every electrode is
     * red there is nothing better to send, so it keeps the preferred one.
     */
    /**
     * The reading electrode: the first included, non-red input, which is the one that decides
     * whether this person is in alpha (`DyadState.personState` uses the same rule).
     *
     * The UI needs this so it can show alpha state on that electrode *only*. The other inputs
     * are not independent measurements: every channel on this board is measured against the
     * same reference electrode, so whatever the reference picks up turns up in all of them,
     * and an input with nothing of its own on it shows little more than that. Since the
     * detector is scale-free -- prominence in dB over each channel's own background -- a faint
     * copy of a signal containing alpha reports the *same* prominence as the original. That is
     * why an input carrying no electrode can light up green.
     */
    readingChannel(slot: Slot): number {
        const st = this.chains[slot].status;
        for (let i = 0; i < st.length; i++) {
            if (!this.excluded[slot].has(i) && st[i].quality !== 'red') return i;
        }
        return MAIN_CHANNEL;
    }

    /**
     * The same idea as `readingChannel`, but with hysteresis: it keeps its current choice
     * while that still works, because this one feeds TouchDesigner's waveform and switching
     * input mid-stream is a step in the signal, which is a visible jolt on the projection.
     */
    waveChannel(slot: Slot): number {
        const st = this.chains[slot].status;
        const usable = (i: number) => !this.excluded[slot].has(i) && st[i].quality !== 'red';
        if (usable(this.waveChan[slot])) return this.waveChan[slot];
        for (let k = 0; k < st.length; k++) {
            const i = (MAIN_CHANNEL + k) % st.length;
            if (usable(i)) {
                this.waveChan[slot] = i;
                return i;
            }
        }
        return this.waveChan[slot];
    }

    /**
     * Feed one sample of one device. `tMs` is the sample's time (performance.now() live,
     * the recorded time in a replay). Returns the filtered values, a hop event when the
     * detectors updated, and a message when one is due.
     */
    ingest(slot: Slot, raw: number[], tMs: number): { result: IngestResult; hop: HopEvent | null; message: TdMessageV2 | null } {
        this.lastT[slot] = tMs;
        const result = this.chains[slot].ingest(raw);

        const q = this.waveQueue[slot];
        const batch = this.decimators[slot].push(result.filtered[this.waveChannel(slot)]);
        if (batch) {
            q.push(...batch.w);
            if (q.length > 3 * WAVE_PER_MSG) q.splice(0, q.length - 3 * WAVE_PER_MSG); // bound the other device's lag
        }

        if (!result.hop) return { result, hop: null, message: null };
        this.dyad = this.evaluate(tMs);
        const hop: HopEvent = { slot, result, status: this.chains[slot].status, dyad: this.dyad };
        const driver: Slot = this.isStreaming(1, tMs) ? 1 : 2;
        const message = slot === driver ? this.buildMessage() : null;
        return { result, hop, message };
    }

    private person(slot: Slot, nowMs: number): PersonInput {
        return {
            channels: this.chains[slot].status.map((s, i) => ({
                included: !this.excluded[slot].has(i),
                quality: s.quality,
                isAlpha: s.reading?.isAlpha ?? false,
                promDb: s.reading?.promDb ?? 0,
            })),
            msSinceLastSample: nowMs - this.lastT[slot],
            ceilingDb: this.ceilingDb[slot],
            offDb: this.thresholdDb[slot]?.offDb,
        };
    }

    private evaluate(nowMs: number): DyadResult {
        return dyadState(this.person(1, nowMs), this.person(2, nowMs), this.dyadParams);
    }

    /** Take 16 waveform samples of a device; a device that is behind repeats its last sample. */
    private take(slot: Slot): number[] {
        const q = this.waveQueue[slot];
        const out = q.splice(0, WAVE_PER_MSG);
        if (out.length) this.lastWave[slot] = out[out.length - 1];
        while (out.length < WAVE_PER_MSG) out.push(this.lastWave[slot]);
        return out.map((v) => round(v, 1e5));
    }

    private buildMessage(): TdMessageV2 {
        const { d1, d2, pairLevel } = this.dyad;
        const msg: TdMessageV2 = {
            v: 2,
            fs: WAVE_FS,
            n: this.n,
            d1_level: round(d1.level, 1e3),
            d1_ok: d1.ok ? 1 : 0,
            d2_level: round(d2.level, 1e3),
            d2_ok: d2.ok ? 1 : 0,
            pair_level: round(pairLevel, 1e3),
            d1_w: this.take(1),
            d2_w: this.take(2),
        };
        this.n += WAVE_PER_MSG;
        return msg;
    }
}
