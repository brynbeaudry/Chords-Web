'use client';
// The guided 20 s check (plan §P6), as a panel the operator reads out to the pair sitting down.
// It shows which half is running, the seconds left, and how many hops each person has given,
// so a headset that is not actually streaming is obvious before the check is confirmed.
// "Calibration done" keeps whatever was measured; "Start over" re-enters the eyes-closed half,
// which is what a new pair moving through the piece gets.
import React from 'react';
import { Button } from '@/components/ui/button';
import { CLOSED_S, TOTAL_S, MIN_SAMPLES, type CalPhase } from '@/lib/dual-alpha/calibration';
import type { Slot } from '@/lib/dual-alpha/engine';

export interface CalibrationDialogProps {
    phase: CalPhase;
    elapsedS: number;
    counts: Record<Slot, { closed: number; open: number }>;
    /** Per person: did both halves get enough hops to be trusted? */
    usable: Record<Slot, boolean>;
    names: Record<Slot, string>;
    onConfirm: () => void;
    onRestart: () => void;
    onClose: () => void;
}

const SLOTS: Slot[] = [1, 2];

export default function CalibrationDialog({
    phase, elapsedS, counts, usable, names, onConfirm, onRestart, onClose,
}: CalibrationDialogProps) {
    if (phase === 'idle') return null;
    const done = phase === 'done';
    const closed = phase === 'closed';
    const phaseLeft = Math.max(0, Math.ceil(closed ? CLOSED_S - elapsedS : TOTAL_S - elapsedS));

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            role="dialog" aria-modal="true" aria-label="Alpha calibration">
            <div className="w-full max-w-lg rounded-2xl border border-gray-300 bg-white p-5 text-sm text-gray-900
                            shadow-xl dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
                <h2 className="text-base font-semibold">
                    {done ? 'Calibration finished' : 'Calibrating — 20 second check'}
                </h2>

                {!done && (
                    <>
                        <div className="mt-3 flex items-baseline gap-3">
                            <span className={`rounded-lg px-3 py-1 text-lg font-semibold
                                ${closed ? 'bg-indigo-600 text-white' : 'bg-amber-500 text-black'}`}>
                                {closed ? 'Eyes CLOSED' : 'Eyes OPEN'}
                            </span>
                            <span className="text-2xl font-mono tabular-nums">{phaseLeft}s</span>
                            <span className="text-gray-500">
                                {Math.min(TOTAL_S, elapsedS).toFixed(0)} / {TOTAL_S}s total
                            </span>
                        </div>
                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-800">
                            <div className="h-full bg-indigo-500 transition-[width] duration-200"
                                style={{ width: `${Math.min(100, (elapsedS / TOTAL_S) * 100)}%` }} />
                        </div>
                    </>
                )}

                <ol className="mt-4 list-decimal space-y-1 pl-5 text-gray-700 dark:text-gray-300">
                    <li>Both people sit still and comfortable, facing forward.</li>
                    <li><strong>Eyes closed</strong> and relaxed for the first 10 seconds — no talking, no frowning.</li>
                    <li><strong>Eyes open</strong> for the last 10 seconds, looking softly ahead without staring.</li>
                    <li>Press <em>Calibration done</em> when the check has finished.</li>
                </ol>
                <p className="mt-2 text-xs text-gray-500">
                    This sets each person&apos;s own alpha ceiling from their eyes-closed reading, so the piece
                    responds to them rather than to an average. Skipping it falls back to the 12 dB default.
                </p>

                <div className="mt-4 space-y-1">
                    {SLOTS.map((s) => {
                        const c = counts[s];
                        const ok = usable[s];
                        return (
                            <div key={s} className="flex items-center gap-2">
                                <span className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-green-500' : 'bg-gray-400'}`} />
                                <span className="font-medium">Person {s}</span>
                                <span className="text-gray-500">{names[s] || 'not connected'}</span>
                                <span className="ml-auto font-mono text-xs tabular-nums text-gray-500">
                                    closed {c.closed} · open {c.open}
                                </span>
                                {!ok && (
                                    <span className="text-xs text-amber-600">
                                        needs {MIN_SAMPLES}+ in each half
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
                {!usable[1] && !usable[2] && (
                    <p className="mt-2 text-xs text-amber-600">
                        No usable readings yet. A person with no counts is not streaming — check the headset
                        before confirming, or both will stay uncalibrated.
                    </p>
                )}

                <div className="mt-5 flex flex-wrap gap-2">
                    {!done && (
                        <Button className="rounded-xl" onClick={onConfirm}>Calibration done</Button>
                    )}
                    <Button variant="outline" className="rounded-xl" onClick={onRestart}>Start over</Button>
                    <Button variant="outline" className="rounded-xl" onClick={onClose}>
                        {done ? 'Close' : 'Cancel'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
