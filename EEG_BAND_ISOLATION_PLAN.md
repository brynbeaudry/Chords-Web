# EEG Band Isolation — Implementation Plan & Challenges

## Goal

Add toggleable EEG brainwave band filters (Alpha, Theta, Delta) that render as separate colored lines superimposed on the existing channel waveform, and export as independent values over WebSocket. Must work independently per device in **dual-stream mode only** (for now). Includes a dedicated "Brainwave Bands" filter popup with per-band gain controls and a canvas legend overlay.

---

## Current Architecture (What We Have)

### Signal Chain (per sample, per channel)
```
raw_int16 → HighPassFilter(1Hz) → EXGFilter(mode LP) → Notch(50/60Hz) → canvas sweep
```
- **filters.tsx** — Three IIR Butterworth biquad classes: `HighPassFilter` (1Hz HP), `EXGFilter` (mode-dependent LP at 10/30/45/70Hz), `Notch` (50/60Hz bandstop)
- All filters are **2nd-order biquad** (Notch uses two cascaded = 4th order)
- Coefficients are hardcoded for 250Hz and 500Hz sample rates only

### Visualization
- **webgl-plot** library — `WebglPlot` + `WebglLine` per channel canvas
- Currently **one line per canvas** (the filtered signal)
- Sweep oscilloscope pattern: circular buffer write + NaN gap cursor
- Colors from `Colors.ts` palette, indexed by channel number

### Band Powers (FFT only, no time-domain)
- `FFT.tsx` computes 256-point FFT (no windowing), displays spectrum 0-60Hz
- `BandPowerGraph.tsx` sums squared magnitudes in frequency bins:
  - Delta: 0.5–4 Hz, Theta: 4–8 Hz, Alpha: 8–12 Hz, Beta: 12–30 Hz, Gamma: 30–45 Hz
- **No time-domain bandpass filters exist anywhere in the codebase**

### WebSocket Export (`WebSocketStreamer.ts`)
- Sends `{ ts, d1_ch0, d1_ch1, d1_ch2, d2_ch0, d2_ch1, d2_ch2 }` per sample
- Only the final filtered value per channel — no band decomposition

### Dual-Stream (`dual-stream/page.tsx`)
- Two fully independent BLE device streams with mirrored filter refs
- Shared filter UI writes to both `d1*` and `d2*` refs simultaneously
- One `requestAnimationFrame` loop updates both device canvas sets

---

## What We Need to Build

### 1. Time-Domain Bandpass Filters

**Challenge: No bandpass infrastructure exists.**

The current `EXGFilter` is a lowpass-only biquad. We need new bandpass filters that isolate:

| Band | Frequency Range | Typical Amplitude |
|------|----------------|-------------------|
| Alpha | 8–12 Hz | 20–200 µV |
| Theta | 4–7.5 Hz | 20–100 µV |
| Delta | 0.1–4 Hz | 20–200 µV |

**Approach: Cascaded Biquad Bandpass Filters**

Each band requires a bandpass filter. The cleanest approach is a pair of Butterworth biquads (one highpass + one lowpass) cascaded, matching the existing filter architecture:

```
Alpha: HP(8Hz) → LP(12Hz)    — 2 biquad sections
Theta: HP(4Hz) → LP(7.5Hz)   — 2 biquad sections
Delta: HP(0.1Hz) → LP(4Hz)   — 2 biquad sections
```

**Why cascaded HP+LP instead of a single bandpass biquad?**
- Matches the existing codebase pattern (all filters are Butterworth biquads)
- Easier to design — reuse the same `process()` structure from `HighPassFilter`/`EXGFilter`
- 2nd-order HP + 2nd-order LP = 4th-order bandpass, giving adequate roll-off (~40dB/decade per side)
- Adding higher orders later just means stacking more sections

**Challenge: Coefficient Generation**

Currently all coefficients in `filters.tsx` are hardcoded floats (pre-computed externally). For the new bands we need coefficients for:
- 6 new biquad sections (HP+LP per band) × 2 sample rates (250Hz, 500Hz) = **12 coefficient sets**

