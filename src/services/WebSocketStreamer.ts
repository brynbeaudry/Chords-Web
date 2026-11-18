interface SocketConnection {
  socket: WebSocket;
  url: string;
  isConnected: boolean;
}

const BACKPRESSURE_LIMIT = 1024; // 1KB — skip send if socket is backed up

export class WebSocketStreamer {
  private sockets: Map<string, SocketConnection> = new Map();

  private device1Filtered: number[] = [0, 0, 0];
  private device2Filtered: number[] = [0, 0, 0];
  private device1Raw: number[] = [0, 0, 0];
  private device2Raw: number[] = [0, 0, 0];
  private device1Bands: { [band: string]: number[] } = {};
  private device2Bands: { [band: string]: number[] } = {};
  private device1BandStates: { [channel: number]: { is_alpha: boolean } } = {};
  private device2BandStates: { [channel: number]: { is_alpha: boolean } } = {};

  connect(name: string, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const existing = this.sockets.get(name);
        if (existing?.isConnected) {
          existing.socket.close();
          this.sockets.delete(name);
        }

        const socket = new WebSocket(url);

        socket.onopen = () => {
          this.sockets.set(name, { socket, url, isConnected: true });
          console.log(`WebSocketStreamer: connected to ${name} at ${url}`);
          resolve();
        };

        socket.onerror = (e) => {
          reject(e);
        };

        socket.onclose = () => {
          const conn = this.sockets.get(name);
          if (conn) conn.isConnected = false;
          console.log(`WebSocketStreamer: disconnected from ${name}`);
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
    this.sockets.forEach((_, name) => this.disconnect(name));
  }

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

  setDevice1BandData(band: string, channels: number[]): void {
    this.device1Bands[band] = channels;
  }

  setDevice2BandData(band: string, channels: number[]): void {
    this.device2Bands[band] = channels;
  }

  setDevice1BandState(channel: number, state: { is_alpha: boolean }): void {
    this.device1BandStates[channel] = state;
  }

  setDevice2BandState(channel: number, state: { is_alpha: boolean }): void {
    this.device2BandStates[channel] = state;
  }

  clearDevice1BandState(channel: number): void {
    delete this.device1BandStates[channel];
  }

  clearDevice2BandState(channel: number): void {
    delete this.device2BandStates[channel];
  }

  sendFiltered(socketName: string): void {
    const conn = this.sockets.get(socketName);
    if (!conn?.isConnected) return;
    if (conn.socket.bufferedAmount > BACKPRESSURE_LIMIT) return;

    const message: Record<string, number> = {
      ts: performance.now(),
      d1_ch0: this.device1Filtered[0] ?? 0,
      d1_ch1: this.device1Filtered[1] ?? 0,
      d1_ch2: this.device1Filtered[2] ?? 0,
      d2_ch0: this.device2Filtered[0] ?? 0,
      d2_ch1: this.device2Filtered[1] ?? 0,
      d2_ch2: this.device2Filtered[2] ?? 0,
    };

    for (const [band, channels] of Object.entries(this.device1Bands)) {
      channels.forEach((val, i) => {
        if (val !== 0) message[`d1_ch${i}_${band}`] = val;
      });
    }
    for (const [band, channels] of Object.entries(this.device2Bands)) {
      channels.forEach((val, i) => {
        if (val !== 0) message[`d2_ch${i}_${band}`] = val;
      });
    }

    // Alpha predominance boolean — alpha-only (theta/delta detection removed)
    for (const [chStr, st] of Object.entries(this.device1BandStates)) {
      message[`d1_ch${Number(chStr)}_is_alpha`] = st.is_alpha ? 1 : 0;
    }
    for (const [chStr, st] of Object.entries(this.device2BandStates)) {
      message[`d2_ch${Number(chStr)}_is_alpha`] = st.is_alpha ? 1 : 0;
    }

    conn.socket.send(JSON.stringify(message));
  }

  sendRaw(socketName: string): void {
    const conn = this.sockets.get(socketName);
    if (!conn?.isConnected) return;
    if (conn.socket.bufferedAmount > BACKPRESSURE_LIMIT) return;

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

  // ─── Dual Alpha (contract v2) additions; nothing above is changed ───

  private autoTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private autoStopped: Set<string> = new Set();

  /**
   * Opens `url` under `name` and keeps it open: on failure or loss it retries quietly,
   * backing off 0.5 s, 1 s, 2 s, 4 s, then every 5 s. `onStatus` reports each change.
   * Returns a function that stops retrying and closes the socket.
   */
  connectAuto(url: string, onStatus?: (connected: boolean) => void, name = 'touchdesigner'): () => void {
    this.autoStopped.delete(name);
    let delay = 500;
    const attempt = () => {
      if (this.autoStopped.has(name)) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        schedule();
        return;
      }
      socket.onopen = () => {
        if (this.autoStopped.has(name)) { socket.close(); return; }
        delay = 500;
        this.sockets.set(name, { socket, url, isConnected: true });
        onStatus?.(true);
      };
      socket.onclose = () => {
        const conn = this.sockets.get(name);
        const wasConnected = conn?.socket === socket && conn.isConnected;
        if (conn?.socket === socket) this.sockets.delete(name);
        if (wasConnected) onStatus?.(false);
        schedule();
      };
      socket.onerror = () => { /* onclose follows and schedules the retry */ };
    };
    const schedule = () => {
      if (this.autoStopped.has(name)) return;
      const t = setTimeout(attempt, delay);
      this.autoTimers.set(name, t);
      delay = Math.min(5000, delay * 2);
    };
    attempt();
    return () => {
      this.autoStopped.add(name);
      const t = this.autoTimers.get(name);
      if (t) clearTimeout(t);
      this.autoTimers.delete(name);
      this.disconnect(name);
    };
  }

  /** Sends one contract v2 state message as JSON. Returns false if not sent. */
  sendState(msg: object, name = 'touchdesigner'): boolean {
    const conn = this.sockets.get(name);
    if (!conn?.isConnected || conn.socket.readyState !== WebSocket.OPEN) return false;
    if (conn.socket.bufferedAmount > 16 * BACKPRESSURE_LIMIT) return false;
    conn.socket.send(JSON.stringify(msg));
    return true;
  }

  isConnected(name: string): boolean {
    return this.sockets.get(name)?.isConnected ?? false;
  }

  getConnectedSockets(): string[] {
    return Array.from(this.sockets.entries())
      .filter(([, conn]) => conn.isConnected)
      .map(([name]) => name);
  }
}
