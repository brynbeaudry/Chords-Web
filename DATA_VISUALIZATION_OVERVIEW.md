# Data Visualization Overview

How data flows from BLE device to screen in the original `npg-lite` page.

---

## 1. BLE Packet Structure

The NPG device sends BLE notifications containing batched samples.

```
Single Sample (7 bytes):
  Byte 0       : uint8   - Sample counter (0-255, wraps)
  Bytes 1-2    : int16   - Channel 1 (big-endian)
  Bytes 3-4    : int16   - Channel 2 (big-endian)
  Bytes 5-6    : int16   - Channel 3 (big-endian)

Notification Packet (70 bytes):
  10 consecutive samples, each 7 bytes
```

The sample counter increments by 1 per sample and wraps at 255. Gaps indicate dropped samples.

---

## 2. Raw Values

Each channel is a **signed 16-bit integer** (`int16`), read big-endian:

```typescript
const sample = dataView.getInt16(1 + (channel * 2), false);
// Range: -32768 to +32767
// Represents raw ADC output from the biosignal frontend
```

These are unitless ADC counts. The device uses a 12-bit ADC, but values are transmitted as 16-bit.

---

## 3. Filter Pipeline

Every sample passes through three filters **in order**. Each filter is a separate class instance with its own internal state (biquad IIR coefficients and delay-line memory).

```
Raw int16
    |
    v
HighPassFilter.process(sample)
    |  Removes DC offset and baseline wander
    |  Cutoff: 1 Hz, Butterworth biquad
    v
EXGFilter.process(filtered, type)
    |  Frequency-selective filter + amplitude scaling
    |  type=undefined: passthrough (no filtering)
    |  type=1 (ECG):  lowpass 30 Hz
    |  type=2 (EOG):  lowpass 10 Hz
    |  type=3 (EEG):  lowpass 45 Hz
    |  type=4 (EMG):  lowpass 70 Hz
    |  Scaling: output * (2 / 2^12) to normalize to ~[-1, 1]
    v
Notch.process(filtered, type)
    |  Removes power-line interference
    |  type=undefined: passthrough
    |  type=1: notch at 50 Hz (Europe/UK/Australia)
    |  type=2: notch at 60 Hz (North America)
    |  Dual biquad cascade, narrow stopband
    v
Final filtered value (float)
```

The user controls which EXG and Notch filter types are active per channel via the Filter popover in the UI.

---

## 4. What Gets Visualized

After filtering, the data is assembled into an array:

```typescript
channelData = [sampleCounter, filteredCH1, filteredCH2, filteredCH3]
//              index 0        index 1      index 2      index 3
```

This array is passed to `updatePlots(channelData, zoom)`.

### Plot rendering

Each **selected channel** maps to one WebGL canvas. The user can select which channels to display (1, 2, 3, or any combination).

The visualization is an **oscilloscope-style sweep display**:

- Each canvas has a `WebglLine` with `dataPointCount` points (sampling rate x time base)
- New samples are written at the current sweep position
- The sweep position advances by 1 per sample and wraps around
- A "clear point" is drawn slightly ahead of the sweep to create the moving-gap effect

```typescript
// One sample per call:
line.setY(currentPos, channelData);                    // write new value
line.setY(clearPosition, NaN);                         // erase ahead
sweepPositions[i] = (currentPos + 1) % line.numPoints; // advance
```

The `animate()` loop calls `wglPlot.update()` on every animation frame to push the vertex buffer to the GPU.

### Zoom and Time Base

| Setting   | Effect |
|-----------|--------|
| Zoom (1-10x) | Scales the Y axis via `wglPlot.gScaleY` |
| Time Base (1-10s) | Controls how many data points fit on screen: `samplingRate * timeBase` |

Both are shared across all channel canvases.

---

## 5. What Gets Recorded

When recording is active, each processed sample is buffered in memory:

```typescript
// Sliced to only include selected channels:
[sampleCounter, filteredCH1, filteredCH2, filteredCH3]
```

Buffers flush to IndexedDB every 500 samples via a Web Worker. The data stored is **filtered** (post-pipeline), not raw.

### CSV Export Format

```csv
Counter,Channel1,Channel2,Channel3
0,-0.15,0.22,0.05
1,-0.14,0.23,0.05
2,-0.14,0.22,0.05
```

Filenames are timestamped: `ChordsWeb-YYYYMMDD-HHMMSS.csv`

---

## 6. Console Log (new)

The Terminal button in the control bar enables optional console logging of the same data being visualized:

```
[Sample #42] CH1: -0.15, CH2: 0.22, CH3: 0.05
```

This logs at the full sample rate (250-500Hz), so it will produce a lot of output. Use it for debugging, not long-running sessions. Open browser DevTools (F12) to see the output.

In the dual-stream page, logs are prefixed with the device slot:

```
[D1 #42] CH1: -0.15, CH2: 0.22, CH3: 0.05
[D2 #17] CH1: 0.11, CH2: 0.33, CH3: -0.22
```

---

## 7. Summary Diagram

```
NPG BLE Device
    |
    | 70-byte notification (10 samples)
    v
handleNotification()
    |
    | slice into 7-byte samples
    v
processSample(dataView)
    |
    | 1. Extract sample counter (byte 0)
    | 2. Extract 3x int16 channels (bytes 1-6)
    | 3. Filter: HighPass -> EXG -> Notch
    | 4. Build channelData array
    v
    +---> updatePlots() ---> WebglLine.setY() ---> GPU render
    |
    +---> console.log() (if enabled)
    |
    +---> recordingBuffer[] (if recording) ---> IndexedDB ---> CSV
```
