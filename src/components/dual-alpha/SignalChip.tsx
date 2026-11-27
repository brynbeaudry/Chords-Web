'use client';
// One electrode's readout (plan §5.1, §5.2): prominence, peak frequency, tension (hfDb),
// mains pickup with the quality colour. Clicking it excludes the electrode from the vote.
import React from 'react';
import type { ChannelStatus } from '@/lib/dual-alpha/signalChain';
import { QUALITY_LIMITS } from '@/components/DyadState';

const QUALITY_CLASS: Record<string, string> = {
    none: 'bg-gray-400',
    green: 'bg-green-500',
    amber: 'bg-amber-500',
    red: 'bg-red-600',
};

export interface SignalChipProps {
    label: string;
    status: ChannelStatus;
    mains: 50 | 60;
    excluded: boolean;
    /** `?chans=` says no electrode is plugged into this input, so its noise is not a fault. */
    unwired?: boolean;
    /**
     * This is the reading electrode -- the one that decides whether the person is in alpha.
     *
     * Alpha state is shown on this chip only. The other inputs are not independent
     * measurements: every channel is taken against the same reference electrode, so whatever
     * the reference picks up appears in all of them. And because the detector is scale-free --
     * prominence in dB over each channel's own background -- a faint copy of a signal with
     * alpha in it reports the *same* prominence as the original. So an input with no electrode
     * of its own would light up green and mean nothing, which is worse than showing nothing.
     */
    reading?: boolean;
    onToggle: () => void;
}

