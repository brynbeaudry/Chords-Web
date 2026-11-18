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
export const MAIN_CHANNEL = 1;   // Oz: channel 1 (0-based) of each headset, the waveform sent to TD
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
    dyad: DyadResult;

    private readonly decimators: Record<Slot, WaveDecimator> = { 1: new WaveDecimator(), 2: new WaveDecimator() };
    private readonly waveQueue: Record<Slot, number[]> = { 1: [], 2: [] };
    private readonly lastWave: Record<Slot, number> = { 1: 0, 2: 0 };
    private readonly lastT: Record<Slot, number> = { 1: -Infinity, 2: -Infinity };
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
     * Feed one sample of one device. `tMs` is the sample's time (performance.now() live,
     * the recorded time in a replay). Returns the filtered values, a hop event when the
     * detectors updated, and a message when one is due.
     */
    ingest(slot: Slot, raw: number[], tMs: number): { result: IngestResult; hop: HopEvent | null; message: TdMessageV2 | null } {
        this.lastT[slot] = tMs;
        const result = this.chains[slot].ingest(raw);

        const q = this.waveQueue[slot];
        const batch = this.decimators[slot].push(result.filtered[MAIN_CHANNEL]);
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
