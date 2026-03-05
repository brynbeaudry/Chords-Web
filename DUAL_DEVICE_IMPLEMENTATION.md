# Dual Bluetooth Device Implementation Guide

## Overview

Modify Chords-Web to support **two simultaneous Bluetooth EEG devices** with split-view visualization and TouchDesigner streaming.

### Requirements (Locked In)
| Requirement | Decision |
|-------------|----------|
| Visualization | **Split View** - side-by-side canvases |
| Streaming Rate | **Full sample rate** (250Hz) to TouchDesigner |
| TD Port | **Hardcoded** to `ws://localhost:9000` |
| Disconnect Behavior | **Continue streaming** the other device if one disconnects |

---

## Source File: npg-lite/page.tsx

The new `/dual-stream` route will be based on [npg-lite/page.tsx](src/app/npg-lite/page.tsx) (1556 lines). This file contains the complete BLE implementation we need to duplicate and modify.

### Key Sections to Copy

| Section | Lines | Purpose | Modifications Needed |
|---------|-------|---------|---------------------|
| Imports | 1-48 | React, WebGL, filters, UI | Add TouchDesigner import |
| State declarations | 50-100 | Component state | Duplicate for device 2 |
| Filter refs | 341-352 | Filter instances per channel | Create separate refs per device |
| BLE constants | 329-335 | Service/Characteristic UUIDs | Keep as-is (same for both devices) |
| `processSample()` | 355-416 | Parse BLE data, apply filters, update plots | Make device-aware |
| `handleNotification()` | 422-445 | BLE event handler | Create one per device |
| `connectBLE()` | 447-485 | BLE connection flow | Create `connectDevice1()` and `connectDevice2()` |
| `disconnect()` | 487-518 | Disconnect logic | Make device-aware |
| Canvas creation | 102-207 | WebGL canvas setup | Duplicate for split view |
| Recording logic | 551-600 | IndexedDB buffering | Tag data with device ID |
| UI/Controls | 800+ | Buttons, settings | Add per-device controls |

---

## Detailed Modifications

### 1. Device State (Duplicate All Refs)

**Current (single device):**
```typescript
// npg-lite/page.tsx:446
const connectedDeviceRef = useRef<any | null>(null);
```

**New (dual device):**
```typescript
// Create parallel state for each device
const device1Ref = useRef<BluetoothDevice | null>(null);
const device2Ref = useRef<BluetoothDevice | null>(null);

const [isDevice1Connected, setIsDevice1Connected] = useState(false);
const [isDevice2Connected, setIsDevice2Connected] = useState(false);
```

**All refs that need duplication:**
```typescript
// From npg-lite/page.tsx - these exist once, need to exist twice

// Line 341-343: Filter refs (MUST be separate - filters have internal state)
const notchFiltersRef   = useRef(Array.from({ length: 3 }, () => new Notch()));
const exgFiltersRef     = useRef(Array.from({ length: 3 }, () => new EXGFilter()));
const pointoneFilterRef = useRef(Array.from({ length: 3 }, () => new HighPassFilter()));

// Becomes:
const device1Filters = {
  notch: useRef(Array.from({ length: 3 }, () => new Notch())),
  exg: useRef(Array.from({ length: 3 }, () => new EXGFilter())),
  highPass: useRef(Array.from({ length: 3 }, () => new HighPassFilter())),
};
const device2Filters = {
  notch: useRef(Array.from({ length: 3 }, () => new Notch())),
  exg: useRef(Array.from({ length: 3 }, () => new EXGFilter())),
  highPass: useRef(Array.from({ length: 3 }, () => new HighPassFilter())),
};

// Line 69-74: WebGL state (need separate canvases)
const [wglPlots, setWglPlots] = useState<WebglPlot[]>([]);
const linesRef = useRef<WebglLine[]>([]);
const sweepPositions = useRef<number[]>(new Array(6).fill(0));
const currentSweepPos = useRef<number[]>(new Array(6).fill(0));

// Becomes:
const device1Canvas = {
  wglPlots: useState<WebglPlot[]>([]),
  linesRef: useRef<WebglLine[]>([]),
  sweepPositions: useRef<number[]>(new Array(6).fill(0)),
  currentSweepPos: useRef<number[]>(new Array(6).fill(0)),
};
const device2Canvas = { /* same structure */ };

// Line 66-68: Recording buffers (need device tagging)
const recordingBuffers = Array(NUM_BUFFERS).fill(null).map(() => [] as number[][]);

// Becomes:
const device1RecordingBuffers = Array(NUM_BUFFERS).fill(null).map(() => [] as number[][]);
const device2RecordingBuffers = Array(NUM_BUFFERS).fill(null).map(() => [] as number[][]);
```

