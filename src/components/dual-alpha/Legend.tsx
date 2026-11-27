'use client';
// The legend for everything the page paints.
//
// The colours here are the literal values used by the drawing code, so a swatch and the thing
// it describes cannot drift apart: the trace rows come from `chart.ts` (STRIP_PX strip, the
// per-channel highlight, artifact shading, the railed marker) and the lane rows come from
// `DetectorLane.tsx`. If you change a colour there, change it here.
//
// Each row says what the mark means *and* what TouchDesigner does with it, because during a
// show the only question that matters is whether the projection is responding to the person.
import React from 'react';
import { Swatch, Hatch } from './Hint';
import { QUALITY_LIMITS } from '@/components/DyadState';

const C = {
    level: 'rgba(34,197,94,0.85)',
    chLevel: 'rgba(34,197,94,0.35)',
    artifact: 'rgba(128,128,128,0.45)',
    railed: 'rgba(220,38,38,0.9)',
    prom: 'rgb(99,102,241)',
    enter: 'rgb(34,197,94)',
    exit: 'rgb(234,179,8)',
    zero: 'rgba(128,128,128,0.8)',
    closed: 'rgb(37,99,235)',
    open: 'rgb(249,115,22)',
};

interface RowProps { mark: React.ReactNode; name: string; what: string; td: string }

