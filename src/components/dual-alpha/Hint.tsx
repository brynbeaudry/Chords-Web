'use client';
// A hover/focus tooltip for the dual-alpha page. Every status word and coloured mark on the
// page is wrapped in one of these, because none of them mean anything on their own: what the
// operator actually needs to know is what TouchDesigner does with the value.
//
// Pure CSS (group-hover / group-focus-within), so it also opens from the keyboard and costs
// nothing per frame -- this page already redraws two WebGL charts and two lanes at 60 fps.
import React from 'react';

export interface HintProps {
    /** The visible text or mark. */
    children: React.ReactNode;
    /** Bold first line of the card. */
    title: string;
    /** The explanation. Keep the TouchDesigner consequence in here. */
    body: React.ReactNode;
    className?: string;
    /** Open to the right edge instead of the left, for things near the end of a row. */
    right?: boolean;
    wide?: boolean;
    /** Skip the dotted underline (for swatches and dots, where it looks like noise). */
    bare?: boolean;
}

export default function Hint({ children, title, body, className = '', right, wide, bare }: HintProps) {
    return (
        <span className={`group relative inline-flex items-center hover:z-50 focus-within:z-50 ${className}`}>
            <span
                tabIndex={0}
                className={`inline-flex items-center gap-1 cursor-help outline-none rounded
                    focus-visible:ring-1 focus-visible:ring-blue-500
                    ${bare ? '' : 'underline decoration-dotted underline-offset-2 decoration-gray-400'}`}
            >
                {children}
            </span>
            <span
                role="tooltip"
                className={`pointer-events-none absolute top-full mt-1 ${right ? 'right-0' : 'left-0'}
                    hidden group-hover:block group-focus-within:block
                    ${wide ? 'w-[28rem]' : 'w-72'} max-w-[85vw]
                    rounded-lg border border-gray-300 dark:border-gray-700
                    bg-white dark:bg-gray-900 px-2.5 py-2 shadow-xl
                    text-left text-[11px] font-normal leading-snug text-gray-700 dark:text-gray-200`}
            >
                <b className="block mb-1 text-gray-900 dark:text-gray-100">{title}</b>
                {body}
            </span>
        </span>
    );
}

/**
 * The marker that carries a hint on a *live value*.
 *
 * Values must never get the dotted underline. A number that changes four times a second reads
 * as a static label the moment it is decorated like one — which is exactly what happened the
 * first time these tooltips went in: the `ok` / `level` / `electrodes` readouts looked frozen
 * even though they were updating. So the value stays plain and this sits beside it.
 */
export function Info() {
    return (
        <span aria-hidden className="ml-0.5 self-start text-[9px] leading-none text-gray-400 dark:text-gray-500">
            ⓘ
        </span>
    );
}

/** A colour chip matching one of the marks the charts actually paint. */
export function Swatch({ css, kind = 'block' }: { css: string; kind?: 'block' | 'line' | 'dash' }) {
    if (kind === 'block') {
        return <span className="inline-block h-3 w-5 shrink-0 rounded-sm border border-gray-300 dark:border-gray-700"
            style={{ background: css }} />;
    }
    return <span className="inline-block h-3 w-5 shrink-0 relative">
        <span className="absolute left-0 right-0 top-1/2 h-0 border-t-2"
            style={{ borderColor: css, borderStyle: kind === 'dash' ? 'dashed' : 'solid' }} />
    </span>;
}

/** Diagonal hatching, as `chart.ts` paints it under a not-ok person strip. */
export function Hatch() {
    return <span className="inline-block h-3 w-5 shrink-0 rounded-sm border border-gray-300 dark:border-gray-700"
        style={{ background: 'repeating-linear-gradient(45deg, rgba(120,120,120,0.9) 0 2px, transparent 2px 4px)' }} />;
}
