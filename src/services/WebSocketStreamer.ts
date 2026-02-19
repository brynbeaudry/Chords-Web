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

  sendFiltered(socketName: string): void {
    const conn = this.sockets.get(socketName);
    if (!conn?.isConnected) return;
    if (conn.socket.bufferedAmount > BACKPRESSURE_LIMIT) return;

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
