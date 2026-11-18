'use client';
// One electrode's readout (plan §5.1, §5.2): prominence, peak frequency, tension (hfDb),
// mains pickup with the quality colour. Clicking it excludes the electrode from the vote.
import React from 'react';
import type { ChannelStatus } from '@/lib/dual-alpha/signalChain';

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
    onToggle: () => void;
}

export default function SignalChip({ label, status, mains, excluded, onToggle }: SignalChipProps) {
    const r = status.reading;
    const mainsUv = mains === 50 ? status.mains50Uv : status.mains60Uv;
    const otherUv = mains === 50 ? status.mains60Uv : status.mains50Uv;
    const wrongMains = otherUv > 20 && otherUv > 2 * mainsUv;
    const why = status.railed ? 'railed' :
        status.artifactShare > 0.5 ? 'restless' :
            Math.max(mainsUv, otherUv) > 50 ? 'mains' : '';
    const title = excluded ? 'Excluded from the vote. Click to include.' :
        'Click to exclude this electrode from the vote.';
    return (
        <button
            type="button"
            onClick={onToggle}
            title={title}
            className={`flex flex-col items-start rounded-lg border px-2 py-1 text-[11px] leading-tight text-left min-w-[118px]
                ${r?.isAlpha && !excluded ? 'border-green-500' : 'border-gray-300 dark:border-gray-700'}
                ${excluded ? 'opacity-40 line-through' : ''}`}
        >
            <span className="flex items-center gap-1 font-semibold text-xs">
                <span className={`inline-block h-2 w-2 rounded-full ${QUALITY_CLASS[status.quality]}`} />
                {label}
                {r?.isAlpha && !excluded && <span className="text-green-600">α</span>}
                {why && <span className="text-red-600 font-normal">{why}</span>}
            </span>
            {r ? (
                <>
                    <span>prom {r.promDb.toFixed(1)} dB · {r.iafHz.toFixed(0)} Hz</span>
                    <span>tension {r.hfDb.toFixed(1)} dB{r.artifact ? ' · artifact' : ''}</span>
                    <span className={mainsUv > 50 ? 'text-red-600' : mainsUv > 20 ? 'text-amber-600' : ''}>
                        mains {mainsUv.toFixed(0)} µV{wrongMains ? ` · ${mains === 50 ? 60 : 50} Hz? (${otherUv.toFixed(0)} µV)` : ''}
                    </span>
                    <span className="text-gray-500">artifact {(status.artifactShare * 100).toFixed(0)}% of 10 s</span>
                </>
            ) : (
                <span className="text-gray-500">waiting for 2 s of signal</span>
            )}
        </button>
    );
}
