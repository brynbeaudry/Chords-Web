'use client';
// /dual-alpha: the lean Dual Alpha page (docs/alpha-v2/dual-alpha-route-2026-11-18.md §5).
// Two NPG Lite headsets -> fixed filters + spectral alpha detector per electrode ->
// DyadState -> contract v2 to TouchDesigner (V16), automatically, ~7.8 messages a second.
// No detection or filter controls: everything runs on defaults; the address can say
//   ?td=host:port   TouchDesigner socket (default ws://localhost:9000)
//   ?mains=50       notch at 50 Hz instead of 60 Hz
//   ?enter=4        enter level in dB (exit = enter - 3)
//   ?debug=1        log every hop and message to the console
// How strictly a signal is judged is in the Settings panel, not the address: electrodes in
// use, whether mains pickup may reject an electrode (off by default), and the restlessness
// limit. They apply live and are remembered on the machine. The old `?chans=`, `?mainsred=`
// and `?artifact=` still work as a one-off override of the stored value.
// Keys: C = eyes-closed block starts, O = eyes-open block starts, X = end of block (hand marks).
// Calibrate runs the guided 15 s check (plan §P6, src/lib/dual-alpha/calibration.ts): three
// 5 s phases -- eyes open blinking five times, eyes closed, eyes open and still, each
// discarding its first 2 s so the detector's trailing window clears. The blinks are a
// liveness check -- a signal we can ask for and be sure of, so an electrode that misses them is
// not making contact rather than reading a person with weak alpha. The two alpha phases set
// each person's own entry level, exit level and ceiling, all three, per person, which is what a
// montage with weak alpha needs. The button always re-enters the check, so every new pair gets
// its own numbers; a person with too little signal stays uncalibrated on the 12 dB default.
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
import { levelFromProm, median, setQualityLimits } from '@/components/DyadState';
import {
    loadSettings, saveSettings, qualityLimitsFor, DEFAULT_SETTINGS, type DualAlphaSettings,
} from '@/lib/dual-alpha/settings';
import { UV_PER_COUNT } from '@/lib/dual-alpha/signalChain';
import { Calibration, type CalPhase } from '@/lib/dual-alpha/calibration';
import {
    thresholdsFor, HYSTERESIS_DB, DEFAULT_MODE, MIN_ENTER_DB, MAX_ENTER_DB,
    type AlphaMode,
} from '@/lib/dual-alpha/alphaMode';
import AlphaControls from '@/components/dual-alpha/AlphaControls';
import SignalChip from '@/components/dual-alpha/SignalChip';
import DetectorLane from '@/components/dual-alpha/DetectorLane';
import CalibrationDialog from '@/components/dual-alpha/CalibrationDialog';
import Legend from '@/components/dual-alpha/Legend';
import SettingsPanel from '@/components/dual-alpha/SettingsPanel';
import TdReadout from '@/components/dual-alpha/TdReadout';
import Hint, { Info } from '@/components/dual-alpha/Hint';

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
    /** `?enter=` was given explicitly, so the eyes-open/closed mode must not override it. */
    enterGiven: boolean;
    debug: boolean;
}

