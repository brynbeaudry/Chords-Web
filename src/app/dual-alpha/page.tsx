'use client';
// /dual-alpha: the lean Dual Alpha page (docs/alpha-v2/dual-alpha-route-2026-11-18.md §5).
// Two NPG Lite headsets -> fixed filters + spectral alpha detector per electrode ->
// DyadState -> contract v2 to TouchDesigner (V16), automatically, ~7.8 messages a second.
// No detection or filter controls: everything runs on defaults; the address can say
//   ?td=host:port   TouchDesigner socket (default ws://localhost:9000)
//   ?mains=50       notch at 50 Hz instead of 60 Hz
//   ?enter=4        enter level in dB (exit = enter - 3)
//   ?debug=1        log every hop and message to the console
// Keys: C = eyes-closed block starts, O = eyes-open block starts, X = end of block (hand marks).
// Calibrate runs the guided 20 s check (plan §P6, src/lib/dual-alpha/calibration.ts): 10 s eyes
// closed then 10 s eyes open, which sets each person's own alpha ceiling. The button always
// re-enters the check, so every new pair moving through the piece gets its own ceilings; a
// person with too little signal simply stays uncalibrated on the 12 dB default.
// /dual-stream (with V15) is the untouched fallback.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import Navbar from '@/components/Navbar';
import { Button } from '@/components/ui/button';
import { WebSocketStreamer } from '@/services/WebSocketStreamer';
import { DualAlphaEngine, type Slot, type TdMessageV2 } from '@/lib/dual-alpha/engine';
import { DeviceChart, type HandMarkKind } from '@/lib/dual-alpha/chart';
import { Recorder, Replayer, parseRecordingCsv, type Row } from '@/lib/dual-alpha/recorder';
import { useDualNpg } from '@/lib/dual-alpha/useDualNpg';
import { levelFromProm, median } from '@/components/DyadState';
import { UV_PER_COUNT } from '@/lib/dual-alpha/signalChain';
import { Calibration, type CalPhase } from '@/lib/dual-alpha/calibration';
import SignalChip from '@/components/dual-alpha/SignalChip';
import DetectorLane from '@/components/dual-alpha/DetectorLane';
import CalibrationDialog from '@/components/dual-alpha/CalibrationDialog';

const FS = 500;
const SLOTS: Slot[] = [1, 2];
const CHANNEL_LABELS = ['O1', 'Oz', 'O2'];
const TIME_BASES = [4, 6, 8, 10];
const ZOOMS = [1, 2, 5, 10, 20, 50];

interface Config {
    tdUrl: string;
    mains: 50 | 60;
    enterDb: number;
    exitDb: number;
    debug: boolean;
}

function readConfig(): Config {
    const q = new URLSearchParams(window.location.search);
    const td = q.get('td');
    const tdUrl = td ? (td.includes('://') ? td : `ws://${td}`) : 'ws://localhost:9000';
    const mains = q.get('mains') === '50' ? 50 : 60;
    const enter = Number(q.get('enter'));
    const enterDb = Number.isFinite(enter) && enter > 0 ? enter : 5;
    return { tdUrl, mains, enterDb, exitDb: enterDb - 3, debug: q.get('debug') === '1' };
}

