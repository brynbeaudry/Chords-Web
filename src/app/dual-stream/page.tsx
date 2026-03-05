'use client';
import React, {
    useEffect,
    useRef,
    useState,
    useCallback,
} from "react";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { saveAs } from "file-saver";
import { WebglPlot, ColorRGBA, WebglLine } from "webgl-plot";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { EXGFilter, Notch, HighPassFilter, BandpassFilter, BandType } from '@/components/filters';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Circle,
    CircleStop,
    CircleX,
    Infinity,
    Trash2,
    Download,
    FileArchive,
    Pause,
    Play,
    CircleOff,
    ReplaceAll,
    Heart,
    Brain,
    Eye,
    BicepsFlexed,
    Settings,
    Loader,
    Wifi,
    WifiOff,
    Terminal,
    Activity,
} from "lucide-react";
import { lightThemeColors, darkThemeColors, getCustomColor } from '@/components/Colors';
import { useTheme } from "next-themes";
import { WebSocketStreamer } from '@/services/WebSocketStreamer';

const DualStream = () => {
    // ─── Shared state ───────────────────────────────────────────────
    const isRecordingRef = useRef<boolean>(false);
    const [isDisplay, setIsDisplay] = useState<boolean>(true);
    const [isRecord, setIsrecord] = useState<boolean>(true);
    const [isEndTimePopoverOpen, setIsEndTimePopoverOpen] = useState(false);
    const [datasets, setDatasets] = useState<any[]>([]);
    const [recordingElapsedTime, setRecordingElapsedTime] = useState<number>(0);
    const [customTimeInput, setCustomTimeInput] = useState<string>("");
    const existingRecordRef = useRef<any | undefined>(undefined);
    const samplingrateref = useRef<number>(500);
    const recordingStartTimeRef = useRef<number>(0);
    const endTimeRef = useRef<number | null>(null);
    const [isFilterPopoverOpen, setIsFilterPopoverOpen] = useState(false);
    const NUM_BUFFERS = 4;
    const MAX_BUFFER_SIZE = 500;
    const dataPointCountRef = useRef<number>(2000);
    const maxCanvasElementCountRef = useRef<number>(3);
    const channelNames = Array.from({ length: maxCanvasElementCountRef.current }, (_, i) => `CH${i + 1}`);
    const numChannels = 3;
    const [selectedChannels, setSelectedChannels] = useState<number[]>([1]);
    const [manuallySelected, setManuallySelected] = useState(false);
    const { theme } = useTheme();
    const isDarkModeEnabled = theme === "dark";
    const activeTheme: 'light' | 'dark' = isDarkModeEnabled ? 'dark' : 'light';
    const [isAllEnabledChannelSelected, setIsAllEnabledChannelSelected] = useState(false);
    const [isSelectAllDisabled, setIsSelectAllDisabled] = useState(false);
    const [open, setOpen] = useState(false);
    const selectedChannelsRef = useRef(selectedChannels);
    const [Zoom, SetZoom] = useState<number>(1);
    const [timeBase, setTimeBase] = useState<number>(4);
    const pauseRef = useRef<boolean>(true);
    const canvasElementCountRef = useRef<number>(1);
    const consoleLogRef = useRef<boolean>(false);

    // Live data readout — refs hold latest values, state updates throttled to ~15Hz
    interface LiveData {
        filtered: number[];
        raw: number[];
        counter: number;
        bands: { [band: string]: number[] };
    }
    const emptyLive: LiveData = { filtered: [0, 0, 0], raw: [0, 0, 0], counter: 0, bands: {} };
    const d1LatestRef = useRef<LiveData>({ ...emptyLive });
    const d2LatestRef = useRef<LiveData>({ ...emptyLive });
    const [d1Live, setD1Live] = useState<LiveData>({ ...emptyLive });
    const [d2Live, setD2Live] = useState<LiveData>({ ...emptyLive });
    const [showLiveData, setShowLiveData] = useState(true);

    useEffect(() => {
        const interval = setInterval(() => {
            setD1Live({ ...d1LatestRef.current, bands: { ...d1BandDataRef.current } });
            setD2Live({ ...d2LatestRef.current, bands: { ...d2BandDataRef.current } });
        }, 66); // ~15Hz UI refresh
        return () => clearInterval(interval);
    }, []);

    const togglePause = () => {
        const newPauseState = !isDisplay;
        setIsDisplay(newPauseState);
        pauseRef.current = newPauseState;
    };

    const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
    const DATA_CHAR_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
    const CONTROL_CHAR_UUID = "0000ff01-0000-1000-8000-00805f9b34fb";
    const SINGLE_SAMPLE_LEN = 7;
    const BLOCK_COUNT = 10;
    const NEW_PACKET_LEN = SINGLE_SAMPLE_LEN * BLOCK_COUNT;

    // ─── Device 1 state ─────────────────────────────────────────────
    const d1DeviceRef = useRef<any | null>(null);
    const [isD1Connected, setIsD1Connected] = useState(false);
    const [isD1Loading, setIsD1Loading] = useState(false);
    const d1ContainerRef = useRef<HTMLDivElement>(null);
    const [d1WglPlots, setD1WglPlots] = useState<WebglPlot[]>([]);
    const [d1CanvasElements, setD1CanvasElements] = useState<HTMLCanvasElement[]>([]);
    const d1LinesRef = useRef<WebglLine[]>([]);
    const d1SweepPositions = useRef<number[]>(new Array(6).fill(0));
    const d1CurrentSweepPos = useRef<number[]>(new Array(6).fill(0));
    const d1SamplesReceivedRef = useRef(0);
    const d1PrevSampleCounter = useRef<number | null>(null);
    const d1ChannelDataRef = useRef<number[]>([]);
    const d1ActiveBufferIndex = useRef<number>(0);
    const d1FillingIndex = useRef<number>(0);
    const d1RecordingBuffers = useRef(
        Array(NUM_BUFFERS).fill(null).map(() => [] as number[][])
    );
    const d1IntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Device 1 filters (separate instances — filters have internal state)
    const d1NotchFiltersRef = useRef(Array.from({ length: 3 }, () => new Notch()));
    const d1ExgFiltersRef = useRef(Array.from({ length: 3 }, () => new EXGFilter()));
    const d1HighPassFiltersRef = useRef(Array.from({ length: 3 }, () => new HighPassFilter()));
    const d1AppliedFiltersRef = useRef<{ [key: number]: number }>({});
    const d1AppliedEXGFiltersRef = useRef<{ [key: number]: number }>({});

    // ─── Device 2 state ─────────────────────────────────────────────
    const d2DeviceRef = useRef<any | null>(null);
    const [isD2Connected, setIsD2Connected] = useState(false);
    const [isD2Loading, setIsD2Loading] = useState(false);
    const d2ContainerRef = useRef<HTMLDivElement>(null);
    const [d2WglPlots, setD2WglPlots] = useState<WebglPlot[]>([]);
    const [d2CanvasElements, setD2CanvasElements] = useState<HTMLCanvasElement[]>([]);
    const d2LinesRef = useRef<WebglLine[]>([]);
    const d2SweepPositions = useRef<number[]>(new Array(6).fill(0));
    const d2CurrentSweepPos = useRef<number[]>(new Array(6).fill(0));
    const d2SamplesReceivedRef = useRef(0);
    const d2PrevSampleCounter = useRef<number | null>(null);
    const d2ChannelDataRef = useRef<number[]>([]);
    const d2ActiveBufferIndex = useRef<number>(0);
    const d2FillingIndex = useRef<number>(0);
    const d2RecordingBuffers = useRef(
        Array(NUM_BUFFERS).fill(null).map(() => [] as number[][])
    );
    const d2IntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Device 2 filters
    const d2NotchFiltersRef = useRef(Array.from({ length: 3 }, () => new Notch()));
    const d2ExgFiltersRef = useRef(Array.from({ length: 3 }, () => new EXGFilter()));
    const d2HighPassFiltersRef = useRef(Array.from({ length: 3 }, () => new HighPassFilter()));
    const d2AppliedFiltersRef = useRef<{ [key: number]: number }>({});
    const d2AppliedEXGFiltersRef = useRef<{ [key: number]: number }>({});

    // ─── Band filter state ──────────────────────────────────────────
    const d1BandFiltersRef = useRef<Map<BandType, BandpassFilter[]>>(new Map([
        ['alpha', Array.from({ length: 3 }, () => new BandpassFilter('alpha'))],
        ['theta', Array.from({ length: 3 }, () => new BandpassFilter('theta'))],
        ['delta', Array.from({ length: 3 }, () => new BandpassFilter('delta'))],
    ]));
    const d2BandFiltersRef = useRef<Map<BandType, BandpassFilter[]>>(new Map([
        ['alpha', Array.from({ length: 3 }, () => new BandpassFilter('alpha'))],
        ['theta', Array.from({ length: 3 }, () => new BandpassFilter('theta'))],
        ['delta', Array.from({ length: 3 }, () => new BandpassFilter('delta'))],
    ]));
    const d1EnabledBandsRef = useRef<{ [channel: number]: Set<BandType> }>({});
    const d2EnabledBandsRef = useRef<{ [channel: number]: Set<BandType> }>({});
    const d1BandGainRef = useRef<{ [channel: number]: number }>({});
    const d2BandGainRef = useRef<{ [channel: number]: number }>({});
    const d1BandDataRef = useRef<{ [band: string]: number[] }>({});
    const d2BandDataRef = useRef<{ [band: string]: number[] }>({});
    const d1BandLinesRef = useRef<Record<BandType, WebglLine>[]>([]);
    const d2BandLinesRef = useRef<Record<BandType, WebglLine>[]>([]);
    const [isBandPopoverOpen, setIsBandPopoverOpen] = useState(false);

    const BAND_COLORS: Record<BandType, string> = {
        alpha: '#00FFFF',
        theta: '#FF8800',
        delta: '#FF00FF',
    };

    // ─── WebSocket / TouchDesigner state ────────────────────────────
    const streamerRef = useRef<WebSocketStreamer | null>(null);
    const [isTDConnected, setIsTDConnected] = useState(false);

    useEffect(() => {
        streamerRef.current = new WebSocketStreamer();
        return () => {
            streamerRef.current?.disconnectAll();
        };
    }, []);

    // ─── Filter initialization ──────────────────────────────────────
    d1NotchFiltersRef.current.forEach((f) => f.setbits(samplingrateref.current));
    d1ExgFiltersRef.current.forEach((f) => f.setbits("12", samplingrateref.current));
    d1HighPassFiltersRef.current.forEach((f) => f.setSamplingRate(samplingrateref.current));

    d2NotchFiltersRef.current.forEach((f) => f.setbits(samplingrateref.current));
    d2ExgFiltersRef.current.forEach((f) => f.setbits("12", samplingrateref.current));
    d2HighPassFiltersRef.current.forEach((f) => f.setSamplingRate(samplingrateref.current));

    // Band filter sampling rate init
    for (const filters of d1BandFiltersRef.current.values()) {
        filters.forEach((f) => f.setSamplingRate(samplingrateref.current));
    }
    for (const filters of d2BandFiltersRef.current.values()) {
        filters.forEach((f) => f.setSamplingRate(samplingrateref.current));
    }

    // ─── Zoom / timeBase refs ───────────────────────────────────────
    const zoomRef = useRef(Zoom);
    useEffect(() => { zoomRef.current = Zoom; }, [Zoom]);
    useEffect(() => { dataPointCountRef.current = samplingrateref.current * timeBase; }, [timeBase]);
    useEffect(() => { selectedChannelsRef.current = selectedChannels; }, [selectedChannels]);
    useEffect(() => { canvasElementCountRef.current = selectedChannels.length; }, [selectedChannels]);

    // ─── Filter state & UI helpers ──────────────────────────────────
    const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
    const [, forceEXGUpdate] = React.useReducer((x: number) => x + 1, 0);

    // We apply filters to BOTH devices simultaneously from the shared UI
    const removeEXGFilter = (channelIndex: number) => {
        delete d1AppliedEXGFiltersRef.current[channelIndex];
        delete d2AppliedEXGFiltersRef.current[channelIndex];
        forceEXGUpdate();
    };
    const handleFrequencySelectionEXG = (channelIndex: number, frequency: number) => {
        d1AppliedEXGFiltersRef.current[channelIndex] = frequency;
        d2AppliedEXGFiltersRef.current[channelIndex] = frequency;
        forceEXGUpdate();
    };
    const applyEXGFilterToAllChannels = (channels: number[], frequency: number) => {
        channels.forEach((ch) => {
            d1AppliedEXGFiltersRef.current[ch] = frequency;
            d2AppliedEXGFiltersRef.current[ch] = frequency;
        });
        forceEXGUpdate();
    };
    const removeEXGFilterFromAllChannels = (channels: number[]) => {
        channels.forEach((ch) => {
            delete d1AppliedEXGFiltersRef.current[ch];
            delete d2AppliedEXGFiltersRef.current[ch];
        });
        forceEXGUpdate();
    };
    const removeNotchFilter = (channelIndex: number) => {
        delete d1AppliedFiltersRef.current[channelIndex];
        delete d2AppliedFiltersRef.current[channelIndex];
        forceUpdate();
    };
    const handleFrequencySelection = (channelIndex: number, frequency: number) => {
        d1AppliedFiltersRef.current[channelIndex] = frequency;
        d2AppliedFiltersRef.current[channelIndex] = frequency;
        forceUpdate();
    };
    const applyFilterToAllChannels = (channels: number[], frequency: number) => {
        channels.forEach((ch) => {
            d1AppliedFiltersRef.current[ch] = frequency;
            d2AppliedFiltersRef.current[ch] = frequency;
        });
        forceUpdate();
    };
    const removeNotchFromAllChannels = (channels: number[]) => {
        channels.forEach((ch) => {
            delete d1AppliedFiltersRef.current[ch];
            delete d2AppliedFiltersRef.current[ch];
        });
        forceUpdate();
    };

    // ─── Band toggle / gain helpers ─────────────────────────────────
    // Lazily create a WebGL band line for a specific channel+band
    const ensureBandLine = (band: BandType, channelIndex: number) => {
        const channelNumber = channelIndex + 1;
        for (const slot of [1, 2] as const) {
            const plots = slot === 1 ? d1WglPlots : d2WglPlots;
            const bandLinesArr = slot === 1 ? d1BandLinesRef : d2BandLinesRef;
            const selIdx = selectedChannelsRef.current.indexOf(channelNumber);
            if (selIdx < 0 || selIdx >= plots.length) continue;
            const bandMap = bandLinesArr.current[selIdx];
            if (!bandMap || bandMap[band]) continue; // already exists
            const wglp = plots[selIdx];
            if (!wglp) continue;
            const dpCount = dataPointCountRef.current;
            const bLine = new WebglLine(BAND_LINE_COLORS[band], dpCount);
            bLine.offsetY = 0;
            bLine.lineSpaceX(-1, 2 / dpCount);
            // Initialize all points to NaN so the line is invisible until data flows
            for (let p = 0; p < dpCount; p++) bLine.setY(p, NaN);
            wglp.addLine(bLine);
            bandMap[band] = bLine;
        }
    };

    const toggleBand = (channelIndex: number, band: BandType) => {
        for (const ref of [d1EnabledBandsRef, d2EnabledBandsRef]) {
            if (!ref.current[channelIndex]) ref.current[channelIndex] = new Set();
            if (ref.current[channelIndex].has(band)) {
                ref.current[channelIndex].delete(band);
            } else {
                ref.current[channelIndex].add(band);
            }
        }
        // Ensure the WebGL line exists when enabling
        if (d1EnabledBandsRef.current[channelIndex]?.has(band)) {
            ensureBandLine(band, channelIndex);
        }
        updateLegends();
        forceUpdate();
    };

    const toggleBandAllChannels = (band: BandType) => {
        const allHave = Array.from({ length: numChannels }, (_, i) => i).every(
            (i) => d1EnabledBandsRef.current[i]?.has(band)
        );
        for (const ref of [d1EnabledBandsRef, d2EnabledBandsRef]) {
            for (let i = 0; i < numChannels; i++) {
                if (!ref.current[i]) ref.current[i] = new Set();
                if (allHave) {
                    ref.current[i].delete(band);
                } else {
                    ref.current[i].add(band);
                }
            }
        }
        // Ensure WebGL lines exist when enabling
        if (!allHave) {
            for (let i = 0; i < numChannels; i++) {
                ensureBandLine(band, i);
            }
        }
        updateLegends();
        forceUpdate();
    };

    const setBandGain = (channelIndex: number, gain: number) => {
        d1BandGainRef.current[channelIndex] = gain;
        d2BandGainRef.current[channelIndex] = gain;
        forceUpdate();
    };

    const allHaveBand = (band: BandType) =>
        Array.from({ length: numChannels }, (_, i) => i).every(
            (i) => d1EnabledBandsRef.current[i]?.has(band)
        );

    const updateLegends = () => {
        for (const slot of [1, 2] as const) {
            const enabledRef = slot === 1 ? d1EnabledBandsRef : d2EnabledBandsRef;
            selectedChannels.forEach((channelNumber) => {
                const legend = document.getElementById(`legend-d${slot}-ch${channelNumber}`);
                if (!legend) return;
                legend.innerHTML = '';
                const enabled = enabledRef.current[channelNumber - 1];
                if (!enabled) return;
                for (const band of ['alpha', 'theta', 'delta'] as BandType[]) {
                    if (enabled.has(band)) {
                        const span = document.createElement('span');
                        span.className = 'flex items-center gap-1';
                        span.innerHTML = `<span style="color:${BAND_COLORS[band]}">●</span>${band.charAt(0).toUpperCase() + band.slice(1)}`;
                        legend.appendChild(span);
                    }
                }
            });
        }
    };

    // ─── Band line colors (shared by canvas creation + lazy creation) ──
    const BAND_LINE_COLORS: Record<BandType, ColorRGBA> = {
        alpha: new ColorRGBA(0, 1, 1, 1),
        theta: new ColorRGBA(1, 0.53, 0, 1),
        delta: new ColorRGBA(1, 0, 1, 1),
    };

    // ─── Canvas creation ────────────────────────────────────────────
    const getLineColor = (channelNumber: number, t: string | undefined): ColorRGBA => {
        const index = channelNumber - 1;
        const colors = t === "dark" ? darkThemeColors : lightThemeColors;
        const hex = colors[index % colors.length];
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        const alpha = t === "dark" ? 1 : 0.8;
        return new ColorRGBA(r, g, b, alpha);
    };

    const createDeviceCanvases = (
        slot: 1 | 2,
    ) => {
        const containerRef = slot === 1 ? d1ContainerRef : d2ContainerRef;
        const setPlots = slot === 1 ? setD1WglPlots : setD2WglPlots;
        const setCanvases = slot === 1 ? setD1CanvasElements : setD2CanvasElements;
        const linesRef = slot === 1 ? d1LinesRef : d2LinesRef;
        const bandLinesRef = slot === 1 ? d1BandLinesRef : d2BandLinesRef;
        const sweepPos = slot === 1 ? d1SweepPositions : d2SweepPositions;
        const curSweepPos = slot === 1 ? d1CurrentSweepPos : d2CurrentSweepPos;

        const container = containerRef.current;
        if (!container) return;

        const dpCount = samplingrateref.current * timeBase;
        dataPointCountRef.current = dpCount;

        curSweepPos.current = new Array(numChannels).fill(0);
        sweepPos.current = new Array(numChannels).fill(0);

        // Clear existing children
        while (container.firstChild) {
            const firstChild = container.firstChild;
            if (firstChild instanceof HTMLCanvasElement) {
                const gl = firstChild.getContext("webgl");
                if (gl) {
                    const loseContext = gl.getExtension("WEBGL_lose_context");
                    if (loseContext) loseContext.loseContext();
                }
            }
            container.removeChild(firstChild);
        }

        setCanvases([]);
        setPlots([]);
        linesRef.current = [];
        bandLinesRef.current = [];

        const newCanvasElements: HTMLCanvasElement[] = [];
        const newWglPlots: WebglPlot[] = [];
        const newLines: WebglLine[] = [];

        // Grid lines
        const canvasWrapper = document.createElement("div");
        canvasWrapper.className = "absolute inset-0";
        const opacityDarkMajor = "0.2";
        const opacityDarkMinor = "0.05";
        const opacityLightMajor = "0.4";
        const opacityLightMinor = "0.1";
        const distanceminor = samplingrateref.current * 0.04;
        const numGridLines = (500 * 4) / distanceminor;

        for (let j = 1; j < numGridLines; j++) {
            const gridLineX = document.createElement("div");
            gridLineX.className = "absolute bg-[rgb(128,128,128)]";
            gridLineX.style.width = "1px";
            gridLineX.style.height = "100%";
            gridLineX.style.left = `${((j / numGridLines) * 100).toFixed(3)}%`;
            gridLineX.style.opacity = j % 5 === 0 ? (theme === "dark" ? opacityDarkMajor : opacityLightMajor) : (theme === "dark" ? opacityDarkMinor : opacityLightMinor);
            canvasWrapper.appendChild(gridLineX);
        }

        const horizontalline = 50;
        for (let j = 1; j < horizontalline; j++) {
            const gridLineY = document.createElement("div");
            gridLineY.className = "absolute bg-[rgb(128,128,128)]";
            gridLineY.style.height = "1px";
            gridLineY.style.width = "100%";
            gridLineY.style.top = `${((j / horizontalline) * 100).toFixed(3)}%`;
            gridLineY.style.opacity = j % 5 === 0 ? (theme === "dark" ? opacityDarkMajor : opacityLightMajor) : (theme === "dark" ? opacityDarkMinor : opacityLightMinor);
            canvasWrapper.appendChild(gridLineY);
        }
        container.appendChild(canvasWrapper);

        selectedChannels.forEach((channelNumber) => {
            const wrapper = document.createElement("div");
            wrapper.className = "canvas-container relative flex-[1_1_0%]";

            const canvas = document.createElement("canvas");
            canvas.id = `canvas-d${slot}-ch${channelNumber}`;
            canvas.width = container.clientWidth;
            canvas.height = container.clientHeight / selectedChannels.length;
            canvas.className = "w-full h-full block rounded-xl";

            const badge = document.createElement("div");
            badge.className = "absolute text-gray-500 text-sm rounded-full p-2 m-2";
            badge.innerText = `CH${channelNumber}`;

            const legend = document.createElement("div");
            legend.className = "absolute top-1 right-8 flex gap-2 text-xs z-10";
            legend.id = `legend-d${slot}-ch${channelNumber}`;

            wrapper.appendChild(badge);
            wrapper.appendChild(legend);
            wrapper.appendChild(canvas);
            container.appendChild(wrapper);

            newCanvasElements.push(canvas);
            const wglp = new WebglPlot(canvas);
            newWglPlots.push(wglp);
            wglp.gScaleY = Zoom;

            const line = new WebglLine(getLineColor(channelNumber, theme), dpCount);
            wglp.gOffsetY = 0;
            line.offsetY = 0;
            line.lineSpaceX(-1, 2 / dpCount);

            wglp.addLine(line);
            newLines.push(line);

            // Placeholder for band lines — created lazily when enabled
            bandLinesRef.current.push({} as Record<BandType, WebglLine>);
        });

        linesRef.current = newLines;

        // Re-create band lines for any currently-enabled bands
        const enabledRef = slot === 1 ? d1EnabledBandsRef : d2EnabledBandsRef;
        selectedChannels.forEach((channelNumber, selIdx) => {
            const channelIdx = channelNumber - 1;
            const enabled = enabledRef.current[channelIdx];
            if (!enabled || enabled.size === 0) return;
            const wglp = newWglPlots[selIdx];
            if (!wglp) return;
            const bandMap = bandLinesRef.current[selIdx];
            if (!bandMap) return;
            for (const band of enabled) {
                const bLine = new WebglLine(BAND_LINE_COLORS[band], dpCount);
                bLine.offsetY = 0;
                bLine.lineSpaceX(-1, 2 / dpCount);
                for (let p = 0; p < dpCount; p++) bLine.setY(p, NaN);
                wglp.addLine(bLine);
                bandMap[band] = bLine;
            }
        });

        setCanvases(newCanvasElements);
        setPlots(newWglPlots);
    };

    // ─── Plot update functions ──────────────────────────────────────
    const updateDevicePlots = useCallback(
        (slot: 1 | 2, data: number[], zoom: number) => {
            const plots = slot === 1 ? d1WglPlots : d2WglPlots;
            const lines = slot === 1 ? d1LinesRef : d2LinesRef;
            const bandLinesArr = slot === 1 ? d1BandLinesRef : d2BandLinesRef;
            const enabledBandsRef = slot === 1 ? d1EnabledBandsRef : d2EnabledBandsRef;
            const bandDataRef = slot === 1 ? d1BandDataRef : d2BandDataRef;
            const bandGainRef = slot === 1 ? d1BandGainRef : d2BandGainRef;
            const sweepPos = slot === 1 ? d1SweepPositions : d2SweepPositions;
            const setLoading = slot === 1 ? setIsD1Loading : setIsD2Loading;
            const setConnected = slot === 1 ? setIsD1Connected : setIsD2Connected;

            setLoading(false);
            setConnected(true);

            const currentSelectedChannels = selectedChannelsRef.current;

            plots.forEach((wglp, index) => {
                if (wglp) {
                    try { wglp.gScaleY = zoomRef.current; } catch (e) { /* noop */ }
                }
            });

            lines.current.forEach((line, i) => {
                if (!line) return;

                const channelNumber = currentSelectedChannels[i];
                if (channelNumber == null || channelNumber < 0 || channelNumber >= data.length) return;

                const channelData = data[channelNumber];

                if (sweepPos.current[i] === undefined) {
                    sweepPos.current[i] = 0;
                }

                const currentPos = sweepPos.current[i] % line.numPoints;
                if (Number.isNaN(currentPos)) return;

                try { line.setY(currentPos, channelData); } catch (e) { /* noop */ }

                const clearPosition = Math.ceil((currentPos + dataPointCountRef.current / 100) % line.numPoints);
                try { line.setY(clearPosition, NaN); } catch (e) { /* noop */ }

                // Band overlay lines — only iterate enabled bands
                const channelIdx = channelNumber - 1;
                const enabledBands = enabledBandsRef.current[channelIdx];
                if (enabledBands && enabledBands.size > 0) {
                    const gain = bandGainRef.current[channelIdx] ?? 3.0;
                    const bandLines = bandLinesArr.current[i];
                    if (bandLines) {
                        for (const band of enabledBands) {
                            const bLine = bandLines[band];
                            if (bLine) {
                                const val = bandDataRef.current[band]?.[channelIdx] ?? 0;
                                bLine.setY(currentPos, val * gain);
                                bLine.setY(clearPosition, NaN);
                            }
                        }
                    }
                }

                sweepPos.current[i] = (currentPos + 1) % line.numPoints;
            });
        },
        [d1WglPlots, d2WglPlots, d1LinesRef, d2LinesRef, d1SweepPositions, d2SweepPositions, Zoom, timeBase]
    );

    // ─── Sample processing ──────────────────────────────────────────
    const processDeviceSample = useCallback((slot: 1 | 2, dataView: DataView): void => {
        if (dataView.byteLength !== SINGLE_SAMPLE_LEN) return;

        const prevCounter = slot === 1 ? d1PrevSampleCounter : d2PrevSampleCounter;
        const channelDataRef = slot === 1 ? d1ChannelDataRef : d2ChannelDataRef;
        const notchFilters = slot === 1 ? d1NotchFiltersRef : d2NotchFiltersRef;
        const exgFilters = slot === 1 ? d1ExgFiltersRef : d2ExgFiltersRef;
        const highPassFilters = slot === 1 ? d1HighPassFiltersRef : d2HighPassFiltersRef;
        const appliedEXG = slot === 1 ? d1AppliedEXGFiltersRef : d2AppliedEXGFiltersRef;
        const appliedNotch = slot === 1 ? d1AppliedFiltersRef : d2AppliedFiltersRef;
        const bandFiltersMap = slot === 1 ? d1BandFiltersRef : d2BandFiltersRef;
        const enabledBandsRef = slot === 1 ? d1EnabledBandsRef : d2EnabledBandsRef;
        const bandDataRef = slot === 1 ? d1BandDataRef : d2BandDataRef;
        const samplesReceived = slot === 1 ? d1SamplesReceivedRef : d2SamplesReceivedRef;
        const activeBufferIdx = slot === 1 ? d1ActiveBufferIndex : d2ActiveBufferIndex;
        const fillingIdx = slot === 1 ? d1FillingIndex : d2FillingIndex;
        const recBuffers = slot === 1 ? d1RecordingBuffers : d2RecordingBuffers;

        const sampleCounter = dataView.getUint8(0);

        if (prevCounter.current === null) {
            prevCounter.current = sampleCounter;
        } else {
            const expected = (prevCounter.current + 1) % 256;
            if (sampleCounter !== expected) {
                console.log(`Device ${slot}: Missing sample: expected ${expected}, got ${sampleCounter}`);
            }
            prevCounter.current = sampleCounter;
        }

        channelDataRef.current = [sampleCounter];
        const rawChannels: number[] = [];

        const ADC_Y_SCALE = 2 / 4096; // 12-bit ADC scaling (matches EXGFilter.yScale)

        for (let channel = 0; channel < numChannels; channel++) {
            const sample = dataView.getInt16(1 + (channel * 2), false);
            rawChannels.push(sample);
            const hpOutput = highPassFilters.current[channel].process(sample);
            const filteredValue = notchFilters.current[channel].process(
                exgFilters.current[channel].process(
                    hpOutput,
                    appliedEXG.current[channel]
                ),
                appliedNotch.current[channel]
            );
            channelDataRef.current.push(filteredValue);

            // Band filtering — feed HP-filtered signal (before EXG yScale)
            const enabledBands = enabledBandsRef.current[channel];
            if (enabledBands && enabledBands.size > 0) {
                for (const band of enabledBands) {
                    const filter = bandFiltersMap.current.get(band)![channel];
                    const bandValue = filter.process(hpOutput) * ADC_Y_SCALE;
                    if (!bandDataRef.current[band]) bandDataRef.current[band] = [0, 0, 0];
                    bandDataRef.current[band][channel] = bandValue;
                }
            }
        }

        updateDevicePlots(slot, channelDataRef.current, zoomRef.current);

        // Store latest values for live readout
        const latestRef = slot === 1 ? d1LatestRef : d2LatestRef;
        latestRef.current = {
            filtered: channelDataRef.current.slice(1),
            raw: rawChannels,
            counter: sampleCounter,
            bands: latestRef.current.bands, // bands updated separately via bandDataRef
        };

        if (consoleLogRef.current) {
            const d = channelDataRef.current;
            console.log(`[D${slot} #${d[0]}] CH1: ${d[1]?.toFixed(2)}, CH2: ${d[2]?.toFixed(2)}, CH3: ${d[3]?.toFixed(2)}`);
        }

        // Stream to TouchDesigner
        if (streamerRef.current) {
            const filtered = channelDataRef.current.slice(1); // skip counter
            if (slot === 1) {
                streamerRef.current.setDevice1Filtered(filtered);
                streamerRef.current.setDevice1Raw(rawChannels);
            } else {
                streamerRef.current.setDevice2Filtered(filtered);
                streamerRef.current.setDevice2Raw(rawChannels);
            }
            streamerRef.current.sendFiltered('touchdesigner');

            // Send band data
            for (const band of ['alpha', 'theta', 'delta']) {
                const vals = bandDataRef.current[band];
                if (vals) {
                    if (slot === 1) streamerRef.current.setDevice1BandData(band, vals);
                    else streamerRef.current.setDevice2BandData(band, vals);
                }
            }
        }

        // Recording
        if (isRecordingRef.current) {
            const channeldatavalues = channelDataRef.current
                .slice(0, canvasElementCountRef.current + 1)
                .map((v) => (v !== undefined ? v : null))
                .filter((v): v is number => v !== null);

            recBuffers.current[activeBufferIdx.current][fillingIdx.current] = channeldatavalues;

            if (fillingIdx.current >= MAX_BUFFER_SIZE - 1) {
                processBuffer(activeBufferIdx.current, canvasElementCountRef.current, selectedChannels, slot);
                activeBufferIdx.current = (activeBufferIdx.current + 1) % NUM_BUFFERS;
            }

            fillingIdx.current = (fillingIdx.current + 1) % MAX_BUFFER_SIZE;

            const elapsedTime = Date.now() - recordingStartTimeRef.current;
            setRecordingElapsedTime((prev) => {
                if (endTimeRef.current !== null && elapsedTime >= endTimeRef.current) {
                    stopRecording();
                    return endTimeRef.current;
                }
                return elapsedTime;
            });
        }

        channelDataRef.current = [];
        samplesReceived.current += 1;
    }, [canvasElementCountRef.current, selectedChannels, timeBase, updateDevicePlots]);

    // ─── Stable notification handler refs (avoids stale closures) ───
    const processDevice1Ref = useRef((_dv: DataView) => {});
    const processDevice2Ref = useRef((_dv: DataView) => {});

    useEffect(() => {
        processDevice1Ref.current = (dataView: DataView) => processDeviceSample(1, dataView);
    }, [processDeviceSample]);

    useEffect(() => {
        processDevice2Ref.current = (dataView: DataView) => processDeviceSample(2, dataView);
    }, [processDeviceSample]);

    interface BluetoothRemoteGATTCharacteristicExtended extends EventTarget {
        value?: DataView;
    }

    function handleDevice1Notification(event: Event): void {
        const target = event.target as BluetoothRemoteGATTCharacteristicExtended;
        if (!target.value) return;
        if (d1CurrentSweepPos.current.length !== numChannels || !pauseRef.current) {
            d1CurrentSweepPos.current = new Array(numChannels).fill(0);
            d1SweepPositions.current = new Array(numChannels).fill(0);
        }
        const value = target.value;
        if (value.byteLength === NEW_PACKET_LEN) {
            for (let i = 0; i < NEW_PACKET_LEN; i += SINGLE_SAMPLE_LEN) {
                processDevice1Ref.current(new DataView(value.buffer.slice(i, i + SINGLE_SAMPLE_LEN)));
            }
        } else if (value.byteLength === SINGLE_SAMPLE_LEN) {
            processDevice1Ref.current(new DataView(value.buffer));
        }
    }

    function handleDevice2Notification(event: Event): void {
        const target = event.target as BluetoothRemoteGATTCharacteristicExtended;
        if (!target.value) return;
        if (d2CurrentSweepPos.current.length !== numChannels || !pauseRef.current) {
            d2CurrentSweepPos.current = new Array(numChannels).fill(0);
            d2SweepPositions.current = new Array(numChannels).fill(0);
        }
        const value = target.value;
        if (value.byteLength === NEW_PACKET_LEN) {
            for (let i = 0; i < NEW_PACKET_LEN; i += SINGLE_SAMPLE_LEN) {
                processDevice2Ref.current(new DataView(value.buffer.slice(i, i + SINGLE_SAMPLE_LEN)));
            }
        } else if (value.byteLength === SINGLE_SAMPLE_LEN) {
            processDevice2Ref.current(new DataView(value.buffer));
        }
    }

    // ─── Connect / Disconnect ───────────────────────────────────────
    async function connectDevice(slot: 1 | 2): Promise<void> {
        const setLoading = slot === 1 ? setIsD1Loading : setIsD2Loading;
        const setConnected = slot === 1 ? setIsD1Connected : setIsD2Connected;
        const deviceRef = slot === 1 ? d1DeviceRef : d2DeviceRef;
        const samplesReceived = slot === 1 ? d1SamplesReceivedRef : d2SamplesReceivedRef;
        const intervalRef = slot === 1 ? d1IntervalRef : d2IntervalRef;
        const handler = slot === 1 ? handleDevice1Notification : handleDevice2Notification;

        try {
            setLoading(true);
            const nav = navigator as any;
            if (!nav.bluetooth) {
                toast.error("Web Bluetooth API is not available in this browser.");
                setLoading(false);
                return;
            }

            const device = await nav.bluetooth.requestDevice({
                filters: [{ namePrefix: "NPG" }],
                optionalServices: [SERVICE_UUID],
            });

            const server = await device.gatt?.connect();
            if (!server) {
                setLoading(false);
                return;
            }

            deviceRef.current = device;
            const service = await server.getPrimaryService(SERVICE_UUID);
            const controlChar = await service.getCharacteristic(CONTROL_CHAR_UUID);
            const dataChar = await service.getCharacteristic(DATA_CHAR_UUID);
            const encoder = new TextEncoder();
            await controlChar.writeValue(encoder.encode("START"));
            await dataChar.startNotifications();
            dataChar.addEventListener("characteristicvaluechanged", handler);

            setConnected(true);
            toast.success(`Device ${slot} connected: ${device.name || 'NPG'}`);

            // Watchdog — disconnect if no samples received for 1s
            if (intervalRef.current) clearInterval(intervalRef.current);
            intervalRef.current = setInterval(() => {
                if (samplesReceived.current === 0) {
                    disconnectDevice(slot);
                    toast.error(`Device ${slot} stopped sending data — disconnected`);
                }
                samplesReceived.current = 0;
            }, 1000);
        } catch (error) {
            console.log("Error: " + (error instanceof Error ? error.message : error));
            setLoading(false);
        }
    }

    async function disconnectDevice(slot: 1 | 2): Promise<void> {
        const deviceRef = slot === 1 ? d1DeviceRef : d2DeviceRef;
        const setConnected = slot === 1 ? setIsD1Connected : setIsD2Connected;
        const setLoading = slot === 1 ? setIsD1Loading : setIsD2Loading;
        const intervalRef = slot === 1 ? d1IntervalRef : d2IntervalRef;
        const handler = slot === 1 ? handleDevice1Notification : handleDevice2Notification;

        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }

        try {
            if (!deviceRef.current) {
                setConnected(false);
                setLoading(false);
                return;
            }

            const server = deviceRef.current.gatt;
            if (!server || !server.connected) {
                deviceRef.current = null;
                setConnected(false);
                setLoading(false);
                return;
            }

            const service = await server.getPrimaryService(SERVICE_UUID);
            const dataChar = await service.getCharacteristic(DATA_CHAR_UUID);
            await dataChar.stopNotifications();
            dataChar.removeEventListener("characteristicvaluechanged", handler);
            server.disconnect();
        } catch (error) {
            console.log(`Disconnect error for device ${slot}: ` + (error instanceof Error ? error.message : error));
        }

        deviceRef.current = null;
        setConnected(false);
        setLoading(false);
        toast.info(`Device ${slot} disconnected`);
    }

    // ─── TouchDesigner connection ───────────────────────────────────
    const connectTouchDesigner = async () => {
        try {
            await streamerRef.current?.connect('touchdesigner', 'ws://localhost:9000');
            setIsTDConnected(true);
            toast.success('Connected to TouchDesigner');
        } catch (e) {
            toast.error('Connection failed — is TouchDesigner running on port 9000?');
        }
    };

    const disconnectTouchDesigner = () => {
        streamerRef.current?.disconnect('touchdesigner');
        setIsTDConnected(false);
        toast.info('Disconnected from TouchDesigner');
    };

    // ─── Worker (recording) ─────────────────────────────────────────
    const workerRef = useRef<Worker | null>(null);
    const currentFileNameRef = useRef<string>("");

    const initializeWorker = () => {
        if (!workerRef.current && typeof window !== "undefined") {
            workerRef.current = new Worker(new URL('../../../workers/indexedDBWorker.ts', import.meta.url), {
                type: 'module',
            });
        }
    };

    const setSelectedChannelsInWorker = (sc: number[]) => {
        if (!workerRef.current) initializeWorker();
        workerRef.current?.postMessage({ action: 'setSelectedChannels', selectedChannels: sc });
    };

    useEffect(() => { setSelectedChannelsInWorker(selectedChannels); }, [selectedChannels]);

    const processBuffer = async (bufferIndex: number, canvasCount: number, selectChannel: number[], deviceSlot: 1 | 2) => {
        if (!workerRef.current) initializeWorker();
        const recBuffers = deviceSlot === 1 ? d1RecordingBuffers : d2RecordingBuffers;
        if (recBuffers.current[bufferIndex].length === 0) return;
        const data = recBuffers.current[bufferIndex];
        const filename = currentFileNameRef.current;
        if (filename) {
            workerRef.current?.postMessage({ action: 'checkExistence', filename, canvasCount, selectChannel });
            writeToIndexedDB(data, filename, canvasCount, selectChannel);
        }
    };

    const writeToIndexedDB = (data: number[][], filename: string, canvasCount: number, selectChannel: number[]) => {
        workerRef.current?.postMessage({ action: 'write', data, filename, canvasCount, selectChannel });
    };

    const saveAllDataAsZip = async () => {
        try {
            if (workerRef.current) {
                workerRef.current.postMessage({
                    action: 'saveAsZip',
                    canvasElementCount: canvasElementCountRef.current,
                    selectedChannels
                });
                workerRef.current.onmessage = async (event) => {
                    const { zipBlob, error } = event.data;
                    if (zipBlob) saveAs(zipBlob, 'ChordsWeb.zip');
                    else if (error) console.error(error);
                };
            }
        } catch (error) {
            console.error('Error while saving ZIP file:', error);
        }
    };

    const saveDataByFilename = async (filename: string, canvasCount: number, selectChannel: number[]) => {
        if (workerRef.current) {
            workerRef.current.postMessage({ action: "saveDataByFilename", filename, canvasCount, selectChannel });
            workerRef.current.onmessage = (event) => {
                const { blob, error } = event.data;
                if (blob) {
                    saveAs(blob, filename);
                    toast.success("File downloaded successfully.");
                } else if (error) {
                    console.error("Worker error:", error);
                    toast.error(`Error during file download`);
                }
            };
        }
    };

    const deleteFileByFilename = async (filename: string) => {
        if (!workerRef.current) initializeWorker();
        return new Promise<void>((resolve, reject) => {
            workerRef.current?.postMessage({ action: 'deleteFile', filename });
            workerRef.current!.onmessage = (event) => {
                const { success, action, error } = event.data;
                if (action === 'deleteFile') {
                    if (success) {
                        toast.success(`File '${filename}' deleted successfully.`);
                        setDatasets((prev) => prev.filter((file) => file !== filename));
                        resolve();
                    } else {
                        reject(new Error(error));
                    }
                }
            };
        });
    };

    const deleteAllDataFromIndexedDB = async () => {
        if (!workerRef.current) initializeWorker();
        return new Promise<void>((resolve, reject) => {
            workerRef.current?.postMessage({ action: 'deleteAll' });
            workerRef.current!.onmessage = (event) => {
                const { success, action, error } = event.data;
                if (action === 'deleteAll') {
                    if (success) {
                        toast.success(`All files deleted successfully.`);
                        setDatasets([]);
                        resolve();
                    } else {
                        reject(new Error(error));
                    }
                }
            };
        });
    };

    // ─── Recording ──────────────────────────────────────────────────
    const handleTimeSelection = (minutes: number | null) => {
        if (minutes === null) {
            endTimeRef.current = null;
            toast.success("Recording set to no time limit");
        } else {
            const newEndTimeSeconds = minutes * 60 * 1000;
            if (newEndTimeSeconds <= recordingElapsedTime) {
                toast.error("End time must be greater than the current elapsed time");
            } else {
                endTimeRef.current = newEndTimeSeconds;
                toast.success(`Recording end time set to ${minutes} minutes`);
            }
        }
    };

    const handleRecord = async () => {
        if (isRecordingRef.current) {
            stopRecording();
        } else {
            isRecordingRef.current = true;
            const now = new Date();
            recordingStartTimeRef.current = Date.now();
            setRecordingElapsedTime(Date.now());
            setIsrecord(false);
            const filename = `ChordsWeb-DualStream-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-` +
                `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.csv`;
            currentFileNameRef.current = filename;
        }
    };

    const stopRecording = async () => {
        if (!recordingStartTimeRef.current) {
            toast.error("Recording start time was not captured.");
            return;
        }
        isRecordingRef.current = false;
        setRecordingElapsedTime(0);
        setIsrecord(true);
        recordingStartTimeRef.current = 0;
        existingRecordRef.current = undefined;
        const fetchData = async () => {
            const data = await getFileCountFromIndexedDB();
            setDatasets(data);
        };
        fetchData();
    };

    const getFileCountFromIndexedDB = async (): Promise<any[]> => {
        if (!workerRef.current) initializeWorker();
        return new Promise((resolve, reject) => {
            if (workerRef.current) {
                workerRef.current.postMessage({ action: 'getFileCountFromIndexedDB' });
                workerRef.current.onmessage = (event) => {
                    if (event.data.allData) resolve(event.data.allData);
                    else if (event.data.error) reject(event.data.error);
                };
            } else {
                reject('Worker is not initialized');
            }
        });
    };

    const handlecustomTimeInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setCustomTimeInput(e.target.value.replace(/\D/g, ""));
    };

    const handlecustomTimeInputSet = () => {
        const time = parseInt(customTimeInput, 10);
        if (time > 0) handleTimeSelection(time);
        else toast.error("Please enter a valid time in minutes");
        setCustomTimeInput("");
    };

    const formatTime = (milliseconds: number): string => {
        const date = new Date(milliseconds);
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        const seconds = String(date.getUTCSeconds()).padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    };

    // ─── Channel selection ──────────────────────────────────────────
    const handleSelectAllToggle = () => {
        const enabledChannels = Array.from({ length: maxCanvasElementCountRef.current }, (_, i) => i + 1);
        if (!isAllEnabledChannelSelected) {
            setManuallySelected(false);
            setSelectedChannels(enabledChannels);
        } else {
            setSelectedChannels([1]);
        }
        setIsAllEnabledChannelSelected((prev) => !prev);
    };

    const toggleChannel = (channelIndex: number) => {
        setSelectedChannels((prevSelected) => {
            const updatedChannels = prevSelected.includes(channelIndex)
                ? prevSelected.filter((ch) => ch !== channelIndex)
                : [...prevSelected, channelIndex];
            const sortedChannels = updatedChannels.sort((a, b) => a - b);
            if (sortedChannels.length === 0) sortedChannels.push(1);
            return sortedChannels;
        });
        setManuallySelected(true);
    };

    // ─── Effects ────────────────────────────────────────────────────
    useEffect(() => {
        createDeviceCanvases(1);
    }, [theme, timeBase, selectedChannels, Zoom, isD1Connected]);

    useEffect(() => {
        createDeviceCanvases(2);
    }, [theme, timeBase, selectedChannels, Zoom, isD2Connected]);

    useEffect(() => {
        const enabledChannels = Array.from({ length: maxCanvasElementCountRef.current }, (_, i) => i + 1);
        const allSelected = selectedChannels.length === enabledChannels.length;
        const onlyOneLeft = selectedChannels.length === enabledChannels.length - 1;
        setIsSelectAllDisabled((allSelected && manuallySelected) || onlyOneLeft);
        setIsAllEnabledChannelSelected(allSelected);
    }, [selectedChannels, maxCanvasElementCountRef.current, manuallySelected]);

    // Animation loop — renders BOTH devices
    const animate = useCallback(() => {
        if (pauseRef.current) {
            d1WglPlots.forEach((wglp) => wglp.update());
            d2WglPlots.forEach((wglp) => wglp.update());
            requestAnimationFrame(animate);
        }
    }, [d1WglPlots, d2WglPlots]);

    useEffect(() => {
        requestAnimationFrame(animate);
    }, [animate, Zoom]);

    // Resize handler
    useEffect(() => {
        const handleResize = () => {
            createDeviceCanvases(1);
            createDeviceCanvases(2);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, [theme, timeBase, selectedChannels, Zoom, isD1Connected, isD2Connected]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (d1IntervalRef.current) clearInterval(d1IntervalRef.current);
            if (d2IntervalRef.current) clearInterval(d2IntervalRef.current);
        };
    }, []);

    const isAnyConnected = isD1Connected || isD2Connected;

    // ─── Render ─────────────────────────────────────────────────────
    return (
        <div className="flex flex-col h-screen m-0 p-0 bg-g">
            <div className="bg-highlight">
                <Navbar isDisplay={true} />
            </div>

            {/* Split View Container */}
            <div className="flex-1 flex flex-row gap-2 p-2 min-h-0">
                {/* Device 1 Panel */}
                <div className="flex-1 flex flex-col bg-highlight rounded-2xl overflow-hidden">
                    <div className="p-2 border-b flex items-center justify-between">
                        <span className="font-medium text-sm">Device 1</span>
                        <div className="flex items-center gap-2">
                            {isD1Connected ? (
                                <>
                                    <span className="text-green-500 text-xs">● Connected</span>
                                    <Button size="sm" className="rounded-xl text-xs" onClick={() => disconnectDevice(1)}>
                                        Disconnect <CircleX size={14} />
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    size="sm"
                                    className="rounded-xl text-xs"
                                    onClick={() => connectDevice(1)}
                                    disabled={isD1Loading}
                                >
                                    {isD1Loading ? (
                                        <><Loader size={14} className="animate-spin" /> Connecting...</>
                                    ) : (
                                        "Connect Device 1"
                                    )}
                                </Button>
                            )}
                        </div>
                    </div>
                    {showLiveData && isD1Connected && (
                        <div className="px-2 py-1 border-b text-xs font-mono bg-black/5 dark:bg-white/5 space-y-0.5">
                            <div className="flex gap-3">
                                <span className="text-gray-500">#{d1Live.counter}</span>
                                {selectedChannels.map((ch) => {
                                    const i = ch - 1;
                                    return (
                                        <span key={i}>
                                            <span className="text-gray-400">CH{ch}</span>{' '}
                                            <span className="font-semibold">{d1Live.filtered[i]?.toFixed(3) ?? '—'}</span>{' '}
                                            <span className="text-gray-500">({d1Live.raw[i] ?? '—'})</span>
                                        </span>
                                    );
                                })}
                            </div>
                            {selectedChannels.some(ch => d1EnabledBandsRef.current[ch - 1]?.size > 0) && (
                                <div className="flex gap-3">
                                    <span className="text-gray-500 w-6" />
                                    {selectedChannels.map((ch) => {
                                        const i = ch - 1;
                                        const enabled = d1EnabledBandsRef.current[i];
                                        if (!enabled || enabled.size === 0) return <span key={i} />;
                                        return (
                                            <span key={i} className="flex gap-1.5">
                                                <span className="text-gray-400">CH{ch}</span>
                                                {enabled.has('alpha') && (
                                                    <span><span style={{ color: BAND_COLORS.alpha }}>α</span> {(d1Live.bands.alpha?.[i] ?? 0).toFixed(3)}</span>
                                                )}
                                                {enabled.has('theta') && (
                                                    <span><span style={{ color: BAND_COLORS.theta }}>θ</span> {(d1Live.bands.theta?.[i] ?? 0).toFixed(3)}</span>
                                                )}
                                                {enabled.has('delta') && (
                                                    <span><span style={{ color: BAND_COLORS.delta }}>δ</span> {(d1Live.bands.delta?.[i] ?? 0).toFixed(3)}</span>
                                                )}
                                            </span>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                    <div ref={d1ContainerRef} className="flex-1 relative" />
                </div>

                {/* Device 2 Panel */}
                <div className="flex-1 flex flex-col bg-highlight rounded-2xl overflow-hidden">
                    <div className="p-2 border-b flex items-center justify-between">
                        <span className="font-medium text-sm">Device 2</span>
                        <div className="flex items-center gap-2">
                            {isD2Connected ? (
                                <>
                                    <span className="text-green-500 text-xs">● Connected</span>
                                    <Button size="sm" className="rounded-xl text-xs" onClick={() => disconnectDevice(2)}>
                                        Disconnect <CircleX size={14} />
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    size="sm"
                                    className="rounded-xl text-xs"
                                    onClick={() => connectDevice(2)}
                                    disabled={isD2Loading}
                                >
                                    {isD2Loading ? (
                                        <><Loader size={14} className="animate-spin" /> Connecting...</>
                                    ) : (
                                        "Connect Device 2"
                                    )}
                                </Button>
                            )}
                        </div>
                    </div>
                    {showLiveData && isD2Connected && (
                        <div className="px-2 py-1 border-b text-xs font-mono bg-black/5 dark:bg-white/5 space-y-0.5">
                            <div className="flex gap-3">
                                <span className="text-gray-500">#{d2Live.counter}</span>
                                {selectedChannels.map((ch) => {
                                    const i = ch - 1;
                                    return (
                                        <span key={i}>
                                            <span className="text-gray-400">CH{ch}</span>{' '}
                                            <span className="font-semibold">{d2Live.filtered[i]?.toFixed(3) ?? '—'}</span>{' '}
                                            <span className="text-gray-500">({d2Live.raw[i] ?? '—'})</span>
                                        </span>
                                    );
                                })}
                            </div>
                            {selectedChannels.some(ch => d2EnabledBandsRef.current[ch - 1]?.size > 0) && (
                                <div className="flex gap-3">
                                    <span className="text-gray-500 w-6" />
                                    {selectedChannels.map((ch) => {
                                        const i = ch - 1;
                                        const enabled = d2EnabledBandsRef.current[i];
                                        if (!enabled || enabled.size === 0) return <span key={i} />;
                                        return (
                                            <span key={i} className="flex gap-1.5">
                                                <span className="text-gray-400">CH{ch}</span>
                                                {enabled.has('alpha') && (
                                                    <span><span style={{ color: BAND_COLORS.alpha }}>α</span> {(d2Live.bands.alpha?.[i] ?? 0).toFixed(3)}</span>
                                                )}
                                                {enabled.has('theta') && (
                                                    <span><span style={{ color: BAND_COLORS.theta }}>θ</span> {(d2Live.bands.theta?.[i] ?? 0).toFixed(3)}</span>
                                                )}
                                                {enabled.has('delta') && (
                                                    <span><span style={{ color: BAND_COLORS.delta }}>δ</span> {(d2Live.bands.delta?.[i] ?? 0).toFixed(3)}</span>
                                                )}
                                            </span>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                    <div ref={d2ContainerRef} className="flex-1 relative" />
                </div>
            </div>

            {/* Shared Controls Bar */}
            <div className="flex-none items-center justify-center pb-4 bg-g z-10">
                {/* Recording timer (left) */}
                <div className="absolute left-4 flex items-center mx-0 px-0 space-x-1">
                    {isRecordingRef.current && (
                        <div className="flex items-center space-x-1 w-min">
                            <button className="flex items-center justify-center px-1 py-2 select-none min-w-20 bg-primary text-destructive whitespace-nowrap rounded-xl">
                                {formatTime(recordingElapsedTime)}
                            </button>
                            <Separator orientation="vertical" className="bg-primary h-9" />
                            <div>
                                <Popover open={isEndTimePopoverOpen} onOpenChange={setIsEndTimePopoverOpen}>
                                    <PopoverTrigger asChild>
                                        <Button className="flex items-center justify-center px-1 py-2 select-none min-w-10 text-destructive whitespace-nowrap rounded-xl" variant="destructive">
                                            {endTimeRef.current === null ? (
                                                <Infinity className="h-5 w-5 text-primary" />
                                            ) : (
                                                <div className="text-sm text-primary font-medium">{formatTime(endTimeRef.current)}</div>
                                            )}
                                        </Button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-64 p-4 mx-4">
                                        <div className="flex flex-col space-y-4">
                                            <div className="text-sm font-medium">Set End Time (minutes)</div>
                                            <div className="grid grid-cols-4 gap-2">
                                                {[1, 10, 20, 30].map((time) => (
                                                    <Button key={time} variant="outline" size="sm" onClick={() => handleTimeSelection(time)}>{time}</Button>
                                                ))}
                                            </div>
                                            <div className="flex space-x-2 items-center">
                                                <Input type="text" inputMode="numeric" pattern="[0-9]*" placeholder="Custom" value={customTimeInput}
                                                    onBlur={handlecustomTimeInputSet} onKeyDown={(e) => e.key === "Enter" && handlecustomTimeInputSet()}
                                                    onChange={handlecustomTimeInputChange} className="w-20" />
                                                <Button variant="outline" size="sm" onClick={() => handleTimeSelection(null)}>
                                                    <Infinity className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        </div>
                                    </PopoverContent>
                                </Popover>
                            </div>
                        </div>
                    )}
                </div>

                {/* Center controls */}
                <div className="flex gap-3 items-center justify-center">
                    {/* Pause */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button className="rounded-xl" onClick={togglePause} disabled={!isAnyConnected || !isRecord}>
                                    {isDisplay ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent><p>{isDisplay ? "Pause Data Display" : "Resume Data Display"}</p></TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {/* Record */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button className="rounded-xl" onClick={handleRecord} disabled={!isAnyConnected || !isDisplay}>
                                    {isRecordingRef.current ? <CircleStop /> : <Circle fill="red" />}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent><p>{!isRecordingRef.current ? "Start Recording" : "Stop Recording"}</p></TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {/* Files */}
                    <TooltipProvider>
                        <div className="flex">
                            <Popover>
                                <PopoverTrigger asChild>
                                    <Button className="rounded-xl p-4" disabled={!isAnyConnected}>
                                        <FileArchive size={16} />
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="p-4 text-base shadow-lg rounded-xl w-full">
                                    <div className="space-y-4">
                                        {datasets.length > 0 ? (
                                            datasets.map((dataset) => (
                                                <div key={dataset} className="flex justify-between items-center">
                                                    <span className="mr-4">{dataset}</span>
                                                    <div className="flex space-x-2">
                                                        <Button onClick={() => saveDataByFilename(dataset, canvasElementCountRef.current, selectedChannels)} className="rounded-xl px-4">
                                                            <Download size={16} />
                                                        </Button>
                                                        <Button onClick={() => deleteFileByFilename(dataset)} className="rounded-xl px-4">
                                                            <Trash2 size={16} />
                                                        </Button>
                                                    </div>
                                                </div>
                                            ))
                                        ) : (
                                            <p className="text-base">No datasets available</p>
                                        )}
                                        {datasets.length > 0 && (
                                            <div className="flex justify-between mt-4">
                                                <Button onClick={saveAllDataAsZip} className="rounded-xl p-2 w-full mr-2">Download All as Zip</Button>
                                                <Button onClick={deleteAllDataFromIndexedDB} className="rounded-xl p-2 w-full">Delete All</Button>
                                            </div>
                                        )}
                                    </div>
                                </PopoverContent>
                            </Popover>
                        </div>
                    </TooltipProvider>

                    {/* Filter */}
                    <Popover open={isFilterPopoverOpen} onOpenChange={setIsFilterPopoverOpen}>
                        <PopoverTrigger asChild>
                            <Button className="flex items-center justify-center px-3 py-2 select-none min-w-12 whitespace-nowrap rounded-xl" disabled={!isDisplay}>
                                Filter
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-50 p-4 mx-4 mb-2">
                            <div className="flex flex-col max-h-80 overflow-y-auto">
                                <div className="flex items-center pb-2">
                                    <div className="text-sm font-semibold w-12"><ReplaceAll size={20} /></div>
                                    <div className="flex space-x-2">
                                        <div className="flex items-center border border-input rounded-xl mx-0 px-0">
                                            <Button variant="outline" size="sm"
                                                onClick={() => removeEXGFilterFromAllChannels(Array.from({ length: maxCanvasElementCountRef.current }, (_, i) => i))}
                                                className={`rounded-xl rounded-r-none border-0 ${Object.keys(d1AppliedEXGFiltersRef.current).length === 0 ? "bg-red-700 hover:bg-white-500 hover:text-white text-white" : "bg-white-500"}`}>
                                                <CircleOff size={17} />
                                            </Button>
                                            <Button variant="outline" size="sm"
                                                onClick={() => applyEXGFilterToAllChannels(Array.from({ length: maxCanvasElementCountRef.current }, (_, i) => i), 4)}
                                                className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0 ${Object.keys(d1AppliedEXGFiltersRef.current).length === maxCanvasElementCountRef.current && Object.values(d1AppliedEXGFiltersRef.current).every((v) => v === 4) ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" : "bg-white-500"}`}>
                                                <BicepsFlexed size={17} />
                                            </Button>
                                            <Button variant="outline" size="sm"
                                                onClick={() => applyEXGFilterToAllChannels(Array.from({ length: maxCanvasElementCountRef.current }, (_, i) => i), 3)}
                                                className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0 ${Object.keys(d1AppliedEXGFiltersRef.current).length === maxCanvasElementCountRef.current && Object.values(d1AppliedEXGFiltersRef.current).every((v) => v === 3) ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" : "bg-white-500"}`}>
                                                <Brain size={17} />
                                            </Button>
                                            <Button variant="outline" size="sm"
                                                onClick={() => applyEXGFilterToAllChannels(Array.from({ length: maxCanvasElementCountRef.current }, (_, i) => i), 1)}
                                                className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0 ${Object.keys(d1AppliedEXGFiltersRef.current).length === maxCanvasElementCountRef.current && Object.values(d1AppliedEXGFiltersRef.current).every((v) => v === 1) ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" : "bg-white-500"}`}>
                                                <Heart size={17} />
                                            </Button>
                                            <Button variant="outline" size="sm"
                                                onClick={() => applyEXGFilterToAllChannels(Array.from({ length: maxCanvasElementCountRef.current }, (_, i) => i), 2)}
                                                className={`rounded-xl rounded-l-none border-0 ${Object.keys(d1AppliedEXGFiltersRef.current).length === maxCanvasElementCountRef.current && Object.values(d1AppliedEXGFiltersRef.current).every((v) => v === 2) ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" : "bg-white-500"}`}>
                                                <Eye size={17} />
                                            </Button>
                                        </div>
                                        <div className="flex border border-input rounded-xl items-center mx-0 px-0">
                                            <Button variant="outline" size="sm"
                                                onClick={() => removeNotchFromAllChannels(Array.from({ length: maxCanvasElementCountRef.current }, (_, i) => i))}
                                                className={`rounded-xl rounded-r-none border-0 ${Object.keys(d1AppliedFiltersRef.current).length === 0 ? "bg-red-700 hover:bg-white-500 hover:text-white text-white" : "bg-white-500"}`}>
                                                <CircleOff size={17} />
                                            </Button>
                                            <Button variant="outline" size="sm"
                                                onClick={() => applyFilterToAllChannels(Array.from({ length: maxCanvasElementCountRef.current }, (_, i) => i), 1)}
                                                className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0 ${Object.keys(d1AppliedFiltersRef.current).length === maxCanvasElementCountRef.current && Object.values(d1AppliedFiltersRef.current).every((v) => v === 1) ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" : "bg-white-500"}`}>
                                                50Hz
                                            </Button>
                                            <Button variant="outline" size="sm"
                                                onClick={() => applyFilterToAllChannels(Array.from({ length: maxCanvasElementCountRef.current }, (_, i) => i), 2)}
                                                className={`rounded-xl rounded-l-none border-0 ${Object.keys(d1AppliedFiltersRef.current).length === maxCanvasElementCountRef.current && Object.values(d1AppliedFiltersRef.current).every((v) => v === 2) ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" : "bg-white-500"}`}>
                                                60Hz
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex flex-col space-y-2">
                                    {channelNames.map((filterName, index) => (
                                        <div key={filterName} className="flex items-center">
                                            <div className="text-sm font-semibold w-12">{filterName}</div>
                                            <div className="flex space-x-2">
                                                <div className="flex border border-input rounded-xl items-center mx-0 px-0">
                                                    <Button variant="outline" size="sm" onClick={() => removeEXGFilter(index)}
                                                        className={`rounded-xl rounded-r-none border-l-none border-0 ${d1AppliedEXGFiltersRef.current[index] === undefined ? "bg-red-700 hover:bg-white-500 hover:text-white text-white" : "bg-white-500"}`}>
                                                        <CircleOff size={17} />
                                                    </Button>
                                                    <Button variant="outline" size="sm" onClick={() => handleFrequencySelectionEXG(index, 4)}
                                                        className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0 ${d1AppliedEXGFiltersRef.current[index] === 4 ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" : "bg-white-500"}`}>
                                                        <BicepsFlexed size={17} />
                                                    </Button>
                                                    <Button variant="outline" size="sm" onClick={() => handleFrequencySelectionEXG(index, 3)}
                                                        className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0 ${d1AppliedEXGFiltersRef.current[index] === 3 ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" : "bg-white-500"}`}>
                                                        <Brain size={17} />
                                                    </Button>
                                                    <Button variant="outline" size="sm" onClick={() => handleFrequencySelectionEXG(index, 1)}
                                                        className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0 ${d1AppliedEXGFiltersRef.current[index] === 1 ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" : "bg-white-500"}`}>
                                                        <Heart size={17} />
                                                    </Button>
                                                    <Button variant="outline" size="sm" onClick={() => handleFrequencySelectionEXG(index, 2)}
                                                        className={`rounded-xl rounded-l-none border-0 ${d1AppliedEXGFiltersRef.current[index] === 2 ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" : "bg-white-500"}`}>
                                                        <Eye size={17} />
                                                    </Button>
                                                </div>
                                                <div className="flex border border-input rounded-xl items-center mx-0 px-0">
                                                    <Button variant="outline" size="sm" onClick={() => removeNotchFilter(index)}
                                                        className={`rounded-xl rounded-r-none border-0 ${d1AppliedFiltersRef.current[index] === undefined ? "bg-red-700 hover:bg-white-500 hover:text-white text-white" : "bg-white-500"}`}>
                                                        <CircleOff size={17} />
                                                    </Button>
                                                    <Button variant="outline" size="sm" onClick={() => handleFrequencySelection(index, 1)}
                                                        className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0 ${d1AppliedFiltersRef.current[index] === 1 ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" : "bg-white-500"}`}>
                                                        50Hz
                                                    </Button>
                                                    <Button variant="outline" size="sm" onClick={() => handleFrequencySelection(index, 2)}
                                                        className={`rounded-xl rounded-l-none border-0 ${d1AppliedFiltersRef.current[index] === 2 ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" : "bg-white-500"}`}>
                                                        60Hz
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </PopoverContent>
                    </Popover>

                    {/* Brainwave Bands — only when EEG mode is active */}
                    {Object.values(d1AppliedEXGFiltersRef.current).some(v => v === 3) && (
                        <Popover open={isBandPopoverOpen} onOpenChange={setIsBandPopoverOpen}>
                            <PopoverTrigger asChild>
                                <Button className="rounded-xl flex items-center gap-1" disabled={!isDisplay}>
                                    <Activity size={16} /> Bands
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-72 p-4 mx-4 mb-2">
                                <div className="flex flex-col max-h-80 overflow-y-auto">
                                    {/* All channels row */}
                                    <div className="flex items-center pb-2">
                                        <div className="text-sm font-semibold w-12"><ReplaceAll size={20} /></div>
                                        <div className="flex space-x-1">
                                            {(['alpha', 'theta', 'delta'] as BandType[]).map(band => (
                                                <Button key={band} variant="outline" size="sm"
                                                    onClick={() => toggleBandAllChannels(band)}
                                                    style={allHaveBand(band) ? { backgroundColor: BAND_COLORS[band], color: '#000' } : {}}
                                                    className="rounded-xl text-xs">
                                                    {band.charAt(0).toUpperCase() + band.slice(1)}
                                                </Button>
                                            ))}
                                        </div>
                                    </div>
                                    {/* Per-channel rows */}
                                    {channelNames.map((name, index) => (
                                        <div key={name} className="flex flex-col space-y-1 py-1">
                                            <div className="flex items-center">
                                                <div className="text-sm font-semibold w-12">{name}</div>
                                                <div className="flex space-x-1">
                                                    {(['alpha', 'theta', 'delta'] as BandType[]).map(band => (
                                                        <Button key={band} variant="outline" size="sm"
                                                            onClick={() => toggleBand(index, band)}
                                                            style={d1EnabledBandsRef.current[index]?.has(band) ? { backgroundColor: BAND_COLORS[band], color: '#000' } : {}}
                                                            className="rounded-xl text-xs">
                                                            {band.charAt(0).toUpperCase() + band.slice(1)}
                                                        </Button>
                                                    ))}
                                                </div>
                                            </div>
                                            {/* Per-channel gain slider */}
                                            <div className="flex items-center pl-12">
                                                <span className="text-xs text-gray-500 w-10">Gain:</span>
                                                <input type="range" min="1" max="10" step="0.5"
                                                    value={d1BandGainRef.current[index] ?? 3}
                                                    onChange={(e) => setBandGain(index, Number(e.target.value))}
                                                    className="flex-1 h-[0.15rem]" />
                                                <span className="text-xs ml-1 w-8">{(d1BandGainRef.current[index] ?? 3).toFixed(1)}x</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </PopoverContent>
                        </Popover>
                    )}

                    {/* Settings */}
                    <Popover>
                        <PopoverTrigger asChild>
                            <Button className="flex items-center justify-center select-none whitespace-nowrap rounded-lg">
                                <Settings size={16} />
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[30rem] p-4 rounded-md shadow-md text-sm">
                            <TooltipProvider>
                                <div className={`space-y-6 ${!isDisplay ? "flex justify-center" : ""}`}>
                                    {(isDisplay && isRecord) && (
                                        <div className="flex items-center justify-center rounded-lg mb-[2.5rem]">
                                            <div className="w-full">
                                                <div className="absolute inset-0 rounded-lg border-gray-300 dark:border-gray-600 opacity-50 pointer-events-none"></div>
                                                <div className="relative">
                                                    <div className="flex items-center justify-between mb-4">
                                                        <h3 className="text-xs font-semibold text-gray-500">
                                                            <span className="font-bold text-gray-600">Channels Count:</span> {selectedChannels.length}
                                                        </h3>
                                                        {!(selectedChannels.length === maxCanvasElementCountRef.current && manuallySelected) && (
                                                            <button onClick={handleSelectAllToggle}
                                                                className={`px-4 py-1 text-xs font-light rounded-lg transition ${isSelectAllDisabled
                                                                    ? "text-gray-400 bg-gray-200 dark:bg-gray-700 dark:text-gray-500 cursor-not-allowed"
                                                                    : "text-white bg-black hover:bg-gray-700 dark:bg-white dark:text-black dark:border dark:border-gray-500 dark:hover:bg-primary/70"
                                                                    }`}
                                                                disabled={isSelectAllDisabled}>
                                                                {isAllEnabledChannelSelected ? "RESET" : "Select All"}
                                                            </button>
                                                        )}
                                                    </div>
                                                    <div id="button-container" className="relative space-y-2 rounded-lg">
                                                        {Array.from({ length: 1 }).map((_, container) => (
                                                            <div key={container} className="grid grid-cols-8 gap-2">
                                                                {Array.from({ length: 3 }).map((_, col) => {
                                                                    const index = container * 8 + col;
                                                                    const isChannelDisabled = index >= maxCanvasElementCountRef.current;
                                                                    const isSelected = selectedChannels.includes(index + 1);
                                                                    const buttonStyle = isChannelDisabled
                                                                        ? isDarkModeEnabled
                                                                            ? { backgroundColor: "#030c21", color: "gray" }
                                                                            : { backgroundColor: "#e2e8f0", color: "gray" }
                                                                        : isSelected
                                                                            ? { backgroundColor: getCustomColor(index, activeTheme), color: "white" }
                                                                            : { backgroundColor: "white", color: "black" };
                                                                    return (
                                                                        <button key={index} onClick={() => !isChannelDisabled && toggleChannel(index + 1)}
                                                                            disabled={isChannelDisabled} style={buttonStyle}
                                                                            className="w-full h-8 text-xs font-medium py-1 border border-gray-300 dark:border-gray-600 transition-colors duration-200 rounded-lg">
                                                                            {`CH${index + 1}`}
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                    {/* Zoom */}
                                    <div className={`relative w-full flex flex-col ${!isDisplay ? "" : "items-start"} text-sm`}>
                                        <p className="absolute top-[-1.2rem] left-0 text-xs font-semibold text-gray-500">
                                            <span className="font-bold text-gray-600">Zoom Level:</span> {Zoom}x
                                        </p>
                                        <div className="relative w-[28rem] flex items-center rounded-lg py-2 border border-gray-300 dark:border-gray-600 mb-4">
                                            <button className="text-gray-700 dark:text-gray-400 mx-1 px-2 py-1 border rounded hover:bg-gray-200 dark:hover:bg-gray-700" onClick={() => SetZoom(1)}>1</button>
                                            <input type="range" min="1" max="10" value={Zoom} onChange={(e) => SetZoom(Number(e.target.value))}
                                                style={{ background: `linear-gradient(to right, rgb(101, 136, 205) ${((Zoom - 1) / 9) * 100}%, rgb(165, 165, 165) ${((Zoom - 1) / 9) * 11}%)` }}
                                                className="flex-1 h-[0.15rem] rounded-full appearance-none bg-gray-800 focus:outline-none focus:ring-0 slider-input" />
                                            <button className="text-gray-700 dark:text-gray-400 mx-2 px-2 py-1 border rounded hover:bg-gray-200 dark:hover:bg-gray-700" onClick={() => SetZoom(10)}>10</button>
                                            <style jsx>{` input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 15px; height: 15px;
                                                background-color: rgb(101, 136, 205); border-radius: 50%; cursor: pointer; } `}</style>
                                        </div>
                                    </div>
                                    {/* Time Base */}
                                    {isDisplay && (
                                        <div className="relative w-full flex flex-col items-start mt-3 text-sm">
                                            <p className="absolute top-[-1.2rem] left-0 text-xs font-semibold text-gray-500">
                                                <span className="font-bold text-gray-600">Time Base:</span> {timeBase} Seconds
                                            </p>
                                            <div className="relative w-[28rem] flex items-center rounded-lg py-2 border border-gray-300 dark:border-gray-600">
                                                <button type="button" className="text-gray-700 dark:text-gray-400 mx-1 px-2 py-1 border rounded hover:bg-gray-200 dark:hover:bg-gray-700" onClick={() => setTimeBase(1)}>1</button>
                                                <input type="range" min="1" max="10" value={timeBase} onChange={(e) => setTimeBase(Number(e.target.value))}
                                                    style={{ background: `linear-gradient(to right, rgb(101, 136, 205) ${((timeBase - 1) / 9) * 100}%, rgb(165, 165, 165) ${((timeBase - 1) / 9) * 11}%)` }}
                                                    className="flex-1 h-[0.15rem] rounded-full appearance-none bg-gray-200 focus:outline-none focus:ring-0 slider-input" />
                                                <button type="button" className="text-gray-700 dark:text-gray-400 mx-2 px-2 py-1 border rounded hover:bg-gray-200 dark:hover:bg-gray-700" onClick={() => setTimeBase(10)}>10</button>
                                                <style jsx>{` input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none;appearance: none; width: 15px; height: 15px;
                                                    background-color: rgb(101, 136, 205); border-radius: 50%; cursor: pointer; }`}</style>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </TooltipProvider>
                        </PopoverContent>
                    </Popover>

                    {/* TouchDesigner Connection */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    className="rounded-xl flex items-center gap-1"
                                    onClick={isTDConnected ? disconnectTouchDesigner : connectTouchDesigner}
                                >
                                    {isTDConnected ? (
                                        <><WifiOff size={16} /> Disconnect TD</>
                                    ) : (
                                        <><Wifi size={16} /> Connect TD</>
                                    )}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{isTDConnected ? "Disconnect from TouchDesigner" : "Connect to TouchDesigner (ws://localhost:9000)"}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {/* TD Status indicator */}
                    <span className={`text-xs ${isTDConnected ? "text-green-500" : "text-gray-400"}`}>
                        {isTDConnected ? "● TD" : "○ TD"}
                    </span>

                    {/* Console Log Toggle */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    className={`rounded-xl ${consoleLogRef.current ? "bg-green-700 hover:bg-green-600 text-white" : ""}`}
                                    onClick={() => { consoleLogRef.current = !consoleLogRef.current; forceUpdate(); }}
                                    disabled={!isAnyConnected}
                                >
                                    <Terminal size={16} />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{consoleLogRef.current ? "Disable Console Log" : "Enable Console Log"}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {/* Live Data Toggle */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    className={`rounded-xl ${showLiveData ? "bg-green-700 hover:bg-green-600 text-white" : ""}`}
                                    onClick={() => setShowLiveData(prev => !prev)}
                                    disabled={!isAnyConnected}
                                >
                                    <Activity size={16} />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{showLiveData ? "Hide Live Data" : "Show Live Data"}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                </div>
            </div>
        </div>
    );
};

export default DualStream;
