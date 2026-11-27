'use client';
// One person's alpha controls, sitting directly above their detector lane and their graph.
//
// Everything that decides whether this person reaches alpha, in one place, with the live
// number next to the numbers that gate it. The lane underneath draws the same two thresholds
// and the same live prominence, so the panel and the picture cannot disagree -- and the line
// in it stays draggable, which is still the quickest way to put a threshold exactly where a
// person's peaks actually get to.
//
// Three ways to set the same thing, on purpose: the mode buttons for the usual two cases,
// the nudge buttons when you want a definite step, and the drag when you want to put the line
// against what you can see on the lane.
import React from 'react';
import type { PersonState } from '@/components/DyadState';
import { MODE_PRESET, type AlphaMode } from '@/lib/dual-alpha/alphaMode';
import Hint, { Info } from './Hint';

/** How much a nudge moves the entry level. */
export const NUDGE_DB = 0.5;

export interface AlphaControlsProps {
    slot: 1 | 2;
    mode: AlphaMode;
    onMode: (mode: AlphaMode) => void;
    enterDb: number;
    exitDb: number;
    onEnterDbChange: (db: number) => void;
    /** Back to whatever this person's mode implies, discarding a drag or a nudge. */
    onResetToMode: () => void;
    person: PersonState | undefined;
    streaming: boolean;
    /** True once this person has run the 15 s check. */
    calibrated: boolean;
    /** Locked by `?enter=` in the address: the controls are shown but cannot change anything. */
    locked?: boolean;
}

const MODES: { mode: AlphaMode; label: string; why: string }[] = [
    { mode: 'open', label: 'eyes open', why: 'what the piece asks of people: watching, calm focus' },
    { mode: 'closed', label: 'eyes closed', why: 'a demonstration, or showing someone their own alpha' },
];