export default function DualAlphaPage() {
    const { theme } = useTheme();
    const [cfg, setCfg] = useState<Config | null>(null);
    const [timeBase, setTimeBase] = useState(8);
    const [zoom, setZoom] = useState(10);
    const [tdConnected, setTdConnected] = useState(false);
    const [recording, setRecording] = useState(false);
    const [recStart, setRecStart] = useState(0);
    const [files, setFiles] = useState<string[]>([]);
    const [selectedFile, setSelectedFile] = useState('');
    const [replay, setReplay] = useState<{ name: string; paused: boolean } | null>(null);
    const [speed, setSpeed] = useState(1);
    const [mark, setMarkState] = useState<HandMarkKind>(0);
    const [, setTick] = useState(0);

    const engineRef = useRef<DualAlphaEngine | null>(null);
    const streamerRef = useRef<WebSocketStreamer | null>(null);
    const recorderRef = useRef<Recorder | null>(null);
    const replayerRef = useRef<Replayer | null>(null);
    const containerRefs = { 1: useRef<HTMLDivElement>(null), 2: useRef<HTMLDivElement>(null) };
    const chartRefs = { 1: useRef<DeviceChart | null>(null), 2: useRef<DeviceChart | null>(null) };
    const prevOn = useRef<Record<Slot, { ch: boolean[]; person: boolean }>>({
        1: { ch: [false, false, false], person: false },
        2: { ch: [false, false, false], person: false },
    });
    const lastMsgRef = useRef<TdMessageV2 | null>(null);
    const msgCount = useRef(0);
    const cfgRef = useRef<Config | null>(null);
    const replayingRef = useRef(false);

    // ─── the guided 20 s check (plan §P6) ───
    // The operator may re-enter it at any time, which is how each new pair moving through the
    // piece gets its own ceilings.
    const calRef = useRef(new Calibration());
    const [calPhase, setCalPhase] = useState<CalPhase>('idle');
    const [calElapsedS, setCalElapsedS] = useState(0);

    // ─── per-sample path, shared by live and replay ───
    const handleSample = useCallback((slot: Slot, counter: number, raw: number[], tMs: number, live: boolean) => {
        const engine = engineRef.current, c = cfgRef.current;
        if (!engine || !c) return;
        const out = engine.ingest(slot, raw, tMs);
        const chart = chartRefs[slot].current;
        chart?.pushSample(out.result.filtered);

        const rec = recorderRef.current;
        if (live && rec?.isRecording) {
            const f = out.result.filtered;
            rec.addRow([slot, rec.elapsedMs(), performance.now(), counter, raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0, f[0], f[1], f[2]]);
        }

        if (out.hop) {
            const st = out.hop.status;
            const person = slot === 1 ? out.hop.dyad.d1 : out.hop.dyad.d2;
            const prev = prevOn.current[slot];
            const ceiling = engine.ceilingDb[slot] ?? engine.dyadParams.defaultCeilingDb;
            const chHops = st.map((s, i) => {
                const r = s.reading!;
                const on = r.isAlpha && !engine.excluded[slot].has(i);
                const h = {
                    level: on ? levelFromProm(r.promDb, c.exitDb, ceiling) : 0,
                    artifact: r.artifact,
                    railed: s.railed,
                    turnedOn: on && !prev.ch[i],
                };
                prev.ch[i] = on;
                return h;
            });
            const personOn = person.level > 0;
            chart?.pushHop(chHops, {
                level: person.level, ok: person.ok, turnedOn: personOn && !prev.person, medianPromDb: person.medianPromDb,
            });
            prev.person = personOn;
            // feed the 20 s check from the same hops the detector produces, so a replay
            // calibrates exactly as a live session does
            const cal = calRef.current;
            if (cal.running) {
                const iafs = st.map((s) => s.reading?.iafHz).filter((v): v is number => Number.isFinite(v));
                cal.push(slot, person.medianPromDb, iafs.length ? median(iafs) : NaN, tMs);
            }
            if (c.debug) {
                console.log(`[D${slot} hop t=${(tMs / 1000).toFixed(2)}s]`, st.map((s, i) =>
                    `${CHANNEL_LABELS[i]} ${s.reading?.isAlpha ? 'α' : '-'} prom ${s.reading?.promDb.toFixed(2)} iaf ${s.reading?.iafHz} hf ${s.reading?.hfDb.toFixed(2)} art ${s.reading?.artifact ? 1 : 0} ${s.quality}`).join(' | '),
                    `person ok ${person.ok} level ${person.level.toFixed(3)}`);
            }
        }
        if (out.message) {
            lastMsgRef.current = out.message;
            msgCount.current++;
            streamerRef.current?.sendState(out.message);
            if (live) rec?.addMessage(out.message);
            if (c.debug) console.log('[TD v2]', JSON.stringify(out.message));
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const { devices, connect, disconnect } = useDualNpg(
        (slot, counter, raw) => {
            if (replayingRef.current) return;   // replay owns the pipeline
            handleSample(slot, counter, raw, performance.now(), true);
        },
        (slot) => {
            engineRef.current?.reset(slot);
            prevOn.current[slot] = { ch: [false, false, false], person: false };
        },
    );

    // ─── set-up: config, engine, TD socket (automatic), recorder ───
    useEffect(() => {
        const c = readConfig();
        cfgRef.current = c;
        engineRef.current = new DualAlphaEngine({ fs: FS, mains: c.mains, enterDb: c.enterDb });
        setCfg(c);

        const streamer = new WebSocketStreamer();
        streamerRef.current = streamer;
        let everConnected = false;
        const stop = streamer.connectAuto(c.tdUrl, (connected) => {
            setTdConnected(connected);
            if (connected && !everConnected) toast.success(`TouchDesigner connected (${c.tdUrl})`);
            if (!connected && everConnected) toast.error('TouchDesigner connection lost — retrying');
            if (connected) everConnected = true;
        });

        const rec = new Recorder();
        recorderRef.current = rec;
        rec.list().then(setFiles).catch(() => { /* worker not ready */ });

        replayerRef.current = new Replayer(
            (row: Row) => handleSample(row[0] === 2 ? 2 : 1, row[3] ?? 0, [row[4] ?? 0, row[5] ?? 0, row[6] ?? 0], row[1] ?? 0, false),
            () => endReplay(),
        );
        return () => {
            stop();
            replayerRef.current?.stop();
            rec.terminate();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── charts: rebuilt on time base / theme / size; never touches detection ───
    const buildCharts = useCallback(() => {
        if (!cfgRef.current) return;
        for (const slot of SLOTS) {
            const el = containerRefs[slot].current;
            if (!el) continue;
            chartRefs[slot].current?.destroy();
            chartRefs[slot].current = new DeviceChart({
                container: el, fs: FS, timeBaseS: timeBase, zoom, dark: theme === 'dark',
                channels: 3, labels: CHANNEL_LABELS, hop: 64, backfill: 64,
            });
            chartRefs[slot].current.setMark(mark);
        }
    }, [timeBase, theme]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        buildCharts();
        window.addEventListener('resize', buildCharts);
        return () => window.removeEventListener('resize', buildCharts);
    }, [buildCharts, cfg]);

    useEffect(() => { SLOTS.forEach((s) => chartRefs[s].current?.setZoom(zoom)); }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        let raf = 0;
        const frame = () => {
            SLOTS.forEach((s) => chartRefs[s].current?.draw());
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        const iv = setInterval(() => setTick((t) => t + 1), 250);   // chips and headers
        return () => { cancelAnimationFrame(raf); clearInterval(iv); };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── hand marks ───
    const setMark = useCallback((m: HandMarkKind) => {
        setMarkState(m);
        SLOTS.forEach((s) => chartRefs[s].current?.setMark(m));
        recorderRef.current?.addMark(m === 1 ? 'ec' : m === 2 ? 'eo' : 'end');
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
            const k = e.key.toLowerCase();
            if (k === 'c') setMark(1);
            else if (k === 'o') setMark(2);
            else if (k === 'x') setMark(0);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [setMark]);

    // ─── record ───
    const toggleRecord = async () => {
        const rec = recorderRef.current, c = cfgRef.current;
        if (!rec || !c) return;
        if (rec.isRecording) {
            const out = rec.stop();
            setRecording(false);
            if (out) {
                if (out.jsonl) saveAs(new Blob([out.jsonl], { type: 'application/x-ndjson' }), out.filename.replace(/\.csv$/, '.td_stream.jsonl'));
                toast.success(`Saved ${out.filename} (CSV in the list; td_stream.jsonl downloaded)`);
                setTimeout(() => rec.list().then(setFiles).catch(() => undefined), 500);
            }
            return;
        }
        if (replayingRef.current) { toast.error('Stop the replay before recording.'); return; }
        const name = rec.start({
            samplingRate: FS, selectedChannels: [1, 2, 3], exg: { 0: 3, 1: 3, 2: 3 },
            notch: { 0: c.mains === 50 ? 1 : 2, 1: c.mains === 50 ? 1 : 2, 2: c.mains === 50 ? 1 : 2 },
            page: 'dual-alpha', mains: c.mains, enterDb: c.enterDb,
        });
        setRecStart(Date.now());
        setRecording(true);
        toast.info(`Recording ${name}`);
    };

    // ─── replay ───
    const beginReplay = (rows: Row[], name: string) => {
        if (recorderRef.current?.isRecording) { toast.error('Stop recording before a replay.'); return; }
        if (!rows.length) { toast.error('Recording is empty.'); return; }
        engineRef.current?.resetAll();
        SLOTS.forEach((s) => { prevOn.current[s] = { ch: [false, false, false], person: false }; });
        buildCharts();
        replayingRef.current = true;
        replayerRef.current!.speed = speed;
        replayerRef.current!.start(rows);
        setReplay({ name, paused: false });
    };

    const endReplay = () => {
        replayerRef.current?.stop();
        replayingRef.current = false;
        engineRef.current?.resetAll();
        setReplay(null);
    };

    const replayStored = async () => {
        if (!selectedFile || !recorderRef.current) return;
        try {
            const { rows } = await recorderRef.current.load(selectedFile);
            beginReplay(rows, selectedFile);
        } catch (e) {
            toast.error(`Could not load ${selectedFile}: ${e instanceof Error ? e.message : e}`);
        }
    };

    const replayFromDisk = async (file: File) => {
        const { rows } = parseRecordingCsv(await file.text());
        beginReplay(rows, file.name);
    };

    const downloadStored = async () => {
        if (!selectedFile || !recorderRef.current) return;
        try { saveAs(await recorderRef.current.csvBlob(selectedFile), selectedFile); } catch (e) { toast.error(String(e)); }
    };

    const deleteStored = async () => {
        if (!selectedFile || !recorderRef.current) return;
        await recorderRef.current.remove(selectedFile);
        setSelectedFile('');
        setFiles(await recorderRef.current.list());
    };

    // ─── calibration controls ───
    // Applying keeps each person independent: one headset being silent leaves that person on
    // the 12 dB default instead of spoiling the other's ceiling.
    const applyCalibration = useCallback(() => {
        const engine = engineRef.current, cal = calRef.current;
        if (!engine) return;
        const lines = SLOTS.map((s) => {
            const r = cal.result(s);
            if (!r) return `P${s}: too little signal — stays uncalibrated`;
            engine.ceilingDb[s] = r.ceilingDb;
            const iaf = Number.isFinite(r.closedIafHz) ? `${r.closedIafHz.toFixed(0)} Hz` : 'no peak';
            return `P${s}: ceiling ${r.ceilingDb.toFixed(1)} dB · ${iaf}`;
        });
        setTick((t) => t + 1);
        toast.success(lines.join('     '));
    }, []);

    const startCalibration = useCallback(() => {
        calRef.current.start(performance.now());
        setCalPhase('closed');
        setCalElapsedS(0);
    }, []);

    const confirmCalibration = useCallback(() => {
        const now = performance.now();
        calRef.current.confirm(now);
        setCalElapsedS(calRef.current.elapsedS(now));
        applyCalibration();
        setCalPhase('done');
    }, [applyCalibration]);

    const closeCalibration = useCallback(() => {
        calRef.current.cancel();
        setCalPhase('idle');
    }, []);

    // the countdown and the automatic closed -> open -> done advance
    useEffect(() => {
        if (calPhase !== 'closed' && calPhase !== 'open') return;
        const id = setInterval(() => {
            const cal = calRef.current;
            const phase = cal.tick(performance.now());
            setCalElapsedS(cal.elapsedS(performance.now()));
            if (phase === 'done') {
                applyCalibration();
                setCalPhase('done');
            } else {
                setCalPhase(phase);
            }
        }, 200);
        return () => clearInterval(id);
    }, [calPhase, applyCalibration]);

    // ─── render ───
    const engine = engineRef.current;
    const nowMs = performance.now();
    const elapsed = recording ? Math.floor((Date.now() - recStart) / 1000) : 0;
    const uvRange = (2048 * UV_PER_COUNT) / zoom;

    return (
        <div className="flex flex-col min-h-screen bg-g">
            <div className="bg-highlight"><Navbar isDisplay={true} /></div>

            <CalibrationDialog
                phase={calPhase}
                elapsedS={calElapsedS}
                counts={{ 1: calRef.current.counts(1), 2: calRef.current.counts(2) }}
                usable={{ 1: calRef.current.result(1) !== null, 2: calRef.current.result(2) !== null }}
                names={{ 1: devices[1].connected ? devices[1].name : '', 2: devices[2].connected ? devices[2].name : '' }}
                onConfirm={confirmCalibration}
                onRestart={startCalibration}
                onClose={closeCalibration}
            />

            <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-800 text-sm">
                {SLOTS.map((s) => (
                    <Button key={s} className="rounded-xl" disabled={devices[s].loading || !!replay}
                        onClick={() => (devices[s].connected ? disconnect(s) : connect(s))}>
                        {devices[s].loading ? `Device ${s}…` : devices[s].connected ? `Disconnect ${s}` : `Connect device ${s}`}
                    </Button>
                ))}
                <span title={cfg?.tdUrl} className={`flex items-center gap-1 ${tdConnected ? 'text-green-600' : 'text-gray-400'}`}>
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${tdConnected ? 'bg-green-500' : 'bg-gray-400'}`} />
                    TD {tdConnected ? 'connected' : 'searching'} · {msgCount.current} sent
                </span>
                {/* always re-enters the check, so each new pair gets its own ceilings */}
                <Button variant="outline" className="rounded-xl" disabled={!!replay} onClick={startCalibration}
                    title="Run the 20 s check: 10 s eyes closed, then 10 s eyes open">
                    Calibrate
                </Button>
                <Button className={`rounded-xl ${recording ? 'bg-red-600 hover:bg-red-500 text-white' : ''}`} onClick={toggleRecord}
                    disabled={!!replay}>
                    {recording ? `Stop recording ${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}` : 'Record'}
                </Button>
                <select className="rounded border px-1 py-1 bg-transparent max-w-[220px]" value={selectedFile}
                    onChange={(e) => setSelectedFile(e.target.value)} onFocus={() => recorderRef.current?.list().then(setFiles).catch(() => undefined)}>
                    <option value="">Recordings ({files.length})</option>
                    {files.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <Button variant="outline" className="rounded-xl" disabled={!selectedFile || !!replay || recording} onClick={replayStored}>Replay</Button>
                <Button variant="outline" className="rounded-xl" disabled={!selectedFile} onClick={downloadStored}>CSV</Button>
                <Button variant="outline" className="rounded-xl" disabled={!selectedFile || !!replay} onClick={deleteStored}>Delete</Button>
                <label className={`rounded-xl border px-3 py-1.5 cursor-pointer ${replay || recording ? 'opacity-50 pointer-events-none' : ''}`}>
                    Replay CSV file…
                    <input type="file" accept=".csv,text/csv" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) replayFromDisk(f); e.target.value = ''; }} />
                </label>
                <label className="flex items-center gap-1">Time base
                    <select className="rounded border px-1 py-1 bg-transparent" value={timeBase} onChange={(e) => setTimeBase(Number(e.target.value))}>
                        {TIME_BASES.map((t) => <option key={t} value={t}>{t} s</option>)}
                    </select>
                </label>
                <label className="flex items-center gap-1">Zoom
                    <select className="rounded border px-1 py-1 bg-transparent" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
                        {ZOOMS.map((z) => <option key={z} value={z}>{z}×</option>)}
                    </select>
                    <span className="text-xs text-gray-500">±{uvRange.toFixed(0)} µV (approx.)</span>
                </label>
                <span className="text-xs text-gray-500">
                    notch {cfg?.mains ?? 60} Hz
                    {cfg && cfg.enterDb !== 5 && <span className="ml-1 text-amber-600">· enter {cfg.enterDb} dB / exit {cfg.exitDb} dB</span>}
                    {' '}· marks: <b>C</b> eyes closed, <b>O</b> eyes open, <b>X</b> end
                    {mark !== 0 && <span className={mark === 1 ? 'text-blue-600' : 'text-orange-600'}> ({mark === 1 ? 'eyes closed' : 'eyes open'} block)</span>}
                </span>
            </div>

            {replay && (
                <div className="flex items-center gap-3 px-3 py-1.5 bg-purple-100 dark:bg-purple-950 text-sm">
                    <span className="font-semibold">▶ Replay</span> {replay.name}
                    <span className="text-gray-500">
                        {(replayerRef.current!.progress.cur / 1000).toFixed(0)} / {(replayerRef.current!.progress.total / 1000).toFixed(0)} s · device input paused
                    </span>
                    <Button variant="outline" className="h-7 rounded-lg" onClick={() => {
                        replayerRef.current?.togglePause();
                        setReplay({ ...replay, paused: !replay.paused });
                    }}>{replay.paused ? 'Resume' : 'Pause'}</Button>
                    <select className="rounded border px-1 bg-transparent" value={speed} onChange={(e) => {
                        const v = Number(e.target.value);
                        setSpeed(v);
                        if (replayerRef.current) replayerRef.current.speed = v;
                    }}>
                        {[0.5, 1, 2, 4].map((v) => <option key={v} value={v}>{v}×</option>)}
                    </select>
                    <Button variant="outline" className="h-7 rounded-lg" onClick={endReplay}>Stop</Button>
                </div>
            )}

            <div className="flex flex-col lg:flex-row gap-3 p-3 flex-1">
                {SLOTS.map((slot) => {
                    const person = slot === 1 ? engine?.dyad.d1 : engine?.dyad.d2;
                    const streaming = replay ? true : engine?.isStreaming(slot, nowMs) ?? false;
                    return (
                        <div key={slot} className="flex-1 min-w-0 flex flex-col gap-2">
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="font-semibold">Person {slot}</span>
                                <span className="text-gray-500">{devices[slot].connected ? devices[slot].name : replay ? 'replay' : 'no device'}</span>
                                {devices[slot].connected && devices[slot].gaps > 0 && (
                                    <span className="text-amber-600">{devices[slot].gaps} lost samples</span>
                                )}
                                {person && streaming && (
                                    <>
                                        <span className={person.ok ? 'text-green-600' : 'text-red-600'}>{person.ok ? 'ok' : 'not ok'}</span>
                                        <span>{person.level > 0 ? `alpha · level ${person.level.toFixed(2)}` : 'no alpha'}</span>
                                        <span className="text-gray-500">{person.voting}/{person.usable} electrodes</span>
                                    </>
                                )}
                                {person && !person.calibrated && <span className="rounded bg-gray-200 dark:bg-gray-800 px-1.5 text-xs">uncalibrated</span>}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {engine && engine.chains[slot].status.map((s, i) => (
                                    <SignalChip key={i} label={CHANNEL_LABELS[i]} status={s} mains={cfg?.mains ?? 60}
                                        excluded={engine.excluded[slot].has(i)}
                                        onToggle={() => {
                                            const ex = engine.excluded[slot];
                                            if (ex.has(i)) ex.delete(i); else ex.add(i);
                                            setTick((t) => t + 1);
                                        }} />
                                ))}
                            </div>
                            <div ref={containerRefs[slot]} className="w-full h-[38vh] min-h-[220px] rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden" />
                            {cfg && <DetectorLane chartRef={chartRefs[slot]} enterDb={cfg.enterDb} exitDb={cfg.exitDb} />}
                        </div>
                    );
                })}
            </div>

            {cfg?.debug && lastMsgRef.current && (
                <pre className="mx-3 mb-3 text-[10px] text-gray-500 overflow-x-auto">{JSON.stringify(lastMsgRef.current)}</pre>
            )}
        </div>
    );
}