---

### 2. Connection Functions

**Current `connectBLE()` (lines 447-485):**
```typescript
async function connectBLE(): Promise<void> {
  const device = await nav.bluetooth.requestDevice({
    filters: [{ namePrefix: "NPG" }],
    optionalServices: [SERVICE_UUID],
  });
  const server = await device.gatt?.connect();
  connectedDeviceRef.current = device;
  // ... setup notifications
  setIsConnected(true);
}
```

**New dual-device connection:**
```typescript
async function connectDevice(deviceSlot: 1 | 2): Promise<void> {
  try {
    const nav = navigator as any;
    if (!nav.bluetooth) {
      toast.error("Web Bluetooth not available");
      return;
    }

    // Show device picker
    const device = await nav.bluetooth.requestDevice({
      filters: [{ namePrefix: "NPG" }],
      optionalServices: [SERVICE_UUID],
    });

    const server = await device.gatt?.connect();
    if (!server) return;

    // Store in correct slot
    if (deviceSlot === 1) {
      device1Ref.current = device;
    } else {
      device2Ref.current = device;
    }

    const service = await server.getPrimaryService(SERVICE_UUID);
    const dataChar = await service.getCharacteristic(DATA_CHAR_UUID);
    const controlChar = await service.getCharacteristic(CONTROL_CHAR_UUID);

    await controlChar.writeValue(new TextEncoder().encode("START"));
    await dataChar.startNotifications();

    // Use device-specific handler
    const handler = deviceSlot === 1 ? handleDevice1Notification : handleDevice2Notification;
    dataChar.addEventListener("characteristicvaluechanged", handler);

    // Update connection state
    if (deviceSlot === 1) {
      setIsDevice1Connected(true);
    } else {
      setIsDevice2Connected(true);
    }

    toast.success(`Device ${deviceSlot} connected: ${device.name}`);

  } catch (error) {
    toast.error(`Device ${deviceSlot} connection failed`);
  }
}

// Disconnect with continuation support
async function disconnectDevice(deviceSlot: 1 | 2): Promise<void> {
  const deviceRef = deviceSlot === 1 ? device1Ref : device2Ref;
  const setConnected = deviceSlot === 1 ? setIsDevice1Connected : setIsDevice2Connected;

  if (!deviceRef.current?.gatt?.connected) {
    deviceRef.current = null;
    setConnected(false);
    return;
  }

  try {
    const server = deviceRef.current.gatt;
    const service = await server.getPrimaryService(SERVICE_UUID);
    const dataChar = await service.getCharacteristic(DATA_CHAR_UUID);
    await dataChar.stopNotifications();
    server.disconnect();
  } catch (e) {
    console.error(`Disconnect error for device ${deviceSlot}:`, e);
  }

  deviceRef.current = null;
  setConnected(false);

  // NOTE: Other device continues streaming - no action needed
  toast.info(`Device ${deviceSlot} disconnected`);
}
```

---

### 3. Data Processing (Device-Aware)

**Current `processSample()` (lines 355-416):**
```typescript
const processSample = useCallback((dataView: DataView): void => {
  // ... parse sample
  for (let channel = 0; channel < numChannels; channel++) {
    const sample = dataView.getInt16(1 + (channel * 2), false);
    channelData.push(
      notchFiltersRef.current[channel].process(
        exgFiltersRef.current[channel].process(
          pointoneFilterRef.current[channel].process(sample)
        )
      )
    );
  }
  updatePlots(channelData, zoomRef.current);
  // ... recording
}, []);
```