export default function AlphaControls({
    slot, mode, onMode, enterDb, exitDb, onEnterDbChange, onResetToMode,
    person, streaming, calibrated, locked,
}: AlphaControlsProps) {
    const prom = person && Number.isFinite(person.medianPromDb) ? person.medianPromDb : NaN;
    const live = streaming && Number.isFinite(prom);
    const inAlpha = streaming && !!person && person.level > 0;
    // How far off they are, which is the number the operator is really acting on.
    const gap = live ? prom - enterDb : NaN;

    return (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
                {/* live: what this person is doing right now */}
                <span className="flex items-baseline gap-1.5">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full self-center
                        ${inAlpha ? 'bg-green-500' : live ? 'bg-gray-400' : 'bg-gray-300 dark:bg-gray-700'}`} />
                    <Hint
                        bare
                        title="How far above their own background this person's alpha stands"
                        body={<>Decibels over the 1/f background, from the reading electrode, over a 2 s
                            window. It is the blue line on the lane below, and the one number everything
                            else is derived from.
                            <br /><br />
                            Alpha turns on when it crosses the <b>on</b> level and off again below
                            {' '}<b>off</b>. The figure beside it is how far they are from turning on.</>}
                    >
                        <b className="text-sm tabular-nums">{live ? `${prom.toFixed(1)}` : '—'}</b>
                        <span className="text-gray-500"> dB now</span>
                        <Info />
                    </Hint>
                    {live && (
                        <span className={gap >= 0 ? 'text-green-600' : 'text-gray-500'}>
                            {gap >= 0 ? `+${gap.toFixed(1)} over` : `${Math.abs(gap).toFixed(1)} to go`}
                        </span>
                    )}
                    {inAlpha && person && (
                        <span className="text-green-600">· level {person.level.toFixed(2)}</span>
                    )}
                </span>

                <span className="ml-auto flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    {/* mode */}
                    <Hint
                        bare
                        title="How this person is meant to reach alpha"
                        body={<><b>Eyes open is the default</b>, because that is what the piece asks of
                            people: they watch the projection and reach alpha through calm focus on it.
                            Telling them to shut their eyes removes the thing they are responding to.
                            <br /><br />
                            It matters for the numbers. Alpha roughly doubles when the eyes close, and the
                            detector&rsquo;s 5 dB entry level was tuned on eyes-closed recordings — so eyes
                            open, a fixed 5 dB can sit above everything that person produces and the piece
                            never responds to them however relaxed they get.
                            <br /><br />
                            Eyes open sets {MODE_PRESET.open} dB, or just above their own measured eyes-open
                            baseline once they have run Calibrate. More false positives, deliberately.
                            <br /><br />
                            The mode only moves the thresholds. It never touches their ceiling, which is a
                            measurement of the person rather than a decision about the piece.</>}
                    >
                        <span className="inline-flex overflow-hidden rounded-lg border border-gray-300 dark:border-gray-700">
                            {MODES.map((m) => (
                                <button
                                    key={m.mode}
                                    type="button"
                                    disabled={locked}
                                    title={m.why}
                                    onClick={() => onMode(m.mode)}
                                    className={`px-2 py-0.5 disabled:opacity-50 ${mode === m.mode
                                        ? 'bg-indigo-600 text-white'
                                        : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'}`}
                                >
                                    {m.label}
                                </button>
                            ))}
                        </span>
                        <Info />
                    </Hint>

                    {/* the thresholds, with nudges */}
                    <span className="flex items-center gap-1">
                        <Hint
                            title="The alpha on and off levels for this person"
                            body={<>Alpha turns <b>on</b> when their prominence crosses the green line and
                                <b> off</b> again when it falls below the yellow one, {(enterDb - exitDb).toFixed(0)} dB
                                lower so a signal hovering at the boundary does not chatter.
                                <br /><br />
                                Set them three ways, whichever suits: the <b>mode</b> buttons for the usual
                                two cases, these <b>arrows</b> for a definite {NUDGE_DB} dB step, or
                                {' '}<b>drag the green line</b> on the lane below to put it against what you
                                can actually see. The lane redraws as you go.
                                <br /><br />
                                <b>Reset</b> puts them back to what this person&rsquo;s mode implies.</>}
                        >
                            <span className="text-gray-500">on</span>
                        </Hint>
                        <b className="tabular-nums text-green-700 dark:text-green-400">{enterDb.toFixed(1)}</b>
                        <span className="inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700">
                            <button
                                type="button"
                                disabled={locked}
                                aria-label="lower the alpha on level"
                                onClick={() => onEnterDbChange(enterDb - NUDGE_DB)}
                                className="px-1.5 leading-none hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800"
                            >
                                −
                            </button>
                            <button
                                type="button"
                                disabled={locked}
                                aria-label="raise the alpha on level"
                                onClick={() => onEnterDbChange(enterDb + NUDGE_DB)}
                                className="border-l border-gray-300 px-1.5 leading-none hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
                            >
                                +
                            </button>
                        </span>
                        <span className="text-gray-500">off {exitDb.toFixed(1)} dB</span>
                    </span>

                    <button
                        type="button"
                        disabled={locked}
                        onClick={onResetToMode}
                        title={`Back to what "${mode === 'open' ? 'eyes open' : 'eyes closed'}" implies for this person`}
                        className="rounded-lg border border-gray-300 px-2 py-0.5 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
                    >
                        Reset
                    </button>
                </span>
            </div>

            <div className="mt-1 text-[10px] text-gray-500">
                {locked
                    ? <>Locked by <code>?enter=</code> in the address. Remove it to use these controls.</>
                    : calibrated
                        ? <>Person {slot} is calibrated, so these levels came from their own 15 s check.</>
                        : <>Person {slot} has not run Calibrate, so these are the <b>{mode === 'open' ? 'eyes open' : 'eyes closed'}</b> defaults rather than their own measurements.</>}
            </div>
        </div>
    );
}
