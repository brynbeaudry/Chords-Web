'use client';
// The Settings panel: the three things an operator changes about how strictly a signal is
// judged. Everything here applies live -- no reload, so the headsets stay connected and a
// calibration already done is not thrown away -- and is remembered on this machine.
import React from 'react';
import type { DualAlphaSettings } from '@/lib/dual-alpha/settings';
import { DEFAULT_SETTINGS } from '@/lib/dual-alpha/settings';
import Hint from './Hint';

export interface SettingsPanelProps {
    settings: DualAlphaSettings;
    labels: string[];
    onChange: (next: Partial<DualAlphaSettings>) => void;
    onReset: () => void;
}

const isDefault = (s: DualAlphaSettings) =>
    s.chans === DEFAULT_SETTINGS.chans
    && s.mainsRedEnabled === DEFAULT_SETTINGS.mainsRedEnabled
    && s.mainsRedUv === DEFAULT_SETTINGS.mainsRedUv
    && s.artifactRed === DEFAULT_SETTINGS.artifactRed;

export default function SettingsPanel({ settings, labels, onChange, onReset }: SettingsPanelProps) {
    const s = settings;
    const unwired = labels.slice(s.chans);
    return (
        <details className="mx-3 mb-2 rounded-xl border border-gray-200 dark:border-gray-800">
            <summary className="cursor-pointer select-none px-3 py-1.5 text-sm font-semibold">
                Settings
                <span className="ml-2 font-normal text-xs text-gray-500">
                    {s.chans} of {labels.length} electrodes · mains {s.mainsRedEnabled ? `red over ${s.mainsRedUv} µV` : 'advisory only'}
                    {' '}· restless red over {Math.round(s.artifactRed * 100)}%
                </span>
                {!isDefault(s) && <span className="ml-2 text-xs text-amber-600">changed</span>}
            </summary>

            <div className="flex flex-col gap-3 px-3 pb-3 text-[12px]">
                <div className="text-[11px] text-gray-500">
                    These apply immediately and are remembered on this computer. They decide how strictly an
                    electrode is judged, and therefore when a person counts as <code>ok</code> — which is what
                    keeps their side of the projection in colour.
                </div>

                {/* electrodes in use */}
                <label className="flex flex-wrap items-center gap-2">
                    <Hint
                        title="Electrodes in use"
                        body={<>How many of the {labels.length} inputs have an electrode on them. The rest are
                            switched out of the vote.
                            <br /><br />
                            This is not cosmetic. An input with nothing plugged into it floats, rails and goes
                            red — and a single red electrode that is still switched in holds that person at
                            <b> not ok</b> for the whole show, greys their side out in TouchDesigner and pins
                            <code> pair_level</code> to 0 however good the real electrode is. A headset wired
                            as one active electrode plus reference and ground on the mastoids wants
                            <b> 1</b> here.</>}
                    >
                        <span className="font-medium">Electrodes in use</span>
                    </Hint>
                    <select
                        className="rounded border px-1 py-0.5 bg-transparent"
                        value={s.chans}
                        onChange={(e) => onChange({ chans: Number(e.target.value) })}
                    >
                        {labels.map((_, i) => (
                            <option key={i} value={i + 1}>{i + 1} — {labels.slice(0, i + 1).join(', ')}</option>
                        ))}
                    </select>
                    {unwired.length > 0 && (
                        <span className="text-gray-500">{unwired.join(', ')} switched out, both people</span>
                    )}
                </label>

                {/* mains */}
                <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5">
                        <input
                            type="checkbox"
                            checked={s.mainsRedEnabled}
                            onChange={(e) => onChange({ mainsRedEnabled: e.target.checked })}
                        />
                        <Hint
                            title="Mains pickup may reject an electrode"
                            body={<>Off by default, and that is deliberate. The 50 µV limit in the plan was
                                measured against the <i>previous</i> detector, which reported false alpha
                                56–100 % of the time at that level. The detector in use now analyses 3–45 Hz,
                                so a 50 or 60 Hz line is not in the band it looks at at all — here mains is a
                                measure of how well the electrode is sitting, not of whether alpha can be read.
                                <br /><br />
                                Left on in an electrically noisy room it stops people who are showing perfectly
                                good alpha from ever reaching <code>ok</code>, so their side of the projection
                                stays grey for the whole piece.
                                <br /><br />
                                With it off, the µV figure is still measured, still shown, and still turns the
                                chip amber. Railing and restlessness still reject an electrode on their own.</>}
                        >
                            <span className="font-medium">Mains pickup can reject an electrode</span>
                        </Hint>
                    </label>
                    <label className={`flex items-center gap-1 ${s.mainsRedEnabled ? '' : 'opacity-40'}`}>
                        over
                        <input
                            type="number"
                            min={1}
                            max={1000}
                            step={10}
                            disabled={!s.mainsRedEnabled}
                            value={s.mainsRedUv}
                            onChange={(e) => onChange({ mainsRedUv: Number(e.target.value) })}
                            className="w-16 rounded border px-1 py-0.5 bg-transparent"
                        />
                        µV
                    </label>
                    {!s.mainsRedEnabled && (
                        <span className="text-gray-500">advisory only — amber, never red</span>
                    )}
                </div>

                {/* restlessness */}
                <label className="flex flex-wrap items-center gap-2">
                    <Hint
                        title="Restlessness that rejects an electrode"
                        body={<>The share of the last 10 s in which the artifact gate was holding — movement,
                            jaw, blinks. Above this the electrode goes red and leaves the vote.
                            <br /><br />
                            Raise it for people who cannot sit still, or for an electrode on the temple or
                            forehead, which sees jaw muscle and blinks by its position rather than by anything
                            the person is doing wrong.</>}
                    >
                        <span className="font-medium">Restless rejects an electrode over</span>
                    </Hint>
                    <input
                        type="range"
                        min={10}
                        max={100}
                        step={5}
                        value={Math.round(s.artifactRed * 100)}
                        onChange={(e) => onChange({ artifactRed: Number(e.target.value) / 100 })}
                        className="w-40"
                    />
                    <span className="tabular-nums w-10">{Math.round(s.artifactRed * 100)}%</span>
                    <span className="text-gray-500">of the last 10 s</span>
                </label>

                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={onReset}
                        disabled={isDefault(s)}
                        className="rounded-lg border px-2 py-0.5 disabled:opacity-40"
                    >
                        Back to defaults
                    </button>
                    <span className="text-[11px] text-gray-500">
                        {labels.length} electrodes · mains advisory · restless red over 50%
                    </span>
                </div>
            </div>
        </details>
    );
}