**New device-aware processing:**
```typescript
// Separate channel data buffers
let device1ChannelData: number[] = [];
let device2ChannelData: number[] = [];

const processDevice1Sample = useCallback((dataView: DataView): void => {
  if (dataView.byteLength !== SINGLE_SAMPLE_LEN) return;

  const sampleCounter = dataView.getUint8(0);
  device1ChannelData.push(sampleCounter);

  for (let ch = 0; ch < numChannels; ch++) {
    const sample = dataView.getInt16(1 + (ch * 2), false);
    device1ChannelData.push(
      device1Filters.notch.current[ch].process(
        device1Filters.exg.current[ch].process(
          device1Filters.highPass.current[ch].process(sample)
        )
      )
    );
  }

  updateDevice1Plots(device1ChannelData);

  // Stream to TouchDesigner (full sample rate)
  tdStreamRef.current?.sendDevice1Data(device1ChannelData.slice(1)); // skip counter

  // Recording
  if (isRecordingRef.current) {
    bufferDevice1Sample(device1ChannelData);
  }

  device1ChannelData = [];
}, []);

const processDevice2Sample = useCallback((dataView: DataView): void => {
  // Mirror of processDevice1Sample with device2 refs
  // ...
  tdStreamRef.current?.sendDevice2Data(device2ChannelData.slice(1));
}, []);

// Notification handlers
function handleDevice1Notification(event: Event): void {
  const target = event.target as BluetoothRemoteGATTCharacteristicExtended;
  if (!target.value) return;

  const value = target.value;
  if (value.byteLength === NEW_PACKET_LEN) {
    for (let i = 0; i < NEW_PACKET_LEN; i += SINGLE_SAMPLE_LEN) {
      processDevice1Sample(new DataView(value.buffer.slice(i, i + SINGLE_SAMPLE_LEN)));
    }
  } else if (value.byteLength === SINGLE_SAMPLE_LEN) {
    processDevice1Sample(new DataView(value.buffer));
  }
}

function handleDevice2Notification(event: Event): void {
  // Mirror with processDevice2Sample
}
```

---

### 4. Split View Canvas Layout

**Current canvas container (lines 102-207):**
```typescript
const createCanvasElements = () => {
  const container = canvasContainerRef.current;
  // Creates single set of canvases for all channels
};
```

**New split view layout:**
```typescript
// Two container refs
const device1ContainerRef = useRef<HTMLDivElement>(null);
const device2ContainerRef = useRef<HTMLDivElement>(null);

const createDevice1Canvases = () => {
  const container = device1ContainerRef.current;
  if (!container) return;
  // ... same canvas creation logic, using device1Canvas state
};

const createDevice2Canvases = () => {
  const container = device2ContainerRef.current;
  if (!container) return;
  // ... same canvas creation logic, using device2Canvas state
};

// JSX Layout
return (
  <div className="flex flex-col h-screen">
    <Navbar />

    {/* Split View Container */}
    <div className="flex-1 flex flex-row gap-2 p-2">
      {/* Device 1 Panel */}
      <div className="flex-1 flex flex-col border rounded-lg">
        <div className="p-2 border-b flex items-center justify-between">
          <span className="font-medium">Device 1</span>
          <div className="flex items-center gap-2">
            {isDevice1Connected ? (
              <>
                <span className="text-green-500">● Connected</span>
                <Button size="sm" onClick={() => disconnectDevice(1)}>Disconnect</Button>
              </>
            ) : (
              <Button size="sm" onClick={() => connectDevice(1)}>Connect Device 1</Button>
            )}
          </div>
        </div>
        <div ref={device1ContainerRef} className="flex-1 relative" />
      </div>

      {/* Device 2 Panel */}
      <div className="flex-1 flex flex-col border rounded-lg">
        <div className="p-2 border-b flex items-center justify-between">
          <span className="font-medium">Device 2</span>
          <div className="flex items-center gap-2">
            {isDevice2Connected ? (
              <>
                <span className="text-green-500">● Connected</span>
                <Button size="sm" onClick={() => disconnectDevice(2)}>Disconnect</Button>
              </>
            ) : (
              <Button size="sm" onClick={() => connectDevice(2)}>Connect Device 2</Button>
            )}
          </div>
        </div>
        <div ref={device2ContainerRef} className="flex-1 relative" />
      </div>
    </div>

    {/* Shared Controls Bar */}
    <ControlBar />
  </div>
);
```

