'use client';
// The guided 15 s check (plan §P6, revised), as a panel the operator reads out to the pair
// sitting down. It shows which phase is running, the seconds left in it, and how many hops
// each person has given, so a headset that is not actually streaming is obvious before the
// check is confirmed.
//
// Each phase spends its first SETTLE_S seconds settling and records nothing, because the
// detector's prominence is a trailing 2 s average and a reading taken sooner than that is
// partly measuring the previous phase. The panel says "settling" while that happens, so an
// operator watching the counts sit at 0 can see why.
//
// The first phase asks for five blinks. That is a liveness check: a blink is the one signal
// we can ask for and be sure of, so if an electrode does not see it, nothing measured after
// it means anything. The panel says so per person while it runs, rather than leaving the
// operator to find out later from a ceiling measured off noise.
//
// "Calibration done" keeps whatever was measured; "Start over" re-enters from the blinks,
// which is what a new pair moving through the piece gets.
import React from 'react';
import { Button } from '@/components/ui/button';
import {
    PHASE_S, SETTLE_S, TOTAL_S, MIN_SAMPLES, BLINKS, type CalPhase,
} from '@/lib/dual-alpha/calibration';
import type { Slot } from '@/lib/dual-alpha/engine';

export interface CalibrationDialogProps {
    phase: CalPhase;
    elapsedS: number;
    counts: Record<Slot, { blink: number; closed: number; open: number; blinkArtifacts: number }>;
    /** Per person: did both measuring phases get enough hops to be trusted? */
    usable: Record<Slot, boolean>;
    /** Per person: did the electrodes respond to the blinks? */
    liveness: Record<Slot, boolean>;
    names: Record<Slot, string>;
    onConfirm: () => void;
    onRestart: () => void;
    onClose: () => void;
}

const SLOTS: Slot[] = [1, 2];

const STEPS: { phase: CalPhase; label: string; tone: string; say: string }[] = [
    {
        phase: 'blink',
        label: `Eyes OPEN — blink ${BLINKS} times`,
        tone: 'bg-sky-600 text-white',
        say: `Eyes open, looking ahead. Blink firmly ${BLINKS} times, about one a second.`,
    },
    {
        phase: 'closed',
        label: 'Eyes CLOSED',
        tone: 'bg-indigo-600 text-white',
        say: 'Eyes closed and relaxed. No talking, no frowning.',
    },
    {
        phase: 'open',
        label: 'Eyes OPEN — still',
        tone: 'bg-amber-500 text-black',
        say: 'Eyes open, looking softly ahead. Try not to blink now.',
    },
];

export default function CalibrationDialog({
    phase, elapsedS, counts, usable, liveness, names, onConfirm, onRestart, onClose,
}: CalibrationDialogProps) {
    if (phase === 'idle') return null;
    const done = phase === 'done';
    const step = STEPS.find((s) => s.phase === phase);
    const stepIndex = STEPS.findIndex((s) => s.phase === phase);
    const phaseEnd = (stepIndex + 1) * PHASE_S;
    const phaseLeft = Math.max(0, Math.ceil(phaseEnd - elapsedS));
    const phaseElapsed = elapsedS - stepIndex * PHASE_S;
    const settling = !done && stepIndex >= 0 && phaseElapsed < SETTLE_S;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            role="dialog" aria-modal="true" aria-label="Alpha calibration">
            <div className="w-full max-w-lg rounded-2xl border border-gray-300 bg-white p-5 text-sm text-gray-900
                            shadow-xl dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
                <h2 className="text-base font-semibold">
                    {done ? 'Calibration finished' : `Calibrating — ${TOTAL_S} second check`}
                </h2>

                {!done && step && (
                    <>
                        <div className="mt-3 flex flex-wrap items-baseline gap-3">
                            <span className={`rounded-lg px-3 py-1 text-lg font-semibold ${step.tone}`}>
                                {step.label}
                            </span>
                            <span className="text-2xl font-mono tabular-nums">{phaseLeft}s</span>
                            <span className="text-gray-500">
                                {Math.min(TOTAL_S, elapsedS).toFixed(0)} / {TOTAL_S}s total
                            </span>
                            {settling && (
                                <span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-600
                                                 dark:bg-gray-800 dark:text-gray-300">
                                    settling — not recording yet
                                </span>
                            )}
                        </div>
                        <p className="mt-1.5 text-gray-700 dark:text-gray-300">{step.say}</p>
                        <div className="mt-2 flex gap-1">
                            {STEPS.map((s) => {
                                const i = STEPS.indexOf(s);
                                const from = i * PHASE_S;
                                const fill = Math.min(100, Math.max(0, ((elapsedS - from) / PHASE_S) * 100));
                                return (
                                    <div key={s.phase} className="h-1.5 flex-1 overflow-hidden rounded bg-gray-200 dark:bg-gray-800">
                                        <div className="h-full bg-indigo-500 transition-[width] duration-200"
                                            style={{ width: `${fill}%` }} />
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}

                <ol className="mt-4 list-decimal space-y-1 pl-5 text-gray-700 dark:text-gray-300">
                    <li>Both people sit still and comfortable, facing forward.</li>
                    <li>
                        <strong>Eyes open, blink {BLINKS} times</strong>, about one a second. This is the check
                        that the electrodes are picking each person up at all.
                    </li>
                    <li><strong>Eyes closed</strong> and relaxed for {PHASE_S} seconds — no talking, no frowning.</li>
                    <li><strong>Eyes open and still</strong> for {PHASE_S} seconds, looking softly ahead.</li>
                    <li>Press <em>Calibration done</em> when the check has finished.</li>
                </ol>
                <p className="mt-2 text-xs text-gray-500">
                    {PHASE_S} seconds a phase, and each one ignores its first {SETTLE_S} while the
                    detector&apos;s 2 s window clears the previous instruction — so only readings that are
                    really about this phase reach the median. The last two phases set each person&apos;s own
                    entry level, exit level and alpha ceiling, so the piece responds to them rather than to an
                    average, which matters most when alpha is weak as it is on a forehead or behind-the-ear
                    electrode. Skipping the check falls back to the 12 dB default for everybody.
                </p>

                <div className="mt-4 space-y-1">
                    {SLOTS.map((s) => {
                        const c = counts[s];
                        const ok = usable[s];
                        const live = liveness[s];
                        return (
                            <div key={s} className="flex flex-wrap items-center gap-2">
                                <span className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-green-500' : 'bg-gray-400'}`} />
                                <span className="font-medium">Person {s}</span>
                                <span className="text-gray-500">{names[s] || 'not connected'}</span>
                                <span className="ml-auto font-mono text-xs tabular-nums text-gray-500">
                                    blink {c.blink} · closed {c.closed} · open {c.open}
                                </span>
                                {c.blink > 0 && (
                                    <span className={`text-xs ${live ? 'text-green-600' : 'text-amber-600'}`}>
                                        {live ? 'blinks seen' : 'no blink response'}
                                    </span>
                                )}
                                {!ok && c.closed + c.open > 0 && (
                                    <span className="text-xs text-amber-600">needs {MIN_SAMPLES}+ in each phase</span>
                                )}
                            </div>
                        );
                    })}
                </div>

                {(phase === 'closed' || phase === 'open' || done) && SLOTS.some((s) => counts[s].blink > 0 && !liveness[s]) && (
                    <p className="mt-2 text-xs text-amber-600">
                        One person&apos;s electrodes did not react to the blinks. A blink is large and
                        unmistakable, so that usually means the electrode is not making contact — not that the
                        person has weak alpha. Anything measured for them after this is measured off noise.
                    </p>
                )}
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
