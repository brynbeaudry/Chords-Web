'use client';
// The detector lane under a person's traces (plan §5.2, P5c), on the chart's sweep axis:
// the median prominence of the usable channels, the enter and exit lines, the state band
// (painted back to the first confirming hop), artifact shading, not-ok marks and the
// operator's hand marks for eyes-closed / eyes-open blocks.
import React, { useEffect, useRef } from 'react';
import { runs, type DeviceChart } from '@/lib/dual-alpha/chart';
import { MIN_ENTER_DB, MAX_ENTER_DB } from '@/lib/dual-alpha/alphaMode';

const DB_MIN = -3, DB_MAX = 15;

/** One entry in the inline key: a swatch in the colour this lane actually paints, and a label. */
function Key({ css, kind = 'block', children }: { css: string; kind?: 'block' | 'line' | 'dash'; children: React.ReactNode }) {
    return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
            {kind === 'block'
                ? <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: css }} />
                : <span className="inline-block h-2.5 w-4 relative">
                    <span className="absolute left-0 right-0 top-1/2 border-t-2"
                        style={{ borderColor: css, borderStyle: kind === 'dash' ? 'dashed' : 'solid' }} />
                </span>}
            {children}
        </span>
    );
}

/** Plot-area geometry in CSS pixels; these match `band` and the padding in the draw code. */
const BAND_CSS = 6, PAD_CSS = 2;



export interface DetectorLaneProps {
    chartRef: React.MutableRefObject<DeviceChart | null>;
    enterDb: number;
    exitDb: number;
    /**
     * Called while the operator drags the on-line. The exit level follows 3 dB below, as it
     * does everywhere else, so there is one number to think about rather than two.
     *
     * Dragging is the fastest honest way to make a weak signal reach the piece: the line is
     * already drawn against that person's live prominence, so you can put it just under where
     * their peaks actually get to and watch the result immediately.
     */
    onEnterDbChange?: (db: number) => void;
}

