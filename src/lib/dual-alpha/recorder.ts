// Record and replay for the Dual Alpha page (plan §5.4 P4).
// Built from handleRecord / stopRecording / startReplay / ingestRow of
// src/app/dual-stream/page.tsx. Rows go to IndexedDB through workers/indexedDBWorker.ts
// (reused unchanged) in today's layout, so either page can replay the other's recordings:
//   [slot, tWallMs, tStreamMs, counter, raw0, raw1, raw2, filtered0, filtered1, filtered2]
// Every message sent to TouchDesigner while recording is also captured, one JSON line each:
//   {"t_ms": <ms since the recording started>, "msg": {...contract v2...}}
// and offered as <recording>.td_stream.jsonl when the recording stops.

export type Row = number[];

export interface RecordingMeta {
    samplingRate: number;
    selectedChannels: number[];
    exg: Record<number, number>;
    notch: Record<number, number>;
    startedAtIso: string;
    schemaVersion: number;
    page?: string;
    mains?: number;
    enterDb?: number;
    marks?: HandMark[];
}

/** Eyes-closed / eyes-open blocks marked by hand by the operator (keys on the page). */
export interface HandMark {
    tMs: number;                 // ms since the recording (or replay) started
    kind: 'ec' | 'eo' | 'end';
}

const FLUSH_ROWS = 2000;

/** Parse a recording CSV exported by either page (meta comment line + header + rows). */
export function parseRecordingCsv(text: string): { rows: Row[]; meta: RecordingMeta | null } {
    let meta: RecordingMeta | null = null;
    const rows: Row[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith('# meta:')) {
            try { meta = JSON.parse(line.slice(7)); } catch { /* ignore */ }
            continue;
        }
        if (!/^[-\d]/.test(line)) continue;   // header
        const r = line.split(',').map(Number);
        if (r.length >= 7 && r.every((v) => Number.isFinite(v))) rows.push(r);
    }
    rows.sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0));
    return { rows, meta };
}

function waitFor<T>(w: Worker, match: (d: any) => T | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
        const handler = (e: MessageEvent) => {
            if (e.data?.error) { w.removeEventListener('message', handler); reject(new Error(e.data.error)); return; }
            const v = match(e.data);
            if (v !== undefined) { w.removeEventListener('message', handler); resolve(v); }
        };
        w.addEventListener('message', handler);
    });
}

export class Recorder {
    private worker: Worker | null = null;
    private rows: Row[] = [];
    private jsonl: string[] = [];
    private startMs = 0;
    private meta: RecordingMeta | null = null;
    filename: string | null = null;

    private get w(): Worker {
        if (!this.worker) {
            this.worker = new Worker(new URL('../../../workers/indexedDBWorker.ts', import.meta.url), { type: 'module' });
        }
        return this.worker;
    }

    get isRecording(): boolean { return this.filename !== null; }

    /** ms since the recording started (0 when not recording). */
    elapsedMs(): number { return this.isRecording ? Date.now() - this.startMs : 0; }