function Row({ mark, name, what, td }: RowProps) {
    return (
        <tr className="align-top border-t border-gray-100 dark:border-gray-800">
            <td className="py-1 pr-2 w-6">{mark}</td>
            <td className="py-1 pr-3 whitespace-nowrap font-medium">{name}</td>
            <td className="py-1 pr-3">{what}</td>
            <td className="py-1 text-gray-600 dark:text-gray-400">{td}</td>
        </tr>
    );
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
    return (
        <div className="min-w-0">
            <div className="font-semibold text-xs">{title}</div>
            {note && <div className="text-[10px] text-gray-500 mb-0.5">{note}</div>}
            <table className="w-full text-[11px] leading-snug border-collapse">
                <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-gray-500">
                        <th className="w-6" /><th className="text-left pr-3">Mark</th>
                        <th className="text-left pr-3">What it means</th>
                        <th className="text-left">In TouchDesigner</th>
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}

export interface LegendProps { enterDb: number; exitDb: number; mains: 50 | 60 }

export default function Legend({ enterDb, exitDb, mains }: LegendProps) {
    return (
        <details className="mx-3 mb-2 rounded-xl border border-gray-200 dark:border-gray-800">
            <summary className="cursor-pointer select-none px-3 py-1.5 text-sm font-semibold">
                Legend — what every line, highlight and word on this page means
            </summary>

            <div className="grid gap-4 px-3 pb-3 lg:grid-cols-2">
                <Group
                    title="The waveform area (one row per electrode)"
                    note="Highlights are painted back to the hop that first confirmed the decision, so they line up with when alpha actually started rather than when the detector caught up."
                >
                    <Row
                        mark={<Swatch css={C.level} />}
                        name="Green bar across the top"
                        what="This person counted as in alpha. It gets more opaque the deeper they are — this bar is the level itself."
                        td="This is d1_level / d2_level. Opaque green on screen = the head is reaching toward the other person and their object is at its calmest."
                    />
                    <Row
                        mark={<Hatch />}
                        name="Grey hatching under that bar"
                        what="Not ok: the device stopped sending, or an electrode you left switched in went red."
                        td="d_ok is 0, so this side has faded to grey and its head has turned away. pair_level is forced to 0."
                    />
                    <Row
                        mark={<Swatch css={C.chLevel} />}
                        name="Pale green behind one row"
                        what="That single electrode saw alpha, opacity following its own strength. The top bar is the person, which follows the reading electrode."
                        td="The reading electrode's highlight is what reaches the piece. The other inputs are drawn for contact checking only."
                    />
                    <Row
                        mark={<Swatch css={C.artifact} />}
                        name="Grey shading over a row"
                        what="Too much movement or muscle in that window, so the gate held the previous decision instead of trusting this one."
                        td="The value sent stops changing for as long as the shading lasts. A jaw clench or a blink reads as grey here, not as alpha."
                    />
                    <Row
                        mark={<Swatch css={C.railed} />}
                        name="Red line at the bottom of a row"
                        what="A raw count hit 0 or 4095 — the amplifier clipped. Usually a loose electrode or a tugged cable."
                        td="On the reading electrode that means d_ok 0 and a grey side. On an input with nothing plugged into it, nothing at all — it is an open wire, not a fault in the person's signal."
                    />
                </Group>

                <Group
                    title="The detector lane (under each person)"
                    note={`Vertical scale is −3 to 15 dB. It shows when the detector decided — a 2 s window plus about 0.26 s of confirmation — not when alpha began.`}
                >
                    <Row
                        mark={<Swatch css={C.prom} kind="line" />}
                        name="Blue line"
                        what="The reading electrode's prominence: how far its alpha peak stands above that person's own 1/f background."
                        td="The one number everything else is derived from. Watch this to see whether the device is picking up alpha at all."
                    />
                    <Row
                        mark={<Swatch css={C.enter} kind="dash" />}
                        name={`Dashed green, ${enterDb} dB`}
                        what="The on threshold. The blue line crossing above it, and staying there through confirmation, turns alpha on."
                        td="Crossing this is the moment d_level leaves 0 and the head starts to turn."
                    />
                    <Row
                        mark={<Swatch css={C.exit} kind="dash" />}
                        name={`Dashed yellow, ${exitDb} dB`}
                        what="The off threshold, 3 dB lower so a flicker at the boundary does not chatter on and off."
                        td="Also the zero point of the level scale: level is (prominence − this) / (ceiling − this)."
                    />
                    <Row
                        mark={<Swatch css={C.zero} kind="dash" />}
                        name="Dashed grey, 0 dB"
                        what="No peak at all — alpha exactly as strong as the background around it."
                        td="Reference only. A line sitting here means the device is reading, and there is no alpha to read."
                    />
                    <Row
                        mark={<Swatch css={C.level} />}
                        name="Green band, top of the lane"
                        what="The same state as the bar on the waveform chart, repeated here against the thresholds so you can see what triggered it."
                        td="d_level, as above."
                    />
                    <Row
                        mark={<Swatch css={C.railed} />}
                        name="Red, bottom left half"
                        what="Not ok for this stretch."
                        td="d_ok 0: grey side, head turned away."
                    />
                    <Row
                        mark={<>
                            <Swatch css={C.closed} /><Swatch css={C.open} />
                        </>}
                        name="Blue / orange, bottom right half"
                        what="Your own hand marks, for labelling a recording: press C for an eyes-closed block, O for eyes-open, X to end one."
                        td="Nothing — these are notes to yourself, written into the CSV. They do not reach TouchDesigner."
                    />
                </Group>

                <Group title="An electrode chip" note="Click a chip to switch that electrode out of the vote; it greys out and strikes through.">
                    <Row
                        mark={<span className="inline-block h-3 w-3 rounded-full bg-green-500" />}
                        name="Green / amber / red / grey dot"
                        what={`Contact quality. Amber above ${QUALITY_LIMITS.mainsAmberUv} µV of ${mains} Hz pickup`
                            + `${QUALITY_LIMITS.mainsRedUv > 0 ? `, red above ${QUALITY_LIMITS.mainsRedUv} µV` : ' (mains never makes it red: ?mainsred=0)'}`
                            + `, or railed, or restless for more than ${Math.round(QUALITY_LIMITS.artifactShareRed * 100)}% of the window. Grey means no reading yet.`}
                        td="Red takes the electrode out of the vote and takes d_ok to 0. Amber still counts — it is a warning, not an exclusion."
                    />
                    <Row
                        mark={<span className="text-green-600 font-bold">α</span>}
                        name="α and a green border"
                        what="This electrode sees alpha right now."
                        td="One of the votes. Half the usable electrodes have to show it before anything is sent."
                    />
                    <Row
                        mark={<span className="text-[10px]">dB</span>}
                        name="prom … dB · … Hz"
                        what="This electrode's prominence, and the frequency of its peak (8–13 Hz is alpha; most people sit near 10)."
                        td="The median of these across usable electrodes is the blue line, and the source of d_level."
                    />
                    <Row
                        mark={<span className="text-[10px]">hf</span>}
                        name="tension … dB"
                        what="High-frequency power — jaw, neck and forehead muscle. Rises when someone is clenching or frowning."
                        td="Not sent. High tension is why a person who feels calm can show no alpha: the muscle noise buries the peak."
                    />
                    <Row
                        mark={<span className="text-[10px]">⚡</span>}
                        name="mains … µV"
                        what={`Pickup from the building's mains electricity at ${mains} Hz — wall wiring, chargers, lights, laptop power supplies. It has nothing to do with the brain; it is interference, and it is the main measure of how well the electrode is sitting. A second figure appears if the other frequency is stronger, which means the notch filter is set to the wrong region.`}
                        td="Not sent, but it decides the dot colour, and so decides d_ok. High mains is almost always fixed by re-seating the electrode, moving the laptop off its charger, or moving away from a power strip."
                    />
                    <Row
                        mark={<span className="text-[10px]">%</span>}
                        name="artifact … % of 10 s"
                        what="How much of the last 10 s this electrode was too restless to trust."
                        td="Above 50% the electrode goes red and drops out. This is the grey shading on the chart, totalled up."
                    />
                    <Row
                        mark={<span className="inline-block h-3 w-3 rounded-full border border-dashed border-gray-400" />}
                        name="Dashed and faded, 'no electrode'"
                        what="Nothing is plugged into this input — you said so with ?chans=. Its noise is the open wire, not the person, so it is not scored or flagged."
                        td="Nothing. It is out of the vote on purpose: an empty input rails, goes red, and a red included electrode holds this person at not ok for the whole show — grey side, pair_level pinned to 0. Click it if you do plug something in."
                    />
                    <Row
                        mark={<span className="text-red-600 text-[10px]">railed</span>}
                        name="railed / restless / mains in red"
                        what="The one worst reason this electrode is unhappy, so you know what to fix first."
                        td="Each of these is a red dot, and a red dot means this side is grey in the projection."
                    />
                    <Row
                        mark={<span className="text-red-600 text-[10px]">rail</span>}
                        name="rail … % low/high · raw a–b"
                        what="How it is railing, not just that it is. A few percent is knocks — a tugged cable or a loose electrode. Most of the samples means the input is pinned flat against a rail. One rail only is a DC offset (dry contact, hair, or nothing plugged in); both rails means the signal is too big for the amplifier."
                        td="Nothing directly, but it turns the electrode red, which takes d_ok to 0 and greys this side out. High mains and a pinned rail together point at the reference or ground electrode rather than this one: mains hum is common to the whole body and only cancels if the reference has good contact."
                    />
                </Group>

                <Group title="The words in the top bar and beside each person" note="These are states, not measurements.">
                    <Row
                        mark={<span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" />}
                        name="TD connected · n sent"
                        what="The WebSocket to TouchDesigner is open, and how many messages have gone down it. The count must be climbing."
                        td="If this says searching, the projection is receiving nothing at all, however good the signal looks here."
                    />
                    <Row
                        mark={<span className="text-green-600 text-[10px]">ok</span>}
                        name="ok / not ok"
                        what="Whether this person's signal can be trusted at all this instant."
                        td="Exactly d_ok. not ok = grey side, head turned away, no contribution to the pair."
                    />
                    <Row
                        mark={<span className="text-[10px]">0.62</span>}
                        name="alpha · level"
                        what="How far into alpha, scaled to this person's own ceiling. 0 means not in alpha."
                        td="Exactly d_level: head turn, object calm, and that side's share of the mix."
                    />
                    <Row
                        mark={<span className="text-[10px]">2/3</span>}
                        name="n/m electrodes"
                        what="Electrodes seeing alpha, out of the ones still usable. Informational: the first usable one is the reading electrode and it decides on its own."
                        td="d_level follows the reading electrode. There is no vote between electrodes — these headsets are one differential channel."
                    />
                    <Row
                        mark={<span className="text-[10px]">cal</span>}
                        name="uncalibrated"
                        what="This person has not run the 20 s check, so the level scale uses a default ceiling of 12 dB instead of their own."
                        td="The piece still works — it just reads a strong person as less deep than they are, and a weak one as deeper. Press Calibrate. Either person can be calibrated on their own; the other device does not have to be connected."
                    />
                    <Row
                        mark={<span className="text-[10px]">pair</span>}
                        name="pair"
                        what="The lower of the two levels, and 0 unless both sides are ok. The synchrony value."
                        td="Above 0 both heads turn past forward to face each other over a 3 s ease; hold it for the Hold time and the transition plays. It also drives tempo, snare, swing, echo and filter resonance — and the wobble and distortion fall away as it rises, so arriving sounds settled rather than busier."
                    />
                    <Row
                        mark={<span className="text-[10px]">2 s</span>}
                        name="waiting for 2 s of signal"
                        what="No reading yet: the detector needs a full 2 s window before it can say anything. Normal for the first couple of seconds after connecting, and a fault if it persists."
                        td="Nothing is being sent for that electrode yet. If every chip is stuck on this, the device is connected but no samples are arriving."
                    />
                </Group>
            </div>
        </details>
    );
}