export default function SignalChip({ label, status, mains, excluded, unwired, reading, onToggle }: SignalChipProps) {
    const r = status.reading;
    const mainsUv = mains === 50 ? status.mains50Uv : status.mains60Uv;
    const otherUv = mains === 50 ? status.mains60Uv : status.mains50Uv;
    // Live limits, not literals: ?mainsred= and ?artifact= move them, for both people at once.
    const { mainsAmberUv: AMBER, mainsRedUv: RED, artifactShareRed: ART } = QUALITY_LIMITS;
    const mainsRedOn = RED > 0;
    const wrongMains = otherUv > AMBER && otherUv > 2 * mainsUv;
    const why = status.railed ? 'railed' :
        status.artifactShare > ART ? 'restless' :
            mainsRedOn && Math.max(mainsUv, otherUv) > RED ? 'mains' : '';
    // A hover card would have to sit inside this button, so the explanation goes in `title`
    // instead, built from this electrode's own live numbers. The Legend panel at the top of
    // the page carries the same definitions in a readable table.
    const QUALITY_WHY: Record<string, string> = {
        none: 'grey: no reading yet (the detector needs a full 2 s window)',
        green: 'green: good contact',
        amber: `amber: ${mains} Hz mains pickup over ${AMBER} µV — still usable and still voting; re-seat if you can`,
        red: 'red: not usable. It is out of the vote, and it is holding this side at not ok',
    };
    const lines = [
        `${label} — one electrode. ${QUALITY_WHY[status.quality]}`,
        excluded ? 'Switched out by you: ignored by the vote. Click to switch it back in.'
            : 'Click to switch this electrode out of the vote.',
        '',
    ];
    if (r) {
        lines.push(
            `prom ${r.promDb.toFixed(1)} dB — how far the alpha peak stands above this person's own`,
            '    background. The median of these across usable electrodes is what becomes the',
            '    level TouchDesigner receives: the head turn and the object calming.',
            `${r.iafHz.toFixed(1)} Hz — where that peak sits. Alpha is 8–13 Hz; most people are near 10.`,
            `tension ${r.hfDb.toFixed(1)} dB — jaw, neck and forehead muscle. Not sent anywhere, but high`,
            '    tension buries the alpha peak, which is why someone calm can read as no alpha.',
            `mains ${mainsUv.toFixed(0)} µV — pickup from the building's ${mains} Hz electricity (wiring,`,
            '    chargers, lights). Interference, not brain: it is the best single measure of how well',
            mainsRedOn
                ? `    the electrode is sitting. Over ${RED} µV turns this electrode red, which greys out`
                : '    the electrode is sitting. Mains alone will not turn it red (?mainsred=0), so judge',
            mainsRedOn
                ? '    this whole side in TouchDesigner.'
                : '    contact by this number and the trace, not by the colour.',
            `artifact ${(status.artifactShare * 100).toFixed(0)}% of 10 s — how much of the window was too restless to trust.`,
            `    Over ${Math.round(ART * 100)}% turns the electrode red. On the chart this is the grey shading.`,
        );
        if (wrongMains) {
            lines.push('', `The ${mains === 50 ? 60 : 50} Hz pickup is stronger than the ${mains} Hz you filtered for:`,
                `    the notch is set to the wrong region. Reload with ?mains=${mains === 50 ? 60 : 50}.`);
        }
        if (status.railed) {
            const pct = (status.railShare * 100).toFixed(0);
            lines.push('', `rail ${pct}% ${status.railSide} · raw ${status.rawMin}-${status.rawMax} of 0-4095`,
                '    The amplifier is hitting its limit. What the numbers mean:');
            if (status.railShare > 0.3) {
                lines.push(`    ${pct}% of samples are against a rail — that is not a knock, the input is`,
                    '    pinned. Almost always the REFERENCE or GROUND electrode, not this one: with a',
                    '    poor reference the amplifier has nothing to subtract against, so it saturates',
                    '    and mains pickup goes through the roof at the same time. Re-seat the two',
                    '    electrodes behind the ears first, with fresh gel, pressed onto bare skin.');
            } else {
                lines.push(`    only ${pct}% of samples, so this is knocks rather than a pinned input —`,
                    '    a cable being tugged, or a loose electrode moving. Check the plug and the slack.');
            }
            if (status.railSide === 'low' || status.railSide === 'high') {
                lines.push(`    Stuck against the ${status.railSide} rail only: a DC offset, which means contact`,
                    '    (dry electrode, hair in the way) or a floating input with nothing plugged in.');
            } else if (status.railSide === 'both') {
                lines.push('    Hitting both rails: the signal is simply too big for the amplifier.');
            }
        }
        if (why) lines.push('', `Flagged "${why}" — the worst reason this electrode is unhappy, so fix that first.`);
        if (Math.max(mainsUv, otherUv) > RED && RED > 0 && status.railed) {
            lines.push('', 'High mains AND railing together is the signature of a reference or ground problem.',
                '    Mains hum is common to the whole body; the amplifier only cancels it if the',
                '    reference has good contact. Fix the mastoid electrodes before this one.');
        }
    } else if (status.absent) {
        lines.push('The device is not sending this channel at all — it reports fewer than three.',
            'This is not an electrode fault, and it is not scored. If the headset really is wired',
            'with fewer electrodes, say so with ?chans= so it stays out of the vote.');
    } else {
        lines.push('No reading yet. Normal for the first two seconds after connecting; if it stays here,',
            'the device is connected but samples are not arriving.');
    }
    const title = unwired
        ? [
            `${label} — no electrode plugged into this input (?chans=).`,
            '',
            'An empty input floats, so it rails and reads as restless. That is the open wire, not',
            'the person. It is switched out of the vote, which is the point: left in, a red',
            'electrode holds this person at not ok for the whole show, greys their side out in',
            'TouchDesigner and pins pair_level to 0 however good the real electrode is.',
            '',
            'Click to switch it back in if you do plug something in here.',
        ].join('\n')
        : lines.join('\n');
    return (
        <button
            type="button"
            onClick={onToggle}
            title={title}
            className={`flex flex-col items-start rounded-lg border px-2 py-1 text-[11px] leading-tight text-left min-w-[118px]
                ${reading && r?.isAlpha && !excluded ? 'border-green-500' : 'border-gray-300 dark:border-gray-700'}
                ${unwired ? 'opacity-45 border-dashed' : excluded ? 'opacity-40 line-through' : ''}`}
        >
            <span className="flex items-center gap-1 font-semibold text-xs">
                {/* An empty input is dashed and grey, not red: there is nothing here to fix. */}
                <span className={`inline-block h-2 w-2 rounded-full ${unwired ? 'bg-gray-400' : QUALITY_CLASS[status.quality]}`} />
                {label}
                {reading && !unwired && r?.isAlpha && !excluded && <span className="text-green-600">α</span>}
                {reading && <span className="text-[9px] font-normal text-indigo-600 dark:text-indigo-400">reading</span>}
                {!unwired && why && <span className="text-red-600 font-normal">{why}</span>}
            </span>
            {unwired ? (
                <span className="text-gray-500">no electrode · not in the vote</span>
            ) : r ? (
                <>
                    <span>prom {r.promDb.toFixed(1)} dB · {r.iafHz.toFixed(0)} Hz</span>
                    <span>tension {r.hfDb.toFixed(1)} dB{r.artifact ? ' · artifact' : ''}</span>
                    <span className={mainsRedOn && mainsUv > RED ? 'text-red-600' : mainsUv > AMBER ? 'text-amber-600' : ''}>
                        mains {mainsUv.toFixed(0)} µV{wrongMains ? ` · ${mains === 50 ? 60 : 50} Hz? (${otherUv.toFixed(0)} µV)` : ''}
                    </span>
                    <span className="text-gray-500">artifact {(status.artifactShare * 100).toFixed(0)}% of 10 s</span>
                    {/* "Railed" alone cannot tell a knock from a pinned input. The numbers can. */}
                    {status.railed && (
                        <span className="text-red-600">
                            rail {(status.railShare * 100).toFixed(0)}% {status.railSide} · raw {status.rawMin}–{status.rawMax}
                        </span>
                    )}
                </>
            ) : (
                <span className="text-gray-500">waiting for 2 s of signal</span>
            )}
        </button>
    );
}