    start(meta: Omit<RecordingMeta, 'startedAtIso' | 'schemaVersion'>): string {
        const now = new Date();
        const p = (v: number) => String(v).padStart(2, '0');
        this.filename = `ChordsWeb-DualAlpha-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
            `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.csv`;
        this.startMs = Date.now();
        this.rows = [];
        this.jsonl = [];
        this.meta = { ...meta, startedAtIso: now.toISOString(), schemaVersion: 2, marks: [] };
        this.w.postMessage({ action: 'writeMeta', filename: this.filename, meta: this.meta });
        return this.filename;
    }

    addRow(row: Row): void {
        if (!this.filename) return;
        this.rows.push(row);
        if (this.rows.length >= FLUSH_ROWS) this.flush();
    }

    addMessage(msg: object): void {
        if (!this.filename) return;
        this.jsonl.push(JSON.stringify({ t_ms: this.elapsedMs(), msg }));
    }

    addMark(kind: HandMark['kind']): void {
        if (this.meta) this.meta.marks!.push({ tMs: this.elapsedMs(), kind });
    }

    private flush(): void {
        if (!this.filename || this.rows.length === 0) return;
        this.w.postMessage({ action: 'write', data: this.rows, filename: this.filename });
        this.rows = [];
    }

    /** Stop; returns the CSV filename and the captured td_stream.jsonl text. */
    stop(): { filename: string; jsonl: string } | null {
        if (!this.filename) return null;
        this.flush();
        if (this.meta) this.w.postMessage({ action: 'writeMeta', filename: this.filename, meta: this.meta });
        const out = { filename: this.filename, jsonl: this.jsonl.join('\n') + (this.jsonl.length ? '\n' : '') };
        this.filename = null;
        this.jsonl = [];
        this.meta = null;
        return out;
    }

    async list(): Promise<string[]> {
        const p = waitFor(this.w, (d) => (d && 'allData' in d ? d.allData : undefined));
        this.w.postMessage({ action: 'getFileCountFromIndexedDB' });
        const all = await p;
        return Array.isArray(all) ? all : [];
    }

    async load(filename: string): Promise<{ rows: Row[]; meta: RecordingMeta | null }> {
        const p = waitFor(this.w, (d) => (d?.action === 'loadByFilename' ? d : undefined));
        this.w.postMessage({ action: 'loadByFilename', filename });
        const d = await p;
        const rows = ((d.rows ?? []) as Row[]).filter((r) => Array.isArray(r) && r.length >= 7);
        rows.sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0));
        return { rows, meta: d.meta ?? null };
    }

    async csvBlob(filename: string): Promise<Blob> {
        const p = waitFor(this.w, (d) => (d && 'blob' in d ? d.blob as Blob : undefined));
        this.w.postMessage({ action: 'saveDataByFilename', filename, canvasCount: 3, selectChannel: [1, 2, 3] });
        return p;
    }

    async remove(filename: string): Promise<void> {
        const p = waitFor(this.w, (d) => (d?.action === 'deleteFile' ? true : undefined));
        this.w.postMessage({ action: 'deleteFile', filename });
        await p;
    }

    terminate(): void {
        this.worker?.terminate();
        this.worker = null;
    }
}

/**
 * Plays recorded rows back at their recorded pace (times `speed`). Each due row goes to
 * `onRow`; the detector is sample-driven, so readings do not depend on the pace.
 */
export class Replayer {
    private rows: Row[] = [];
    private idx = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private baseMs = 0;
    private startedAt = 0;
    private pausedAt: number | null = null;
    private readonly onRow: (row: Row) => void;
    private readonly onEnd: () => void;
    speed = 1;

    constructor(onRow: (row: Row) => void, onEnd: () => void) {
        this.onRow = onRow;
        this.onEnd = onEnd;
    }

    get progress(): { cur: number; total: number } {
        const total = this.rows.length ? this.rows[this.rows.length - 1][1] - this.rows[0][1] : 0;
        const cur = this.idx < this.rows.length && this.rows.length ? this.rows[this.idx][1] - this.rows[0][1] : total;
        return { cur, total };
    }

    get active(): boolean { return this.timer !== null; }
    get paused(): boolean { return this.pausedAt !== null; }

    start(rows: Row[]): void {
        this.stop();
        this.rows = rows;
        this.idx = 0;
        this.baseMs = rows[0]?.[1] ?? 0;
        this.startedAt = performance.now();
        this.pausedAt = null;
        this.timer = setInterval(() => this.drain(), 8);
    }

    togglePause(): void {
        if (!this.active) return;
        if (this.pausedAt === null) {
            this.pausedAt = performance.now();
        } else {
            this.startedAt += performance.now() - this.pausedAt;
            this.pausedAt = null;
        }
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.rows = [];
        this.idx = 0;
        this.pausedAt = null;
    }

    private drain(): void {
        if (this.pausedAt !== null) return;
        const due = this.baseMs + (performance.now() - this.startedAt) * this.speed;
        while (this.idx < this.rows.length && (this.rows[this.idx][1] ?? 0) <= due) {
            this.onRow(this.rows[this.idx++]);
        }
        if (this.idx >= this.rows.length) {
            this.stop();
            this.onEnd();
        }
    }
}