Options:
1. **Pre-compute offline** and hardcode — consistent with existing pattern, zero runtime deps
2. **Runtime computation** using the bilinear transform — more flexible, but departs from current pattern

**Recommendation:** Pre-compute and hardcode. The frequency bands are fixed, and this avoids adding complexity. Coefficients can be computed using standard Butterworth formulas (bilinear transform with pre-warping) and validated against known references. No external tooling (Python/scipy) needed in the repo — just document the math used to derive them.

**Challenge: Very Low Frequency Filtering (Delta 0.1Hz)**

At 250Hz sample rate, a 0.1Hz highpass biquad has poles extremely close to z=1, which causes:
- Numerical precision issues with 64-bit floats (manageable but needs care)
- Very long transient settling time (~10+ seconds for Delta band to stabilize)
- The existing 1Hz HighPassFilter already sits in the chain — Delta band needs a 0.1Hz HP, so we'd either bypass the existing 1Hz HP for the Delta path or accept that Delta is actually 1–4Hz (which may be acceptable for EEG use)

**Recommendation:** Start with Delta as 1–4Hz (post existing HP filter) to avoid numerical issues. Document that the 1Hz HP filter truncates sub-1Hz content. This is actually standard practice in most EEG systems.

---

### 2. Filter Chain Architecture

**Challenge: Where do band filters tap into the signal chain?**

Current chain:
```
raw → HP(1Hz) → EXG_LP(45Hz for EEG) → Notch → display
```

The band filters should tap from the **post-Notch** signal (the cleanest version). Each band filter runs in parallel, not in series:

```
raw → HP(1Hz) → EXG_LP(45Hz) → Notch → mainSignal → canvas (existing green line)
                                    ├→ BandpassAlpha(8-12Hz)  → alphaLine
                                    ├→ BandpassTheta(4-7.5Hz) → thetaLine
                                    └→ BandpassDelta(1-4Hz)   → deltaLine
```

**This means per channel, per device, we need up to 3 additional filter instances running in parallel.** For dual-stream with 3 channels each:
- Up to `3 bands × 3 channels × 2 devices = 18` additional bandpass filter pairs

This is computationally fine — each biquad is ~10 FLOPs per sample, so 18 filters × 2 biquads × 10 FLOPs = 360 FLOPs/sample, trivial at 500Hz.

**Implementation:**
- New class `BandpassFilter` in `filters.tsx` with two internal biquad stages (HP + LP)
- Ref arrays in `dual-stream/page.tsx`: `d1AlphaFiltersRef`, `d1ThetaFiltersRef`, `d1DeltaFiltersRef` (and d2 equivalents)
- Filter instances created per channel, reset on connect/disconnect

---

### 3. Multi-Line WebGL Rendering

**Challenge: Currently one `WebglLine` per canvas. We need up to 4 lines overlaid (main + 3 bands).**

`webgl-plot` supports multiple lines on one `WebglPlot` instance — just call `wglp.addLine(line)` multiple times. Each line can have a different `ColorRGBA`.

**Proposed colors:**
| Line | Color | Rationale |
|------|-------|-----------|
| Main signal | Existing channel color | No change |
| Notch 50Hz | Existing (same color, already overlaid) | No change |
| Notch 60Hz | Existing | No change |
| Alpha (8-12Hz) | Cyan `#00FFFF` | Distinct, visible on dark/light |
| Theta (4-7.5Hz) | Orange `#FF8800` | Warm, distinct from alpha |
| Delta (1-4Hz) | Magenta `#FF00FF` | Distinct from both |

**Challenge: Y-Scale / Amplitude Visibility**

Band-isolated signals will be **much smaller** than the broadband signal. Alpha waves are 20-200µV while the raw EEG after 45Hz LP could be 500µV+. The band lines risk being invisible flat lines unless we:

1. **Auto-scale each band line independently** — but then relative amplitude information is lost
2. **Use a fixed gain multiplier** per band (e.g., 3-5x) — keeps proportionality, adjustable
3. **Let the existing zoom slider affect all lines equally** — simplest

**Recommendation:** Apply a **per-channel gain slider** (default 3x, range 1x–10x) in the Brainwave Bands popup. The gain multiplies all band lines on that channel equally. The existing zoom slider still scales everything globally on top of that.