---

## TouchDesigner Integration

### Architecture: Browser → TouchDesigner

**TouchDesigner acts as the WebSocket server.** The browser connects to it as a client.

This is required because browsers cannot create WebSocket servers - they can only connect as clients.

```
┌─────────────────────┐         ┌─────────────────────┐
│  Browser            │         │  TouchDesigner      │
│  (WebSocket Client) │────────►│  (WebSocket Server) │
│                     │  JSON   │  Port 9000          │
└─────────────────────┘         └─────────────────────┘
```

**Startup order:**
1. Start TouchDesigner with WebSocket DAT active (Server mode, port 9000)
2. Load the browser page
3. Click "Connect TD" - browser connects to TD
4. Browser streams EEG data as JSON messages

### Example JSON Messages (sent at 250Hz)

**Filtered data (default socket - port 9000):**
```json
{
  "ts": 12847.5,
  "d1_ch0": 0.234,
  "d1_ch1": -0.156,
  "d1_ch2": 0.089,
  "d2_ch0": 0.112,
  "d2_ch1": 0.334,
  "d2_ch2": -0.221
}
```

**Raw data (optional socket - port 9001):**
```json
{
  "ts": 12847.5,
  "d1_raw0": 2048,
  "d1_raw1": 1892,
  "d1_raw2": 2156,
  "d2_raw0": 2001,
  "d2_raw1": 2234,
  "d2_raw2": 1945
}
```

| Field | Description |
|-------|-------------|
| `ts` | Timestamp in milliseconds (`performance.now()`) |
| `d1_ch0-2` | Device 1 filtered values (after HighPass → EXG → Notch) |
| `d2_ch0-2` | Device 2 filtered values |
| `d1_raw0-2` | Device 1 raw ADC values (unfiltered) |
| `d2_raw0-2` | Device 2 raw ADC values (unfiltered) |

---

### New File: `src/services/WebSocketStreamer.ts`

Supports multiple socket connections for sending data to different destinations.