function readConfig(): Config {
    const q = new URLSearchParams(window.location.search);
    const td = q.get('td');
    const tdUrl = td ? (td.includes('://') ? td : `ws://${td}`) : 'ws://localhost:9000';
    const mains = q.get('mains') === '50' ? 50 : 60;
    const enter = Number(q.get('enter'));
    const enterGiven = q.get('enter') !== null && Number.isFinite(enter) && enter > 0;
    const enterDb = enterGiven ? enter : 5;
    return {
        tdUrl, mains, enterDb, exitDb: enterDb - 3, enterGiven,
        debug: q.get('debug') === '1',
    };
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
    // Null until the first effect runs: localStorage is not there during the server render.
    const [settings, setSettings] = useState<DualAlphaSettings | null>(null);

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

    // ─── the guided 15 s check (plan §P6) ───
    // The operator may re-enter it at any time, which is how each new pair moving through the
    // piece gets its own ceilings.
    const calRef = useRef(new Calibration());
    const [calPhase, setCalPhase] = useState<CalPhase>('idle');
    const [calElapsedS, setCalElapsedS] = useState(0);

    // Per person: how they are meant to reach alpha, and therefore how low the entry
    // threshold sits. Eyes open by default -- the piece is watched, so that is the normal
    // case. Not persisted: it belongs to the pair in the chair.
    const [alphaMode, setAlphaMode] = useState<Record<Slot, AlphaMode>>(
        { 1: DEFAULT_MODE, 2: DEFAULT_MODE },
    );

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
            // The same floor the detector and the vote use for this person, not the global one.
            const floor = engine.thresholdDb[slot]?.offDb ?? c.exitDb;
            // Only the reading electrode may show alpha, on the chip and on the graph. The
            // other inputs share the same reference electrode and the detector is scale-free,
            // so a faint copy of a signal containing alpha reports the same prominence as the
            // original -- an input with no electrode of its own would paint green and mean
            // nothing. Their traces are still drawn, for checking contact.
            const readingCh = engine.readingChannel(slot);
            const chHops = st.map((s, i) => {
                const r = s.reading!;
                const on = i === readingCh && r.isAlpha && !engine.excluded[slot].has(i);
                const h = {
                    level: on ? levelFromProm(r.promDb, floor, ceiling) : 0,
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
            // feed the check from the same hops the detector produces, so a replay
            // calibrates exactly as a live session does
            const cal = calRef.current;
            if (cal.running) {
                const iafs = st.map((s) => s.reading?.iafHz).filter((v): v is number => Number.isFinite(v));
                // Any electrode still in the vote rejecting this window. During the blink
                // phase that is the blinks landing, which is the liveness check.
                const artifact = st.some((s, i) => !engine.excluded[slot].has(i) && s.reading?.artifact);
                cal.push(slot, person.medianPromDb, iafs.length ? median(iafs) : NaN, tMs, artifact);
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
        setSettings(loadSettings(window.location.search, CHANNEL_LABELS.length));
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

    // ─── settings, applied live ───
    // Changing these must not need a reload: a reload drops the Bluetooth connections and any
    // calibration already done with them.
    const autoExcluded = useRef<Record<Slot, Set<number>>>({ 1: new Set(), 2: new Set() });
    useEffect(() => {
        const engine = engineRef.current;
        if (!settings || !engine) return;
        // One place, both people: channelQuality is the only thing that decides red.
        setQualityLimits(qualityLimitsFor(settings));
        // Inputs with no electrode on them leave the vote. Only the ones this rule switched
        // out are switched back in, so an electrode the operator excluded by hand stays out.
        for (const s of SLOTS) {
            const auto = autoExcluded.current[s];
            for (const i of [...auto]) {
                if (i < settings.chans) {
                    engine.excluded[s].delete(i);
                    auto.delete(i);
                }
            }
            for (let i = settings.chans; i < CHANNEL_LABELS.length; i++) {
                engine.excluded[s].add(i);
                auto.add(i);
            }
        }
        setTick((t) => t + 1);
    }, [settings]);

    const changeSettings = useCallback((patch: Partial<DualAlphaSettings>) => {
        setSettings((prev) => {
            const next = { ...(prev ?? DEFAULT_SETTINGS), ...patch };
            saveSettings(next);
            return next;
        });
    }, []);

    const resetSettings = useCallback(() => {
        setSettings({ ...DEFAULT_SETTINGS });
        saveSettings({ ...DEFAULT_SETTINGS });
        toast.message('Settings back to defaults');
    }, []);

    // ─── calibration controls ───
    // Applying keeps each person independent: one headset being silent leaves that person on
    // the 12 dB default instead of spoiling the other's ceiling.
    const applyCalibration = useCallback(() => {
        const engine = engineRef.current, cal = calRef.current;
        if (!engine) return;
        const lines = SLOTS.map((s) => {
            const r = cal.result(s);
            if (!r) return `P${s}: too little signal — stays uncalibrated`;
            // The check measures a ceiling *and* an entry threshold. Both are applied: a
            // montage with weak alpha (forehead, behind the ear) can sit entirely below the
            // default 5 dB entry, and then the ceiling alone changes nothing. The entry level
            // follows that person's mode, so calibrating while they are in eyes-open mode
            // leaves them on an eyes-open threshold rather than resetting it.
            const t = thresholdsFor(alphaMode[s], r);
            engine.setCalibration(s, r.ceilingDb, t.onDb, t.offDb);
            const iaf = Number.isFinite(r.closedIafHz) ? `${r.closedIafHz.toFixed(0)} Hz` : 'no peak';
            return `P${s}: on ${t.onDb.toFixed(1)} / off ${t.offDb.toFixed(1)} · ceiling ${r.ceilingDb.toFixed(1)} dB · ${iaf}`;
        });
        setTick((t) => t + 1);
        toast.success(lines.join('     '));
        // `alphaMode` is read above, so it must be a dependency: without it the callback keeps
        // whichever mode was set when the page loaded and a check run after switching to
        // eyes-closed would silently apply eyes-open thresholds.
    }, [alphaMode]);

    const startCalibration = useCallback(() => {
        calRef.current.start(performance.now());
        setCalPhase('blink');          // the check now opens on the blink phase
        setCalElapsedS(0);
    }, []);

    const confirmCalibration = useCallback(() => {
        const now = performance.now();
        calRef.current.confirm(now);
        setCalElapsedS(calRef.current.elapsedS(now));
        applyCalibration();
        setCalPhase('done');
    }, [applyCalibration]);

    // The engine is built with the global entry level, so the default mode has to be applied
    // once the engine exists or it would be a label with no effect. An explicit `?enter=` wins:
    // the operator has already said what they want.
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine || !cfg || cfg.enterGiven) return;
        for (const s of SLOTS) {
            const t = thresholdsFor(alphaMode[s], calRef.current.result(s));
            engine.setThresholds(s, t.onDb, t.offDb);
        }
        setTick((x) => x + 1);
    }, [cfg, alphaMode]);

    /** Mode picker: re-derive this person's thresholds, using their check if they have one. */
    const setMode = useCallback((slot: Slot, mode: AlphaMode) => {
        setAlphaMode((prev) => ({ ...prev, [slot]: mode }));
        const engine = engineRef.current;
        if (!engine) return;
        const t = thresholdsFor(mode, calRef.current.result(slot));
        engine.setThresholds(slot, t.onDb, t.offDb);
        setTick((x) => x + 1);
    }, []);

    /** Dragging the on-line in the detector lane. The exit level follows below it. */
    const setEnterDb = useCallback((slot: Slot, onDb: number) => {
        const engine = engineRef.current;
        if (!engine) return;
        // Clamped here rather than in each control, so the nudge buttons, the drag and anything
        // added later cannot walk the threshold out of the range the lane can even draw.
        const on = Math.min(MAX_ENTER_DB, Math.max(MIN_ENTER_DB, Math.round(onDb * 10) / 10));
        engine.setThresholds(slot, on, on - HYSTERESIS_DB);
        setTick((x) => x + 1);
    }, []);

    const closeCalibration = useCallback(() => {
        calRef.current.cancel();
        setCalPhase('idle');
    }, []);

    // The countdown and the automatic blink -> closed -> open -> done advance.
    //
    // Driven by a timer and not by the hops, so the check runs on at the right pace even while
    // a headset is silent — otherwise a person who is not streaming would freeze the panel for
    // the pair who are. The gate is "any phase that is not idle or done" rather than a list of
    // the running ones: it used to be a list, and when the blink phase was added the list went
    // stale, so the panel opened on a phase the effect did not recognise and simply sat there.
    useEffect(() => {
        if (calPhase === 'idle' || calPhase === 'done') return;
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
                liveness={{ 1: calRef.current.liveness(1), 2: calRef.current.liveness(2) }}
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
                <Hint
                    bare
                    title="The link to TouchDesigner"
                    body={<>The WebSocket at <code>{cfg?.tdUrl}</code>, and how many messages have gone down
                        it. The count has to be climbing: while it says <i>searching</i> the projection is
                        receiving nothing at all, however good the signal looks on this page.</>}
                >
                    <span className={`flex items-center gap-1 ${tdConnected ? 'text-green-600' : 'text-gray-400'}`}>
                        <span className={`inline-block h-2.5 w-2.5 rounded-full ${tdConnected ? 'bg-green-500' : 'bg-gray-400'}`} />
                        TD {tdConnected ? 'connected' : 'searching'} · {msgCount.current} sent
                    </span>
                    <Info />
                </Hint>
                <Hint
                    bare
                    title="pair_level — the synchrony value"
                    body={<>The lower of the two levels, and 0 unless <i>both</i> sides are ok. One person
                        alone can never raise it.
                        <br /><br />
                        <b>In TouchDesigner:</b> above 0 both heads turn past forward to face each other over
                        a 3 s ease; hold it for the <i>Hold time</i> and the transition plays. It also drives
                        tempo, snare, swing, echo and filter resonance — and the wobble and the distortion
                        ride <code>1 − pair_level</code>, so they fall away as the two come together. Arriving
                        is meant to sound settled, not busier.</>}
                >
                    <span className={engine && engine.dyad.pairLevel > 0 ? 'text-green-600' : 'text-gray-400'}>
                        pair {(engine?.dyad.pairLevel ?? 0).toFixed(2)}
                    </span>
                    <Info />
                </Hint>
                {/* always re-enters the check, so each new pair gets its own ceilings */}
                <Button variant="outline" className="rounded-xl" disabled={!!replay} onClick={startCalibration}
                    title={'Run the 15 s check: three 5 s phases — eyes open blinking five times,\n'
                        + 'eyes closed, then eyes open and still.\n\n'
                        + 'Each phase ignores its first 2 s, because the detector reports prominence over a\n'
                        + 'trailing 2 s window and a reading taken sooner is partly measuring the previous\n'
                        + 'phase. Only readings that really belong to a phase reach its median.\n\n'
                        + 'The blinks are the check that the electrodes are picking each person up at all. A\n'
                        + 'blink is large and deliberate, so an electrode that misses it is not making contact —\n'
                        + 'which otherwise looks identical to a person with weak alpha.\n\n'
                        + 'Each person is measured separately, so one person can be calibrated on their own —\n'
                        + 'the other device does not have to be connected. Whoever is not sending stays on the\n'
                        + '12 dB default and is left alone.\n\n'
                        + 'Pressing it again always restarts the check and discards the previous pair, which is\n'
                        + 'how you hand the piece over to the next people.'}>
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
                    <Hint
                        title="Notch — which mains frequency is being filtered out"
                        body={<>The building&rsquo;s electricity induces a strong hum in the electrodes: 60 Hz
                            in North America, 50 Hz in most of Europe and Asia. It is interference, not brain
                            activity, so a notch filter removes it before anything is measured.
                            <br /><br />
                            This is also what the <b>mains</b> figure on each chip reports — how much of that
                            hum the electrode is picking up, which is the best single measure of how well it
                            is sitting. If a chip says <i>50 Hz?</i> or <i>60 Hz?</i>, the notch is set to the
                            wrong one: reload with <code>?mains=50</code> or <code>?mains=60</code>.</>}
                    >
                        notch {cfg?.mains ?? 60} Hz
                    </Hint>
                    {cfg && cfg.enterDb !== 5 && <span className="ml-1 text-amber-600">· enter {cfg.enterDb} dB / exit {cfg.exitDb} dB</span>}
                    {/* Say so when a quality limit has been moved: otherwise a green chip in a
                        noisy room looks like a measurement rather than a setting. */}
                    {settings?.mainsRedEnabled && (
                        <span className="ml-1 text-amber-600">· mains rejects over {settings.mainsRedUv} µV</span>
                    )}
                    {settings && settings.artifactRed !== DEFAULT_SETTINGS.artifactRed && (
                        <span className="ml-1 text-amber-600">· restless limit {Math.round(settings.artifactRed * 100)}%</span>
                    )}
                    {' '}· marks: <b>C</b> eyes closed, <b>O</b> eyes open, <b>X</b> end
                    {mark !== 0 && <span className={mark === 1 ? 'text-blue-600' : 'text-orange-600'}> ({mark === 1 ? 'eyes closed' : 'eyes open'} block)</span>}
                </span>
            </div>

            {settings && (
                <SettingsPanel settings={settings} labels={CHANNEL_LABELS}
                    onChange={changeSettings} onReset={resetSettings} />
            )}

            {cfg && <Legend enterDb={cfg.enterDb} exitDb={cfg.exitDb} mains={cfg.mains} />}

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
                                        <Hint
                                            bare
                                            title={`d${slot}_ok — can this side be trusted`}
                                            body={<>1 when the device is sending, at least one electrode is
                                                usable, and no electrode you have left switched in is red.
                                                <br /><br />
                                                <b>In TouchDesigner:</b> at <i>not ok</i> this side fades to
                                                grey and its head turns away, so a lost signal can never look
                                                like calm — and <code>pair_level</code> is forced to 0.</>}
                                        >
                                            <span className={person.ok ? 'text-green-600' : 'text-red-600'}>{person.ok ? 'ok' : 'not ok'}</span>
                                            <Info />
                                        </Hint>
                                        <Hint
                                            bare
                                            title={`d${slot}_level — how far into alpha`}
                                            body={<>0 to 1, scaled to this person&rsquo;s own ceiling, so 1
                                                means as strong as their own eyes-closed baseline. 0 means the
                                                vote did not pass.
                                                <br /><br />
                                                <b>In TouchDesigner:</b> the head turn toward the other person,
                                                how far their object calms, and that side&rsquo;s share of the
                                                mix. The panel below spells out what it is doing right now.</>}
                                        >
                                            <span className={person.level > 0 ? 'font-medium text-green-700 dark:text-green-400' : ''}>
                                                {person.level > 0 ? `alpha · level ${person.level.toFixed(2)}` : 'no alpha'}
                                            </span>
                                            <Info />
                                        </Hint>
                                        <Hint
                                            bare
                                            title="The vote"
                                            body={<>Electrodes seeing alpha, out of the ones still usable (not
                                                red, not switched out by you). Informational: the first usable
                                                input is the <b>reading electrode</b> and it decides on its
                                                own, at once — these headsets are one differential channel, so
                                                there is nothing to vote between.
                                                <br /><br />
                                                <b>In TouchDesigner:</b> this is what lets the level leave 0 at
                                                all. One noisy electrode outvoting two quiet ones is the usual
                                                reason the piece reacts when nobody feels calm.</>}
                                        >
                                            <span className="text-gray-500">{person.voting}/{person.usable} electrodes</span>
                                            <Info />
                                        </Hint>
                                    </>
                                )}
                                {person && !person.calibrated && (
                                    <Hint
                                        bare
                                        title="Uncalibrated — running on the default ceiling"
                                        body={<>This person has not done the 15 s check, so their level is
                                            scaled against a default ceiling of 12 dB instead of their own
                                            eyes-closed baseline.
                                            <br /><br />
                                            The piece still works; it just reads a strong person as shallower
                                            than they are and a weak one as deeper. Press <b>Calibrate</b> —
                                            and note that it works for one person on their own, so this label
                                            can clear on one side while the other stays uncalibrated.</>}
                                    >
                                        <span className="rounded bg-gray-200 dark:bg-gray-800 px-1.5 text-xs">uncalibrated</span>
                                        <Info />
                                    </Hint>
                                )}
                            </div>

                            <TdReadout
                                slot={slot}
                                person={person}
                                streaming={streaming}
                                ceilingDb={engine?.ceilingDb[slot]}
                                defaultCeilingDb={engine?.dyadParams.defaultCeilingDb ?? 12}
                                enterDb={engine?.thresholdDb[slot]?.onDb ?? cfg?.enterDb ?? 5}
                                exitDb={engine?.thresholdDb[slot]?.offDb ?? cfg?.exitDb ?? 2}
                                waveLabel={engine ? CHANNEL_LABELS[engine.waveChannel(slot)] : undefined}
                            />
                            {/* The alpha controls and the lane they act on sit above the graph:
                                this is what the operator watches and adjusts, so it belongs at
                                the top rather than under 38vh of waveform. */}
                            <AlphaControls
                                slot={slot}
                                mode={alphaMode[slot]}
                                onMode={(m) => setMode(slot, m)}
                                enterDb={engine?.thresholdDb[slot]?.onDb ?? cfg?.enterDb ?? 5}
                                exitDb={engine?.thresholdDb[slot]?.offDb ?? cfg?.exitDb ?? 2}
                                onEnterDbChange={(db) => setEnterDb(slot, db)}
                                onResetToMode={() => setMode(slot, alphaMode[slot])}
                                person={person}
                                streaming={streaming}
                                calibrated={!!person?.calibrated}
                                locked={cfg?.enterGiven}
                            />
                            {cfg && <DetectorLane chartRef={chartRefs[slot]}
                                enterDb={engine?.thresholdDb[slot]?.onDb ?? cfg.enterDb}
                                exitDb={engine?.thresholdDb[slot]?.offDb ?? cfg.exitDb}
                                onEnterDbChange={cfg.enterGiven ? undefined : (db) => setEnterDb(slot, db)} />}

                            <div className="flex flex-wrap gap-1.5">
                                {engine && engine.chains[slot].status.map((s, i) => (
                                    <SignalChip key={i} label={CHANNEL_LABELS[i]} status={s} mains={cfg?.mains ?? 60}
                                        excluded={engine.excluded[slot].has(i)}
                                        reading={i === engine.readingChannel(slot)}
                                        unwired={i >= (settings?.chans ?? CHANNEL_LABELS.length) && engine.excluded[slot].has(i)}
                                        onToggle={() => {
                                            const ex = engine.excluded[slot];
                                            if (ex.has(i)) ex.delete(i); else ex.add(i);
                                            setTick((t) => t + 1);
                                        }} />
                                ))}
                            </div>
                            <div ref={containerRefs[slot]} className="w-full h-[38vh] min-h-[220px] rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden" />
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
