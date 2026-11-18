'use client';
// The detector lane under a person's traces (plan §5.2, P5c), on the chart's sweep axis:
// the median prominence of the usable channels, the enter and exit lines, the state band
// (painted back to the first confirming hop), artifact shading, not-ok marks and the
// operator's hand marks for eyes-closed / eyes-open blocks.
import React, { useEffect, useRef } from 'react';
import { runs, type DeviceChart } from '@/lib/dual-alpha/chart';

const DB_MIN = -3, DB_MAX = 15;

export interface DetectorLaneProps {
    chartRef: React.MutableRefObject<DeviceChart | null>;
    enterDb: number;
    exitDb: number;
}

export default function DetectorLane({ chartRef, enterDb, exitDb }: DetectorLaneProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

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
            // labels
            g.fillStyle = 'rgba(128,128,128,1)';
            g.font = `${10 * dpr}px sans-serif`;
            g.fillText(`${enterDb} dB on`, 4 * dpr, Y(enterDb) - 2 * dpr);
            g.fillText(`${exitDb} dB off`, 4 * dpr, Y(exitDb) + 11 * dpr);
        };
        raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
    }, [chartRef, enterDb, exitDb]);

    return (
        <div className="px-1">
            <canvas ref={canvasRef} className="w-full h-20 block rounded border border-gray-200 dark:border-gray-800" />
            <div className="text-[10px] text-gray-500 leading-tight">
                Detector lane: median prominence of the usable electrodes (blue), on/off lines, state (green, top),
                artifact (grey), not ok (red), hand marks (blue = eyes closed, orange = eyes open).
                It shows when the detector <b>decided</b> (2 s window + ~0.26 s confirmation), not when alpha began.
            </div>
        </div>
    );
}