**Implementation:**
- For each canvas/channel, create additional `WebglLine` objects for enabled bands
- Same `numPoints` and X spacing as the main line
- Same sweep position (circular buffer index) so all lines stay synchronized
- On each sample: write main signal to main line, write band-filtered values (× gain) to band lines
- Band lines are only created/added when the corresponding filter is toggled on

---

### 4. UI: Brainwave Bands Popup

**Challenge: Adding band controls to the existing filter popover would make it cluttered. A separate popup is cleaner.**

The existing filter popover handles EXG mode + Notch. Band filters get their own dedicated popup button (only visible when EEG mode is active on at least one channel).

**New "Brainwave Bands" Popover:**
```
┌─ Brainwave Bands ─────────────────────────┐
│                                            │
│  All Channels:                             │
│  [Alpha 🟦] [Theta 🟧] [Delta 🟪]         │
│                                            │
│  Ch 1:                                     │
│  [Alpha 🟦] [Theta 🟧] [Delta 🟪]         │
│  Gain: [────●────────] 3.0x                │
│                                            │
│  Ch 2:                                     │
│  [Alpha 🟦] [Theta 🟧] [Delta 🟪]         │
│  Gain: [────●────────] 3.0x                │
│                                            │
│  Ch 3:                                     │
│  [Alpha 🟦] [Theta 🟧] [Delta 🟪]         │
│  Gain: [────●────────] 3.0x                │
│                                            │
└────────────────────────────────────────────┘
```

**Key design decisions:**
- **Separate popover** — keeps the existing filter UI untouched, reduces clutter
- **Only visible when EEG mode active** — no point showing band filters for ECG/EMG/EOG
- **Multi-select** (not radio) — user can enable Alpha + Theta simultaneously
- **Per-channel** — each channel can have different bands enabled
- **Per-channel gain slider** — range 1x–10x, default 3x, controls amplitude multiplier for all band lines on that channel
- **"All channels" row** — quick toggle for all channels at once
- Color-coded toggle buttons matching the line colors (Cyan/Orange/Magenta)

**State management:**
```ts
// New refs in dual-stream/page.tsx
const d1BandFiltersRef = useRef<{ [channel: number]: Set<'alpha'|'theta'|'delta'> }>({});
const d2BandFiltersRef = useRef<{ [channel: number]: Set<'alpha'|'theta'|'delta'> }>({});
const d1BandGainRef = useRef<{ [channel: number]: number }>({});  // default 3.0
const d2BandGainRef = useRef<{ [channel: number]: number }>({});
```

### 5. Canvas Legend Overlay

**Small color-coded labels on each canvas showing active bands:**

```
┌─────────────────────────────────────────┐
│ ■ Alpha  ■ Theta                  Ch 1  │
│ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ main ~~~~ │
│ ~~~ alpha overlay ~~~~~~~~~~~~~~~~~~~~~ │
│ ~~~ theta overlay ~~~~~~~~~~~~~~~~~~~~~ │
└─────────────────────────────────────────┘
```

- Positioned top-left of each canvas as an absolutely-positioned HTML overlay (not drawn in WebGL)
- Only shows labels for currently active bands on that channel
- Uses the band line colors (Cyan/Orange/Magenta) for the color squares
- Lightweight: just a few `<span>` elements, no performance impact

---

### 5. WebSocket Export of Band Values

**Challenge: Adding band values to the WebSocket message without breaking existing consumers.**

Current filtered message:
```json
{ "ts": 1234, "d1_ch0": 0.5, "d1_ch1": 0.3, "d1_ch2": 0.1, "d2_ch0": ..., "d2_ch1": ..., "d2_ch2": ... }
```

Proposed extended message (when bands are enabled):
```json
{
  "ts": 1234,
  "d1_ch0": 0.5,
  "d1_ch0_alpha": 0.02,
  "d1_ch0_theta": 0.01,
  "d1_ch0_delta": 0.03,
  "d1_ch1": 0.3,
  "d2_ch0": 0.4,
  "d2_ch0_alpha": 0.015,
  ...
}
```

