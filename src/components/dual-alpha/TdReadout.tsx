'use client';
// "Is this device detecting alpha, and how much, and what is TouchDesigner doing about it?"
//
// Everything else on this page shows the signal. This shows the *five numbers that leave the
// page* and what the piece does with them, because that is the question during a show and it
// was not answerable from the graphs. The wording matches OPERATOR_GUIDE.md section 6.1 (the
// visuals) and section 5 (the sound); `calm` is the SYNCD expression 1 - 0.7 * level.
import React from 'react';
import type { PersonState } from '@/components/DyadState';
import Hint, { Info } from './Hint';

// The same scale the detector lane draws on, so the bar here and the blue line there agree.
const DB_MIN = -3, DB_MAX = 15;
const pct = (db: number) => Math.min(100, Math.max(0, ((db - DB_MIN) / (DB_MAX - DB_MIN)) * 100));

export interface TdReadoutProps {
    slot: 1 | 2;
    person: PersonState | undefined;
    streaming: boolean;
    /** The 20 s check's eyes-closed median, if this person ran one. */
    ceilingDb: number | undefined;
    defaultCeilingDb: number;
    enterDb: number;
    exitDb: number;
    /** Label of the electrode whose waveform is actually going to TouchDesigner. */
    waveLabel?: string;
}

/**
 * What this person's level is doing to the mix (guide section 5). The sound has no sides -- it
 * is a mono mix sent to both output channels -- so this does not follow the projection's
 * left/right, where person 1 is the left side.
 */
const SOUND: Record<1 | 2, string> = {
    1: 'hats, how far the kick opens the bass filter, treble EQ',
    2: 'kick weight, bass level, distortion, bass EQ',
};

function depth(level: number): string {
    if (level <= 0) return 'no alpha';
    if (level < 0.25) return 'just over the line';
    if (level < 0.6) return 'clearly in alpha';
    return 'deep in alpha';
}