```typescript
interface SocketConnection {
  socket: WebSocket;
  url: string;
  isConnected: boolean;
}

class WebSocketStreamer {
  private sockets: Map<string, SocketConnection> = new Map();

  // Buffered data
  private device1Filtered: number[] = [0, 0, 0];
  private device2Filtered: number[] = [0, 0, 0];
  private device1Raw: number[] = [0, 0, 0];
  private device2Raw: number[] = [0, 0, 0];

  // Connect to a WebSocket server (e.g., TouchDesigner)
  connect(name: string, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const socket = new WebSocket(url);

        socket.onopen = () => {
          this.sockets.set(name, { socket, url, isConnected: true });
          console.log(`Connected to ${name} at ${url}`);
          resolve();
        };

        socket.onerror = (e) => reject(e);

        socket.onclose = () => {
          const conn = this.sockets.get(name);
          if (conn) conn.isConnected = false;
          console.log(`Disconnected from ${name}`);
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  disconnect(name: string): void {
    const conn = this.sockets.get(name);
    if (conn) {
      conn.socket.close();
      this.sockets.delete(name);
    }
  }

  disconnectAll(): void {
    this.sockets.forEach((conn, name) => this.disconnect(name));
  }

  // Update data buffers
  setDevice1Filtered(channels: number[]): void {
    this.device1Filtered = channels;
  }

  setDevice2Filtered(channels: number[]): void {
    this.device2Filtered = channels;
  }

  setDevice1Raw(channels: number[]): void {
    this.device1Raw = channels;
  }

  setDevice2Raw(channels: number[]): void {
    this.device2Raw = channels;
  }

  // Send filtered data to a specific socket
  sendFiltered(socketName: string): void {
    const conn = this.sockets.get(socketName);
    if (!conn?.isConnected) return;

    const message = {
      ts: performance.now(),
      d1_ch0: this.device1Filtered[0] ?? 0,
      d1_ch1: this.device1Filtered[1] ?? 0,
      d1_ch2: this.device1Filtered[2] ?? 0,
      d2_ch0: this.device2Filtered[0] ?? 0,
      d2_ch1: this.device2Filtered[1] ?? 0,
      d2_ch2: this.device2Filtered[2] ?? 0,
    };

    conn.socket.send(JSON.stringify(message));
  }

  // Send raw data to a specific socket
  sendRaw(socketName: string): void {
    const conn = this.sockets.get(socketName);
    if (!conn?.isConnected) return;

    const message = {
      ts: performance.now(),
      d1_raw0: this.device1Raw[0] ?? 0,
      d1_raw1: this.device1Raw[1] ?? 0,
      d1_raw2: this.device1Raw[2] ?? 0,
      d2_raw0: this.device2Raw[0] ?? 0,
      d2_raw1: this.device2Raw[1] ?? 0,
      d2_raw2: this.device2Raw[2] ?? 0,
    };

    conn.socket.send(JSON.stringify(message));
  }

  // Send to all connected sockets
  broadcastFiltered(): void {
    this.sockets.forEach((conn, name) => {
      if (conn.isConnected) this.sendFiltered(name);
    });
  }

  broadcastRaw(): void {
    this.sockets.forEach((conn, name) => {
      if (conn.isConnected) this.sendRaw(name);
    });
  }

  isConnected(name: string): boolean {
    return this.sockets.get(name)?.isConnected ?? false;
  }

  getConnectedSockets(): string[] {
    return Array.from(this.sockets.entries())
      .filter(([_, conn]) => conn.isConnected)
      .map(([name, _]) => name);
  }
}

export const streamer = new WebSocketStreamer();
```

### Usage Example

```typescript
// Connect to multiple destinations
await streamer.connect('touchdesigner', 'ws://localhost:9000');  // Filtered data
await streamer.connect('raw-logger', 'ws://localhost:9001');     // Raw data
await streamer.connect('backup', 'ws://192.168.1.50:9000');      // Another machine

// In processDevice1Sample():
const rawChannels = [sample1, sample2, sample3];  // Before filtering
const filteredChannels = [filtered1, filtered2, filtered3];  // After filtering

streamer.setDevice1Raw(rawChannels);
streamer.setDevice1Filtered(filteredChannels);

// Send to specific sockets
streamer.sendFiltered('touchdesigner');
streamer.sendRaw('raw-logger');

// Or broadcast to all
streamer.broadcastFiltered();
```

### Integration in Dual Stream Page

```typescript
import { streamer } from '@/services/WebSocketStreamer';

// At top of component
const [connectedSockets, setConnectedSockets] = useState<string[]>([]);

// Connect handlers
const connectTouchDesigner = async () => {
  try {
    await streamer.connect('touchdesigner', 'ws://localhost:9000');
    setConnectedSockets(streamer.getConnectedSockets());
    toast.success('Connected to TouchDesigner');
  } catch (e) {
    toast.error('Connection failed - is TouchDesigner running?');
  }
};

const connectRawSocket = async () => {
  try {
    await streamer.connect('raw', 'ws://localhost:9001');
    setConnectedSockets(streamer.getConnectedSockets());
    toast.success('Connected to raw data socket');
  } catch (e) {
    toast.error('Raw socket connection failed');
  }
};

// In processDevice1Sample - send both raw and filtered:
const rawChannels = [sample1, sample2, sample3];
streamer.setDevice1Raw(rawChannels);

const filteredChannels = [filtered1, filtered2, filtered3];
streamer.setDevice1Filtered(filteredChannels);

streamer.sendFiltered('touchdesigner');
streamer.sendRaw('raw');
```

