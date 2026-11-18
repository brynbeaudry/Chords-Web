// The Dual Alpha chart for one device (plan §5.2, §5.4 P3).
// Built from the plot set-up (createDeviceCanvases), updateDevicePlots and animate of
// src/app/dual-stream/page.tsx: one WebGL sweep trace per channel, the same scale as today.
// Drawn over it on a 2D canvas, from the detector's hop states:
//   - a person strip on top (the vote), opacity following `level`; grey hatching when not ok
//   - per-channel alpha highlight, opacity following that channel's level
//   - both start at the first confirming hop (backfilled when the flag switches on)
//   - grey artifact shading where the gate is holding the previous decision
//   - a red railed marker where a raw count hit 0 or 4095
// The chart only displays: rebuilding it for a new time base or zoom never touches the
// signal chain or the detectors (D7).
import { WebglPlot, WebglLine, ColorRGBA } from 'webgl-plot';
import { getCustomColor } from '@/components/Colors';

export const STRIP_PX = 12;

export interface ChannelHop {
    level: number;        // 0 = not in alpha
    artifact: boolean;
    railed: boolean;
    turnedOn: boolean;    // the flag switched on at this hop: backfill to the first confirming hop
}

export interface PersonHop {
    level: number;
    ok: boolean;
    turnedOn: boolean;
    medianPromDb: number; // NaN when no usable channel
}

export interface ChartOptions {
    container: HTMLElement;
    fs: number;
    timeBaseS: number;
    zoom: number;
    dark: boolean;
    channels: number;
    labels: string[];
    hop: number;          // detector hop, samples
    backfill: number;     // samples before a hop's own 64 to paint when the flag switches on
}

export type HandMarkKind = 0 | 1 | 2;   // none, eyes closed, eyes open

/** Per-sample rings shared with the detector lane; index = sweep position. */
export interface LaneRings {
    length: number;
    pos: number;
    prom: Float32Array;   // person median promDb (NaN = none)
    level: Float32Array;  // person level (0 = not in alpha)
    ok: Uint8Array;       // 1 ok, 0 not ok, 2 no data yet
    artifact: Uint8Array; // any channel artifact
    mark: Uint8Array;     // HandMarkKind
}

function lineColor(i: number, dark: boolean): ColorRGBA {
    const hex = getCustomColor(i, dark ? 'dark' : 'light');
    return new ColorRGBA(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255,
        parseInt(hex.slice(5, 7), 16) / 255, dark ? 1 : 0.8);
}

export class DeviceChart {
    readonly dp: number;
    private readonly o: ChartOptions;
    private plots: WebglPlot[] = [];
    private lines: WebglLine[] = [];
    private overlay: HTMLCanvasElement;
    private rowsEl: HTMLDivElement;
    private pos = 0;
    private chLevel: Float32Array[];
    private chArt: Uint8Array[];
    private chRail: Uint8Array[];
    readonly lane: LaneRings;
    private currentMark: HandMarkKind = 0;

    constructor(o: ChartOptions) {
        this.o = o;
        this.dp = Math.round(o.fs * o.timeBaseS);
        const c = o.container;
        c.innerHTML = '';
        c.style.position = 'relative';

        this.rowsEl = document.createElement('div');
        this.rowsEl.style.cssText = `position:absolute;left:0;right:0;bottom:0;top:${STRIP_PX}px;display:flex;flex-direction:column;`;
        c.appendChild(this.rowsEl);
        for (let ch = 0; ch < o.channels; ch++) {
            const row = document.createElement('div');
            row.style.cssText = 'position:relative;flex:1 1 0;min-height:0;';
            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'width:100%;height:100%;display:block;';
            canvas.width = Math.max(1, c.clientWidth);
            canvas.height = Math.max(1, Math.floor((c.clientHeight - STRIP_PX) / o.channels));
            const badge = document.createElement('div');
            badge.textContent = o.labels[ch] ?? `CH${ch + 1}`;
            badge.style.cssText = 'position:absolute;left:6px;top:4px;font-size:11px;color:#888;z-index:6;';
            row.appendChild(canvas);
            row.appendChild(badge);
            this.rowsEl.appendChild(row);
            const plot = new WebglPlot(canvas);
            plot.gScaleY = o.zoom;
            const line = new WebglLine(lineColor(ch, o.dark), this.dp);
            line.lineSpaceX(-1, 2 / this.dp);
            for (let i = 0; i < this.dp; i++) line.setY(i, NaN);
            plot.addLine(line);
            this.plots.push(plot);
            this.lines.push(line);
        }

        this.overlay = document.createElement('canvas');
        this.overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;';
        c.appendChild(this.overlay);

        const ring = () => new Float32Array(this.dp);
        this.chLevel = Array.from({ length: o.channels }, ring);
        this.chArt = Array.from({ length: o.channels }, () => new Uint8Array(this.dp));
        this.chRail = Array.from({ length: o.channels }, () => new Uint8Array(this.dp));
        this.lane = {
            length: this.dp, pos: 0,
            prom: new Float32Array(this.dp).fill(NaN), level: ring(),
            ok: new Uint8Array(this.dp).fill(2), artifact: new Uint8Array(this.dp), mark: new Uint8Array(this.dp),
        };
    }

    setZoom(z: number): void {
        this.plots.forEach((p) => { p.gScaleY = z; });
    }

    setMark(m: HandMarkKind): void { this.currentMark = m; }