export default function TdReadout({
    slot, person, streaming, ceilingDb, defaultCeilingDb, enterDb, exitDb, waveLabel,
}: TdReadoutProps) {
    const lvl = streaming && person ? person.level : 0;
    const ok = streaming && !!person?.ok;
    const prom = person && Number.isFinite(person.medianPromDb) ? person.medianPromDb : NaN;
    const ceiling = ceilingDb ?? defaultCeilingDb;
    const calm = 1 - 0.7 * lvl;
    const other = slot === 1 ? 2 : 1;

    // One sentence for what the piece is doing with this side right now.
    let verdict: string, tone: string;
    if (!streaming) {
        verdict = 'no data leaving the page for this side — TouchDesigner holds the last value for 1 s, then '
            + 'this side goes grey; with neither side sending it mutes the sound and swaps to the idle scene';
        tone = 'text-gray-500';
    } else if (!ok) {
        verdict = `d${slot}_ok is 0, so TouchDesigner fades this side to grey and turns the head away — a lost `
            + 'signal must never look like calm. Fix the electrode before reading anything else here';
        tone = 'text-red-600';
    } else if (lvl <= 0) {
        verdict = 'detecting, but not in alpha: the head sits neutral, the object moves at full speed, and '
            + `${slot === 1 ? 'the hats and treble stay' : 'the kick and bass stay'} at their floor`;
        tone = 'text-gray-600 dark:text-gray-400';
    } else {
        verdict = `${depth(lvl)}: the head is turned toward person ${other}, the object is at calm `
            + `${calm.toFixed(2)} (1 = full motion, 0.30 = stillest), and ${SOUND[slot]} are at `
            + `${Math.round(lvl * 100)}% of their range`;
        tone = 'text-green-700 dark:text-green-400';
    }

    return (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 px-2 py-1.5 text-[11px] leading-snug">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Hint
                    title="What this panel is"
                    body={<>The values this page sends to TouchDesigner over the WebSocket, about 8 times a
                        second, and what the piece does with them. If a number here is not moving, nothing on
                        the projection is moving either, whatever the graphs above show.</>}
                >
                    <span className="font-semibold">To TouchDesigner</span>
                </Hint>

                <Hint
                    title={`d${slot}_level — how far into alpha, 0 to 1`}
                    body={<>
                        <code>clamp((prominence − {exitDb}) / (ceiling − {exitDb}), 0.05, 1)</code>, and 0
                        whenever the person is not in alpha or not ok. Scaled to this person, so 1 means
                        &ldquo;as strong as their own eyes-closed baseline&rdquo;, not an absolute amount.
                        <br /><br />
                        <b>In TouchDesigner:</b> above 0 the head turns to face forward, then reaches toward
                        the other person and dips back — further the longer and deeper they stay in. Their
                        object calms (<code>calm = 1 − 0.7 × level</code>). It also drives {SOUND[slot]}.
                    </>}
                >
                    <code>d{slot}_level</code>
                </Hint>
                <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-24 rounded bg-gray-200 dark:bg-gray-800 overflow-hidden align-middle">
                        <span className="block h-full rounded bg-green-500" style={{ width: `${lvl * 100}%` }} />
                    </span>
                    <b className="tabular-nums">{lvl.toFixed(2)}</b>
                </span>

                <Hint
                    title={`d${slot}_ok — can this side be trusted`}
                    body={<>1 when the device is sending, at least one electrode is usable, and no electrode
                        you have left switched in is red.
                        <br /><br />
                        <b>In TouchDesigner:</b> at 0 this side fades to grey and its head turns away, and it
                        cannot contribute to <code>pair_level</code> — so the two can never &ldquo;sync&rdquo;
                        on a dead electrode.</>}
                >
                    <code>d{slot}_ok</code>
                </Hint>
                <span className="flex items-center gap-1">
                    <span className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-green-500' : 'bg-red-600'}`} />
                    <b>{ok ? 1 : 0}</b>
                </span>

                <Hint
                    title={`d${slot}_w — the raw waveform, 125 samples a second`}
                    body={<>One electrode&rsquo;s filtered signal, sent as 16 samples per message and played
                        back in TouchDesigner about 250 ms behind live. It prefers <b>Oz</b> and falls back to
                        another electrode if that one goes red or you switch it out
                        {waveLabel ? <> — right now it is sending <b>{waveLabel}</b></> : null}.
                        <br /><br />
                        <b>In TouchDesigner:</b> all the live texture — the object&rsquo;s height, the noise
                        layers, the colour rotations and the trail line. It is <i>not</i> alpha: it moves
                        whether or not the person is in alpha, which is why the object can be busy while the
                        head is still turned away. One dead electrode here freezes or thrashes that whole
                        side&rsquo;s look even while the detector is voting happily on the other two.</>}
                >
                    <code>d{slot}_w</code>
                </Hint>
                <span className={streaming ? 'text-green-600' : 'text-gray-400'}>
                    {streaming ? 'flowing' : 'stalled'}
                    {waveLabel && <span className="text-gray-500"> from {waveLabel}</span>}
                </span>
            </div>

            {/* The degree question, on the detector lane's own scale. */}
            <div className="mt-1.5">
                <Hint
                    title="Prominence — how far alpha stands above this person's own background"
                    body={<>Decibels above the 1/f background fitted either side of the alpha band, over a 2 s
                        window. This is the blue line in the detector lane below, on this same scale
                        ({DB_MIN} to {DB_MAX} dB). The detector turns <i>on</i> at {enterDb} dB and back
                        <i> off</i> at {exitDb} dB, and {ceilingDb === undefined
                            ? <>uses a default ceiling of {defaultCeilingDb} dB because this person has not run
                                the 20 s check — press <b>Calibrate</b> to replace it with their own</>
                            : <>is scaled to this person&rsquo;s measured ceiling of {ceilingDb.toFixed(1)} dB
                                from the 20 s check</>}.</>}
                >
                    <span className="text-gray-500">prominence</span>
                </Hint>
                <span className="ml-1.5 tabular-nums">
                    {Number.isFinite(prom) ? `${prom.toFixed(1)} dB` : '—'}
                </span>
                <span className="ml-1.5 text-gray-500">
                    on at {enterDb} · off at {exitDb} · full at {ceiling.toFixed(1)} dB
                    {ceilingDb === undefined && <span className="ml-1 text-amber-600">(default, not calibrated)</span>}
                </span>
                <span className="relative mt-1 block h-2.5 rounded bg-gray-200 dark:bg-gray-800">
                    {Number.isFinite(prom) && (
                        <span className={`absolute top-0 bottom-0 left-0 rounded ${ok ? 'bg-indigo-500' : 'bg-gray-500'}`}
                            style={{ width: `${pct(prom)}%` }} />
                    )}
                    <span className="absolute top-0 bottom-0 w-px bg-yellow-500" style={{ left: `${pct(exitDb)}%` }}
                        title={`off at ${exitDb} dB`} />
                    <span className="absolute top-0 bottom-0 w-px bg-green-600" style={{ left: `${pct(enterDb)}%` }}
                        title={`on at ${enterDb} dB`} />
                    <span className="absolute -top-0.5 -bottom-0.5 w-px bg-gray-900 dark:bg-gray-100"
                        style={{ left: `${pct(ceiling)}%` }} title={`level reaches 1 at ${ceiling.toFixed(1)} dB`} />
                </span>
            </div>

            <div className={`mt-1 ${tone}`}>{verdict}</div>

            {streaming && person && (
                <div className="mt-0.5 text-gray-500">
                    <Hint
                        bare
                        title="The vote"
                        body={<>Informational. These headsets are a single differential channel — one reading
                            electrode, the positive, with a reference and a ground completing it — so the
                            first usable input is the <b>reading electrode</b> and it decides on its own, at
                            once. There is no vote between electrodes.
                            <br /><br />
                            <b>In TouchDesigner:</b> <code>d{slot}_level</code> follows that electrode, so
                            when its chip shows <b>α</b> the value is already on its way.</>}
                    >
                        <span>{person.voting} of {person.usable} electrodes voting alpha</span>
                        <Info />
                    </Hint>
                    {person.usable === 0 && (
                        <span className="ml-1 text-red-600">— no usable electrode, so this side cannot be read</span>
                    )}
                </div>
            )}
        </div>
    );
}