### TouchDesigner Setup (Must Be Running First)

**1. WebSocket DAT (Server):**
- Create `WebSocket DAT`
- Mode: **Server** ← TD listens for browser connections
- Port: **9000**
- Active: ✅

TD must be running with this DAT active *before* clicking "Connect TD" in the browser.

**2. DAT Execute (parse incoming JSON from browser):**
```python
import json

def onReceive(dat, rowIndex, message, bytes, peer):
    try:
        data = json.loads(message)
        t = op('eeg_data')  # Table DAT

        # Device 1 channels (filtered)
        t['d1_ch0', 1] = data.get('d1_ch0', 0)
        t['d1_ch1', 1] = data.get('d1_ch1', 0)
        t['d1_ch2', 1] = data.get('d1_ch2', 0)

        # Device 2 channels (filtered)
        t['d2_ch0', 1] = data.get('d2_ch0', 0)
        t['d2_ch1', 1] = data.get('d2_ch1', 0)
        t['d2_ch2', 1] = data.get('d2_ch2', 0)
    except:
        pass
```

**For raw data (on port 9001):**
```python
import json

def onReceive(dat, rowIndex, message, bytes, peer):
    try:
        data = json.loads(message)
        t = op('eeg_raw')  # Separate Table DAT for raw

        t['d1_raw0', 1] = data.get('d1_raw0', 0)
        t['d1_raw1', 1] = data.get('d1_raw1', 0)
        t['d1_raw2', 1] = data.get('d1_raw2', 0)
        t['d2_raw0', 1] = data.get('d2_raw0', 0)
        t['d2_raw1', 1] = data.get('d2_raw1', 0)
        t['d2_raw2', 1] = data.get('d2_raw2', 0)
    except:
        pass
```

**3. DAT to CHOP** to get `d1_ch0`, `d1_ch1`, `d2_ch0`, etc. as CHOP channels.

---

## File Structure

### New Files to Create

```
src/
├── app/
│   └── dual-stream/
│       └── page.tsx            # Main dual-device page (copy from npg-lite/page.tsx)
│
├── services/
│   └── WebSocketStreamer.ts    # Multi-socket streaming (filtered + raw data)
│
└── components/
    └── DualStreamControls.tsx  # Shared control bar (optional extraction)
```

### Files to Copy & Modify

| Source | Destination | Key Changes |
|--------|-------------|-------------|
| `src/app/npg-lite/page.tsx` | `src/app/dual-stream/page.tsx` | Duplicate all device state, split canvas layout, add TD streaming |

---

## Implementation Checklist

### Phase 1: Route & Basic Structure
- [ ] Create `src/app/dual-stream/page.tsx` (copy npg-lite/page.tsx)
- [ ] Rename component to `DualStream`
- [ ] Create split-view layout structure (two side-by-side containers)

### Phase 2: Dual Device State
- [ ] Duplicate `connectedDeviceRef` → `device1Ref`, `device2Ref`
- [ ] Duplicate filter refs for each device (lines 341-343)
- [ ] Duplicate canvas state refs (lines 69-74)
- [ ] Duplicate recording buffers (lines 66-68)
- [ ] Create `isDevice1Connected`, `isDevice2Connected` state

### Phase 3: Connection Functions
- [ ] Create `connectDevice(slot: 1 | 2)` from `connectBLE()` (lines 447-485)
- [ ] Create `disconnectDevice(slot: 1 | 2)` from `disconnect()` (lines 487-518)
- [ ] Ensure one device can disconnect while other continues

### Phase 4: Data Processing
- [ ] Create `processDevice1Sample()` from `processSample()` (lines 355-416)
- [ ] Create `processDevice2Sample()` (mirror)
- [ ] Create `handleDevice1Notification()` from `handleNotification()` (lines 422-445)
- [ ] Create `handleDevice2Notification()` (mirror)

