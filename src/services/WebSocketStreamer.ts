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
  private device1BandStates: { [channel: number]: { is_alpha: boolean; is_theta: boolean; is_delta: boolean } } = {};
  private device2BandStates: { [channel: number]: { is_alpha: boolean; is_theta: boolean; is_delta: boolean } } = {};

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

  setDevice1BandState(channel: number, state: { is_alpha: boolean; is_theta: boolean; is_delta: boolean }): void {
    this.device1BandStates[channel] = state;
  }

  setDevice2BandState(channel: number, state: { is_alpha: boolean; is_theta: boolean; is_delta: boolean }): void {
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

    // Predominance-detection booleans — strictly additive, appended last
    for (const [chStr, st] of Object.entries(this.device1BandStates)) {
      const ch = Number(chStr);
      message[`d1_ch${ch}_is_alpha`] = st.is_alpha ? 1 : 0;
      message[`d1_ch${ch}_is_theta`] = st.is_theta ? 1 : 0;
      message[`d1_ch${ch}_is_delta`] = st.is_delta ? 1 : 0;
    }
    for (const [chStr, st] of Object.entries(this.device2BandStates)) {
      const ch = Number(chStr);
      message[`d2_ch${ch}_is_alpha`] = st.is_alpha ? 1 : 0;
      message[`d2_ch${ch}_is_theta`] = st.is_theta ? 1 : 0;
      message[`d2_ch${ch}_is_delta`] = st.is_delta ? 1 : 0;
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

  isConnected(name: string): boolean {
    return this.sockets.get(name)?.isConnected ?? false;
  }

  getConnectedSockets(): string[] {
    return Array.from(this.sockets.entries())
      .filter(([, conn]) => conn.isConnected)
      .map(([name]) => name);
  }
}