**Design considerations:**
- Band keys are **only included if the corresponding filter is enabled** — no nulls, no zeros for disabled bands
- This is backwards-compatible: existing consumers that only read `d1_ch0` etc. won't break
- `WebSocketStreamer.ts` needs new setters: `setDevice1BandData(channel, band, value)`
- At 500Hz with 3 bands × 3 channels × 2 devices = 18 extra float fields per message — still well within WebSocket throughput limits

---

### 6. Independent Per-Device Band Control

**Challenge: Current UI mirrors filter state to both devices. Bands should be independent.**

The existing `handleFrequencySelection` writes to both `d1` and `d2` refs. For band filters, we should:
- Keep the "apply to both" pattern for convenience (matching existing UX)
- But the underlying refs are separate, so independent control is architecturally supported
- Future UI enhancement: per-device filter panels (out of scope for v1)

---

## Implementation Order

### Phase 1: Core Filters
1. Compute bandpass coefficients (Butterworth bilinear transform) and hardcode in `filters.tsx`
2. Implement `BandpassFilter` class in `filters.tsx` with Alpha/Theta/Delta presets
3. Verify filter response using existing FFT infrastructure

### Phase 2: Integration into Dual-Stream Signal Chain
4. Add band filter refs and instances to `dual-stream/page.tsx`
5. Wire band filters into `processDeviceSample` — run in parallel after notch
6. Store band-filtered values in new channel data refs

### Phase 3: Visualization
7. Add multi-line support to canvas creation (`createDeviceCanvasElements`)
8. Update sweep write to include band lines with gain multiplier
9. Add canvas legend overlay (HTML-based, top-left corner)

### Phase 4: UI — Brainwave Bands Popup
10. Add "Brainwave Bands" popover button (visible only when EEG mode active)
11. Per-channel band toggles (multi-select Alpha/Theta/Delta)
12. Per-channel gain slider (1x–10x, default 3x)
13. "All channels" quick-toggle row

### Phase 5: WebSocket Export
14. Extend `WebSocketStreamer` with band value setters
15. Update `sendFiltered` to include band fields when enabled

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Band lines invisible due to small amplitude | Medium | Gain multiplier, adjustable per band |
| Delta filter settling time (~seconds) | Low | Start with 1-4Hz (post existing HP), document limitation |
| Performance with 18+ parallel filters | Low | ~360 FLOPs/sample at 500Hz is trivial |
| WebGL line limit per canvas | Low | webgl-plot handles multiple lines well; tested up to ~20 |
| Coefficient accuracy at edge frequencies | Medium | Validate with FFT sweep test; derive from Butterworth bilinear transform |
| UI clutter with many toggle options | Medium | Separate popup, only visible when EEG mode active |
| WebSocket message size bloat | Low | Only include enabled band fields; at worst ~3x current size |

---

## Key Files to Modify

| File | Changes |
|------|---------|
| `src/components/filters.tsx` | New `BandpassFilter` class with Alpha/Theta/Delta presets |
| `src/app/dual-stream/page.tsx` | Band filter refs, parallel filter chain, multi-line canvas, band toggle UI |
| `src/services/WebSocketStreamer.ts` | Band value setters, extended message format |
| `src/components/Colors.ts` | Band line color constants (optional, could inline) |

---

## Resolved Decisions

| Decision | Resolution |
|----------|-----------|
| Scope | Dual-stream only for now; single-stream (`Connection.tsx`) untouched |
| Coefficient tooling | No Python script in repo; compute coefficients manually and hardcode |
| Gain controls | Per-channel gain slider in the Brainwave Bands popup (1x–10x, default 3x) |
| Canvas legend | Yes — HTML overlay, top-left corner, shows active bands with color dots |
| UI location | Separate "Brainwave Bands" popover, not added to existing filter popup |

## Open Questions

1. **Should we add Beta (12-30Hz) and Gamma (30-45Hz) bands?** — the architecture supports it, but adds more UI complexity. Can be added later with minimal effort.
2. **Per-band gain vs per-channel gain?** — currently planned as per-channel (one slider affects all bands on that channel). Per-band sliders would give more control but more UI complexity.