### Phase 5: Visualization
- [ ] Create `device1ContainerRef`, `device2ContainerRef`
- [ ] Create `createDevice1Canvases()` from `createCanvasElements()` (lines 102-207)
- [ ] Create `createDevice2Canvases()` (mirror)
- [ ] Create `updateDevice1Plots()`, `updateDevice2Plots()`

### Phase 6: WebSocket Streaming
- [ ] Create `src/services/WebSocketStreamer.ts`
- [ ] Add streaming calls in `processDevice1Sample()` and `processDevice2Sample()`
- [ ] Send both raw and filtered data to respective sockets
- [ ] Add socket connect/disconnect UI in control bar

### Phase 7: Recording (Optional)
- [ ] Modify recording buffers to tag with device ID
- [ ] Update worker messages to include device source
- [ ] Update filename format: `session_device1_*.csv`, `session_device2_*.csv`

---

## Line Number Reference

| Feature | File | Lines |
|---------|------|-------|
| BLE constants | npg-lite/page.tsx | 329-335 |
| Filter refs | npg-lite/page.tsx | 341-352 |
| processSample | npg-lite/page.tsx | 355-416 |
| handleNotification | npg-lite/page.tsx | 422-445 |
| connectBLE | npg-lite/page.tsx | 447-485 |
| disconnect | npg-lite/page.tsx | 487-518 |
| Canvas creation | npg-lite/page.tsx | 102-207 |
| Recording buffer | npg-lite/page.tsx | 551-571 |
| Filter classes | filters.tsx | 12-68 (HighPass), 71-200+ (EXG) |

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Browser (dual-stream page)                        │
│                                                                              │
│  ┌─────────────────┐                      ┌─────────────────┐               │
│  │  BLE Device 1   │                      │  BLE Device 2   │               │
│  │  (NPG-001)      │                      │  (NPG-002)      │               │
│  └────────┬────────┘                      └────────┬────────┘               │
│           │ characteristicvaluechanged             │                         │
│           ▼                                        ▼                         │
│  ┌─────────────────┐                      ┌─────────────────┐               │
│  │handleDevice1    │                      │handleDevice2    │               │
│  │Notification()   │                      │Notification()   │               │
│  └────────┬────────┘                      └────────┬────────┘               │
│           ▼                                        ▼                         │
│  ┌─────────────────┐                      ┌─────────────────┐               │
│  │processDevice1   │                      │processDevice2   │               │
│  │Sample()         │                      │Sample()         │               │
│  │                 │                      │                 │               │
│  │ • Parse bytes   │                      │ • Parse bytes   │               │
│  │ • device1Filters│                      │ • device2Filters│               │
│  └────────┬────────┘                      └────────┬────────┘               │
│           │                                        │                         │
│           ├──────────────┬─────────────────────────┤                         │
│           │              │                         │                         │
│           ▼              ▼                         ▼                         │
│  ┌──────────────┐  ┌──────────────┐       ┌──────────────┐                  │
│  │Device 1      │  │TouchDesigner │       │Device 2      │                  │
│  │Canvas (Left) │  │Stream        │       │Canvas (Right)│                  │
│  └──────────────┘  └──────┬───────┘       └──────────────┘                  │
│                           │                                                  │
└───────────────────────────┼──────────────────────────────────────────────────┘
                            │ Browser connects TO TouchDesigner
                            │ WebSocket Client → Server (ws://localhost:9000)
                            ▼
              ┌─────────────────────────────┐
              │      TouchDesigner          │
              │      (must be running)      │
              │                             │
              │  WebSocket DAT (Server)     │
              │         │                   │
              │         ▼                   │
              │  DAT Execute (JSON parse)   │
              │         │                   │
              │         ▼                   │
              │  Table DAT → CHOP           │
              │  ┌─────────┬─────────┐      │
              │  │ d1_ch0  │ d2_ch0  │      │
              │  │ d1_ch1  │ d2_ch1  │      │
              │  │ d1_ch2  │ d2_ch2  │      │
              │  └─────────┴─────────┘      │
              └─────────────────────────────┘
```