export default function DetectorLane({ chartRef, enterDb, exitDb, onEnterDbChange }: DetectorLaneProps) {
    const editable = !!onEnterDbChange;
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const dragging = useRef(false);
    const [hot, setHot] = React.useState(false);

    // The same mapping the draw code uses, in CSS pixels rather than device pixels.
    const edges = (): { top: number; bottom: number; rect: DOMRect } | null => {
        const cv = canvasRef.current;
        if (!cv) return null;
        const rect = cv.getBoundingClientRect();
        return { top: BAND_CSS + PAD_CSS, bottom: rect.height - BAND_CSS - PAD_CSS, rect };
    };

    const dbAt = (clientY: number): number => {
        const e = edges();
        if (!e) return enterDb;
        const f = 1 - (clientY - e.rect.top - e.top) / Math.max(1, e.bottom - e.top);
        return Math.min(MAX_ENTER_DB, Math.max(MIN_ENTER_DB, DB_MIN + f * (DB_MAX - DB_MIN)));
    };

    const near = (clientY: number): boolean => {
        const e = edges();
        if (!e) return false;
        const y = e.top + (1 - (enterDb - DB_MIN) / (DB_MAX - DB_MIN)) * (e.bottom - e.top);
        return Math.abs(clientY - e.rect.top - y) <= 10;
    };

    useEffect(() => {
        let raf = 0;
        const draw = () => {
            raf = requestAnimationFrame(draw);
            const cv = canvasRef.current, chart = chartRef.current;
            if (!cv || !chart) return;
            const dpr = window.devicePixelRatio || 1;
            const W = Math.max(1, Math.round(cv.clientWidth * dpr)), H = Math.max(1, Math.round(cv.clientHeight * dpr));
            if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
            const g = cv.getContext('2d');
            if (!g) return;
            const L = chart.lane, n = L.length;
            const gap = Math.ceil(n / 100) + 1;
            const X = (i: number) => (i / n) * W;
            const band = 6 * dpr;
            const top = band + 2 * dpr, bottom = H - band - 2 * dpr;
            const Y = (db: number) => top + (1 - (Math.min(DB_MAX, Math.max(DB_MIN, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * (bottom - top);
            g.clearRect(0, 0, W, H);

            // artifact shading
            runs(L.artifact, n, L.pos, gap, (a, b, v) => {
                if (!v) return;
                g.fillStyle = 'rgba(128,128,128,0.22)';
                g.fillRect(X(a), top, X(b) - X(a), bottom - top);
            });
            // state band (top)
            runs(L.level, n, L.pos, gap, (a, b, v) => {
                if (v <= 0) return;
                g.fillStyle = `rgba(34,197,94,${0.3 + 0.7 * v})`;
                g.fillRect(X(a), 0, X(b) - X(a), band);
            });
            // not ok (bottom, left half of the band) and hand marks (bottom)
            runs(L.ok, n, L.pos, gap, (a, b, v) => {
                if (v !== 0) return;
                g.fillStyle = 'rgba(220,38,38,0.8)';
                g.fillRect(X(a), H - band, X(b) - X(a), band / 2);
            });
            runs(L.mark, n, L.pos, gap, (a, b, v) => {
                if (!v) return;
                g.fillStyle = v === 1 ? 'rgba(59,130,246,0.9)' : 'rgba(249,115,22,0.9)';
                g.fillRect(X(a), H - band / 2, X(b) - X(a), band / 2);
            });
            // thresholds
            g.lineWidth = dpr;
            g.setLineDash([4 * dpr, 4 * dpr]);
            for (const [db, col] of [[enterDb, 'rgba(34,197,94,0.9)'], [exitDb, 'rgba(234,179,8,0.9)'], [0, 'rgba(128,128,128,0.5)']] as const) {
                g.strokeStyle = col;
                g.beginPath();
                g.moveTo(0, Y(db));
                g.lineTo(W, Y(db));
                g.stroke();
            }
            g.setLineDash([]);
            // prominence line
            g.strokeStyle = 'rgba(99,102,241,1)';
            g.lineWidth = 1.5 * dpr;
            g.beginPath();
            let pen = false;
            for (let i = 0; i < n; i++) {
                const blank = ((i - L.pos + n) % n) < gap;
                const v = L.prom[i];
                if (blank || Number.isNaN(v)) { pen = false; continue; }
                if (pen) g.lineTo(X(i), Y(v)); else g.moveTo(X(i), Y(v));
                pen = true;
            }
            g.stroke();
            // A grab handle on the on-line, so it is visible that the line can be moved and
            // obvious where to take hold of it.
            if (editable) {
                const hy = Y(enterDb);
                g.fillStyle = hot ? 'rgba(34,197,94,1)' : 'rgba(34,197,94,0.75)';
                const hw = 22 * dpr, hh = 7 * dpr;
                g.beginPath();
                g.moveTo(W - hw, hy - hh);
                g.lineTo(W, hy - hh);
                g.lineTo(W, hy + hh);
                g.lineTo(W - hw, hy + hh);
                g.closePath();
                g.fill();
                g.fillStyle = 'rgba(255,255,255,0.95)';
                for (const dy of [-2.5, 0, 2.5]) {
                    g.fillRect(W - hw + 6 * dpr, hy + dy * dpr - 0.5 * dpr, 10 * dpr, dpr);
                }
            }
            // labels
            g.fillStyle = 'rgba(128,128,128,1)';
            g.font = `${10 * dpr}px sans-serif`;
            g.fillText(`${enterDb.toFixed(1)} dB on`, 4 * dpr, Y(enterDb) - 2 * dpr);
            g.fillText(`${exitDb.toFixed(1)} dB off`, 4 * dpr, Y(exitDb) + 11 * dpr);
        };
        raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
    }, [chartRef, enterDb, exitDb, editable, hot]);

    return (
        <div className="px-1">
            <canvas
                ref={canvasRef}
                className={`w-full ${editable ? 'h-28' : 'h-20'} block rounded border border-gray-200 dark:border-gray-800
                    ${editable ? (hot ? 'cursor-ns-resize' : 'cursor-default') : ''}`}
                onPointerDown={(e) => {
                    // Only grab when the pointer is actually on the line, so a stray click on
                    // the lane during a show cannot move the threshold.
                    if (!editable || !near(e.clientY)) return;
                    dragging.current = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    onEnterDbChange!(dbAt(e.clientY));
                }}
                onPointerMove={(e) => {
                    if (!editable) return;
                    if (dragging.current) onEnterDbChange!(dbAt(e.clientY));
                    else setHot(near(e.clientY));
                }}
                onPointerUp={(e) => {
                    dragging.current = false;
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onPointerLeave={() => setHot(false)}
            />
            {/* Inline key. The full explanation of each mark, and what TouchDesigner does with
                it, is in the Legend panel at the top of the page. */}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-gray-500 leading-tight">
                <span className="font-semibold text-gray-600 dark:text-gray-400">Detector lane</span>
                <Key css="rgb(99,102,241)" kind="line">prominence, dB above background</Key>
                <Key css="rgb(34,197,94)" kind="dash">
                    on at {enterDb.toFixed(1)} dB
                    {editable && (
                        <span className={hot ? 'font-semibold text-green-600' : 'text-gray-400'}> — drag me</span>
                    )}
                </Key>
                <Key css="rgb(234,179,8)" kind="dash">off at {exitDb.toFixed(1)} dB</Key>
                <Key css="rgba(128,128,128,0.8)" kind="dash">0 dB</Key>
                <Key css="rgba(34,197,94,0.85)">in alpha (top) — this is the level TD gets</Key>
                <Key css="rgba(128,128,128,0.45)">artifact: decision held</Key>
                <Key css="rgba(220,38,38,0.85)">not ok: TD greys this side</Key>
                <Key css="rgb(37,99,235)">your mark: eyes closed</Key>
                <Key css="rgb(249,115,22)">eyes open</Key>
            </div>
            <div className="text-[10px] text-gray-500 leading-tight">
                Scale −3 to 15 dB. It shows when the detector <b>decided</b> (2 s window + ~0.26 s
                confirmation), not when alpha began.
            </div>
        </div>
    );
}
