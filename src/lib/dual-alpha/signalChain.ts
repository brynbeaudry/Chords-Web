// Per-device signal chain of the Dual Alpha page (plan §4.4, §5.4 P2).
// Built from ingestSample / resetSignalChain / the filter set-up of src/app/dual-stream/page.tsx;
// the filter classes are imported from filters.tsx, not copied.
//
// Per sample and channel:
//   raw count -> 1 Hz high-pass (hpOutput) -> detector.push(hpOutput, raw)     [detection]
//                                          -> EEG low-pass 45 Hz (EXGFilter type 3, also
//                                             scales counts x 2/4096) -> mains notch  [display, recorder, TD]
// The display chain is fixed (no per-channel filter buttons). Detection never reads the
// display chain, the chart or the time base, so a replay gives the same readings at any speed.
import { EXGFilter, HighPassFilter, Notch } from '@/components/filters';
import { SpectralAlphaDetector, type AlphaDetectorParams, type AlphaReading } from '@/components/SpectralAlphaDetector';
import { channelQuality, type Quality } from '@/components/DyadState';

export const NUM_CHANNELS = 3;
export const EEG_FILTER_TYPE = 3;                       // EXGFilter: 2nd-order low-pass, 45 Hz
export const UV_PER_COUNT = (3.3 / 4095 / 1470) * 1e6;  // about 0.55 µV per count (approximate, uncalibrated)
const ARTIFACT_HISTORY_S = 10;

export type Mains = 50 | 60;

export interface ChannelStatus {
    reading: AlphaReading | null;   // latest detector reading (null until the 2 s window fills)
    mains50Uv: number;              // pickup at 50 Hz, µV, measured on hpOutput once a second
    mains60Uv: number;
    railed: boolean;                // raw count at 0 or 4095 during the last hop
    artifactShare: number;          // share of the last 10 s of hops with the artifact gate holding
    quality: Quality;
}

export interface IngestResult {
    filtered: number[];                  // display / TD value per channel (today's scale)
    readings: (AlphaReading | null)[];   // a new reading for each channel on a hop, else null
    hop: boolean;                        // true when this sample completed a detector hop
}

/** Amplitude (same units as x) of the component at `hz`, by the Goertzel algorithm. */
export function goertzelAmplitude(x: ArrayLike<number>, hz: number, fs: number): number {
    const n = x.length;
    const w = (2 * Math.PI * hz) / fs, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0, mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    for (let i = 0; i < n; i++) {
        const s0 = x[i] - mean + c * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - c * s1 * s2;
    return (2 * Math.sqrt(Math.max(0, power))) / n;
}

class ChannelChain {
    readonly hp = new HighPassFilter();
    readonly exg = new EXGFilter();
    readonly notch = new Notch();
    detector: SpectralAlphaDetector;
    mainsBuf: Float32Array;
    mainsPos = 0;
    railedHop = false;
    artHist: Uint8Array;
    artPos = 0;
    artCount = 0;
    status: ChannelStatus = emptyStatus();

    constructor(fs: number, params: Partial<AlphaDetectorParams>) {
        this.hp.setSamplingRate(fs);
        this.exg.setbits('12', fs);
        this.notch.setbits(fs);
        this.detector = new SpectralAlphaDetector(fs, params);
        this.mainsBuf = new Float32Array(fs);
        const hopsIn10s = Math.round((ARTIFACT_HISTORY_S * fs) / this.detector.params.hop);
        this.artHist = new Uint8Array(hopsIn10s);
    }
}

function emptyStatus(): ChannelStatus {
    return { reading: null, mains50Uv: 0, mains60Uv: 0, railed: false, artifactShare: 0, quality: 'none' };
}

export class SignalChain {
    private fs: number;
    private mains: Mains;
    private params: Partial<AlphaDetectorParams>;
    private channels: ChannelChain[] = [];

    constructor(fs = 500, mains: Mains = 60, params: Partial<AlphaDetectorParams> = {}) {
        this.fs = fs;
        this.mains = mains;
        this.params = params;
        this.build();
    }

    private build(): void {
        this.channels = Array.from({ length: NUM_CHANNELS }, () => new ChannelChain(this.fs, this.params));
    }

    get samplingRate(): number { return this.fs; }
    get detectorParams(): Readonly<AlphaDetectorParams> { return this.channels[0].detector.params; }
    get status(): ChannelStatus[] { return this.channels.map((c) => c.status); }

    /** Rebuild every filter and detector (sampling-rate change). */
    setSamplingRate(fs: number): void {
        if (fs === this.fs) return;
        this.fs = fs;
        this.build();
    }

    /** Clear all filter and detector history (on connect, and entering or leaving replay). */
    reset(): void {
        this.build();
    }

    ingest(raw: number[]): IngestResult {
        const filtered: number[] = [];
        const readings: (AlphaReading | null)[] = [];
        let hop = false;
        const notchType = this.mains === 50 ? 1 : 2;
        for (let ch = 0; ch < NUM_CHANNELS; ch++) {
            const c = this.channels[ch];
            const sample = raw[ch] ?? 0;
            const hpOutput = c.hp.process(sample);
            filtered.push(c.notch.process(c.exg.process(hpOutput, EEG_FILTER_TYPE), notchType));

            // mains pickup, once a second, on the signal the detector sees
            c.mainsBuf[c.mainsPos++] = hpOutput;
            if (c.mainsPos >= c.mainsBuf.length) {
                c.mainsPos = 0;
                c.status.mains50Uv = goertzelAmplitude(c.mainsBuf, 50, this.fs) * UV_PER_COUNT;
                c.status.mains60Uv = goertzelAmplitude(c.mainsBuf, 60, this.fs) * UV_PER_COUNT;
            }

            if (sample <= 0 || sample >= 4095) c.railedHop = true;
            const r = c.detector.push(hpOutput, sample);
            readings.push(r);
            if (r) {
                hop = true;
                c.artCount += (r.artifact ? 1 : 0) - c.artHist[c.artPos];   // rolling 10 s count
                c.artHist[c.artPos] = r.artifact ? 1 : 0;
                c.artPos = (c.artPos + 1) % c.artHist.length;
                const s = c.status;
                s.reading = r;
                s.railed = c.railedHop;
                s.artifactShare = c.artCount / c.artHist.length;
                s.quality = channelQuality({
                    hasReading: true,
                    mainsUv: Math.max(s.mains50Uv, s.mains60Uv),
                    railed: s.railed,
                    artifactShare: s.artifactShare,
                });
                c.railedHop = false;
            }
        }
        return { filtered, readings, hop };
    }
}