    /** One display sample per channel (the filtered value, today's scale). */
    pushSample(filtered: number[]): void {
        const p = this.pos;
        const gap = Math.ceil(this.dp / 100);
        this.lines.forEach((line, ch) => {
            line.setY(p, filtered[ch] ?? 0);
            line.setY((p + gap) % this.dp, NaN);
        });
        this.lane.mark[p] = this.currentMark;
        this.pos = (p + 1) % this.dp;
        this.lane.pos = this.pos;
    }

    /** Paint the detector state of the hop that just finished (the last `hop` samples). */
    pushHop(channels: ChannelHop[], person: PersonHop): void {
        const { hop, backfill } = this.o;
        const paint = (from: number, n: number, fn: (i: number) => void) => {
            for (let k = 0; k < n; k++) fn((from + k + this.dp * 4) % this.dp);
        };
        const start = this.pos - hop;
        channels.forEach((h, ch) => {
            paint(start, hop, (i) => {
                this.chLevel[ch][i] = h.level;
                this.chArt[ch][i] = h.artifact ? 1 : 0;
                this.chRail[ch][i] = h.railed ? 1 : 0;
            });
            if (h.turnedOn && h.level > 0) paint(start - backfill, backfill, (i) => { this.chLevel[ch][i] = h.level; });
        });
        const anyArt = channels.some((h) => h.artifact);
        paint(start, hop, (i) => {
            this.lane.level[i] = person.level;
            this.lane.ok[i] = person.ok ? 1 : 0;
            this.lane.prom[i] = person.medianPromDb;
            this.lane.artifact[i] = anyArt ? 1 : 0;
        });
        if (person.turnedOn && person.level > 0) paint(start - backfill, backfill, (i) => { this.lane.level[i] = person.level; });
    }

    /** Called every animation frame. */
    draw(): void {
        this.plots.forEach((p) => p.update());
        const cv = this.overlay;
        const dpr = window.devicePixelRatio || 1;
        const W = Math.max(1, Math.round(cv.clientWidth * dpr)), H = Math.max(1, Math.round(cv.clientHeight * dpr));
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
        const g = cv.getContext('2d');
        if (!g) return;
        g.clearRect(0, 0, W, H);
        const strip = STRIP_PX * dpr;
        const rowH = (H - strip) / this.o.channels;
        const gap = Math.ceil(this.dp / 100) + 1;

        // person strip
        runs(this.lane.level, this.dp, this.pos, gap, (a, b, v) => {
            if (v <= 0) return;
            g.fillStyle = `rgba(34,197,94,${0.25 + 0.75 * v})`;
            g.fillRect(x(a, W, this.dp), 0, x(b, W, this.dp) - x(a, W, this.dp), strip - 2 * dpr);
        });
        runs(this.lane.ok, this.dp, this.pos, gap, (a, b, v) => {
            if (v !== 0) return;
            g.fillStyle = 'rgba(120,120,120,0.7)';
            g.fillRect(x(a, W, this.dp), strip - 4 * dpr, x(b, W, this.dp) - x(a, W, this.dp), 3 * dpr);
        });

        for (let ch = 0; ch < this.o.channels; ch++) {
            const y0 = strip + ch * rowH;
            runs(this.chLevel[ch], this.dp, this.pos, gap, (a, b, v) => {
                if (v <= 0) return;
                g.fillStyle = `rgba(34,197,94,${0.1 + 0.3 * v})`;
                g.fillRect(x(a, W, this.dp), y0, x(b, W, this.dp) - x(a, W, this.dp), rowH);
            });
            runs(this.chArt[ch], this.dp, this.pos, gap, (a, b, v) => {
                if (!v) return;
                g.fillStyle = 'rgba(128,128,128,0.28)';
                g.fillRect(x(a, W, this.dp), y0, x(b, W, this.dp) - x(a, W, this.dp), rowH);
            });
            runs(this.chRail[ch], this.dp, this.pos, gap, (a, b, v) => {
                if (!v) return;
                g.fillStyle = 'rgba(220,38,38,0.9)';
                g.fillRect(x(a, W, this.dp), y0 + rowH - 4 * dpr, x(b, W, this.dp) - x(a, W, this.dp), 4 * dpr);
            });
            if (ch > 0) {
                g.fillStyle = 'rgba(128,128,128,0.3)';
                g.fillRect(0, y0, W, 1);
            }
        }
    }

    destroy(): void {
        this.plots.forEach((p) => { try { p.removeAllLines(); } catch { /* noop */ } });
        this.o.container.querySelectorAll('canvas').forEach((cv) => {
            const gl = (cv as HTMLCanvasElement).getContext('webgl');
            gl?.getExtension('WEBGL_lose_context')?.loseContext();
        });
        this.o.container.innerHTML = '';
    }
}

const x = (i: number, W: number, dp: number) => (i / dp) * W;

/**
 * Calls fn(start, end, value) for each run of equal values (levels quantised to 1/20),
 * skipping the blank gap just ahead of the sweep position.
 */
export function runs(a: ArrayLike<number>, n: number, pos: number, gap: number,
    fn: (start: number, end: number, value: number) => void): void {
    const q = (v: number) => (Number.isNaN(v) ? NaN : Math.round(v * 20) / 20);
    let start = -1, val = NaN;
    for (let i = 0; i <= n; i++) {
        const blank = i < n && ((i - pos + n) % n) < gap;
        const v = i < n && !blank ? q(a[i]) : NaN;
        if (start >= 0 && !(v === val)) { fn(start, i, val); start = -1; }
        if (start < 0 && !Number.isNaN(v)) { start = i; val = v; }
    }
}
