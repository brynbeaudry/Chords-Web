#!/usr/bin/env python3
"""Send contract v2 messages to TouchDesigner (dual-alpha-V16.toe) with no app running.

Replays a td_stream.jsonl recorded by the Dual Alpha page (one line per message:
{"t_ms": <ms since the recording started>, "msg": {...contract v2...}}) at its original
timing, or synthesises a two-person v2 stream that walks through every state of the piece.

  python3 mock_sender.py --file session.td_stream.jsonl            # replay once
  python3 mock_sender.py --file session.td_stream.jsonl --loop     # replay forever
  python3 mock_sender.py --synthetic --loop                        # scripted 60 s scenario
  python3 mock_sender.py --synthetic --host 192.168.1.20 --port 9000

Python 3 standard library only. If the `websockets` package is installed it is used
(sync client); otherwise, or with --stdlib, a minimal RFC 6455 client built on `socket`
sends the frames. Text frames only, client-masked, as browsers send them.

The synthetic scenario (seconds into each 60 s loop; person 1 = d1 = right, person 2 = left):
   0-5    Apart       both ok, both level 0
   5-15   One in      person 1 in alpha, level rising 0.2 -> 0.7; person 2 waits
  15-30   Together    both in (person 2 rises to 0.4): pair_level = min > 0; held after 3 s
  31.0    blink       person 2 drops for 0.5 s (shorter than Forgiveness 1 s: count continues)
  30-34   Together    continues
  34-38   One in      person 2 leaves
  38-43   Settling    person 1 not ok (electrode off): right side grey
  43-47   Apart       both ok, both 0
  47.0    wrong version: one v1-shaped message (lights contract_error until the next v2)
  50-52.5 silence     no messages for 2.5 s: TD's stale test turns both not ok (grey)
  52.5-60 Together    both in again
"""
import argparse, base64, hashlib, json, math, os, random, select, socket, struct, sys, time

FS = 125
BATCH = 16                     # samples per message, 128 ms
HOP_S = BATCH / FS


# ------------------------------------------------------------------ transport

class StdlibWS:
    """Minimal RFC 6455 client: handshake, masked text frames, ping/close handling."""
    GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

    def __init__(self, host, port, path='/', timeout=5.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        key = base64.b64encode(os.urandom(16)).decode()
        req = ('GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
               'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n') % (path, host, port, key)
        self.sock.sendall(req.encode())
        resp = b''
        while b'\r\n\r\n' not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError('server closed during handshake')
            resp += chunk
        head, self.buf = resp.split(b'\r\n\r\n', 1)
        lines = head.decode('latin-1').split('\r\n')
        if ' 101 ' not in lines[0] + ' ':
            raise ConnectionError('handshake refused: ' + lines[0])
        hdr = {l.split(':', 1)[0].strip().lower(): l.split(':', 1)[1].strip() for l in lines[1:] if ':' in l}
        want = base64.b64encode(hashlib.sha1((key + self.GUID).encode()).digest()).decode()
        if hdr.get('sec-websocket-accept') != want:
            raise ConnectionError('bad Sec-WebSocket-Accept')
        self.sock.settimeout(None)
        self.closed = False

    def _frame(self, opcode, payload):
        n = len(payload)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            head += bytes([0x80 | 127]) + struct.pack('>Q', n)
        mask = os.urandom(4)
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(head + mask + body)

    def send(self, text):
        self.poll()
        if self.closed:
            raise ConnectionError('server closed the connection')
        self._frame(0x1, text.encode('utf-8'))

    def poll(self):
        """Answer pings and notice a close, without blocking."""
        while True:
            r, _, _ = select.select([self.sock], [], [], 0)
            if not r:
                break
            chunk = self.sock.recv(65536)
            if not chunk:
                self.closed = True
                return
            self.buf += chunk
        while len(self.buf) >= 2:
            b1, b2 = self.buf[0], self.buf[1]
            n, off = b2 & 0x7F, 2
            if n == 126:
                if len(self.buf) < 4: return
                n, off = struct.unpack('>H', self.buf[2:4])[0], 4
            elif n == 127:
                if len(self.buf) < 10: return
                n, off = struct.unpack('>Q', self.buf[2:10])[0], 10
            if b2 & 0x80:
                off += 4
            if len(self.buf) < off + n:
                return
            payload, self.buf = self.buf[off:off + n], self.buf[off + n:]
            op = b1 & 0x0F
            if op == 0x9:
                self._frame(0xA, payload)            # pong
            elif op == 0x8:
                try:
                    self._frame(0x8, payload[:2])
                except OSError:
                    pass
                self.closed = True

    def close(self):
        try:
            self._frame(0x8, struct.pack('>H', 1000))
        except OSError:
            pass
        self.sock.close()


def connect(host, port, force_stdlib):
    if not force_stdlib:
        try:
            from websockets.sync.client import connect as wsconnect   # websockets >= 11
        except ImportError:
            wsconnect = None
        if wsconnect is not None:
            ws = wsconnect('ws://%s:%d/' % (host, port), open_timeout=5)
            print('connected with websockets to ws://%s:%d/' % (host, port))
            return ws
    ws = StdlibWS(host, port)
    print('connected (stdlib RFC 6455 client) to ws://%s:%d/' % (host, port))
    return ws


# ------------------------------------------------------------------ synthetic stream

def scenario(t):
    """(d1_level, d1_ok, d2_level, d2_ok, send) at time t into the 60 s loop."""
    def ramp(a, b, t0, t1):
        return a + (b - a) * min(1.0, max(0.0, (t - t0) / (t1 - t0)))
    l1 = l2 = 0.0
    ok1 = ok2 = 1
    send = True
    if 5 <= t < 15:
        l1 = ramp(0.2, 0.7, 5, 12)
    elif 15 <= t < 34:
        l1 = 0.7
        l2 = ramp(0.2, 0.4, 15, 18)
        if 31.0 <= t < 31.5:
            l2 = 0.0                                  # blink
    elif 34 <= t < 38:
        l1 = 0.7
    elif 38 <= t < 43:
        ok1 = 0
    elif 50 <= t < 52.5:
        send = False
    elif t >= 52.5:
        l1, l2 = 0.6, ramp(0.1, 0.5, 52.5, 55)
    if not ok1: l1 = 0.0
    if not ok2: l2 = 0.0
    return l1, ok1, l2, ok2, send


class Wave:
    """A plausible filtered EEG trace at 125 Hz, in the app's scale (about +-1): 10 Hz
    alpha whose amplitude follows the level, plus slower activity and noise."""
    def __init__(self, seed, f_alpha):
        self.r = random.Random(seed)
        self.f = f_alpha
        self.lp = 0.0

    def sample(self, k, level, ok):
        t = k / FS
        if not ok:                                    # electrode off: railing-ish noise
            return round(self.r.uniform(-1.5, 1.5), 4)
        self.lp += 0.05 * (self.r.gauss(0, 1) - self.lp)
        a = (0.15 + 0.6 * level) * math.sin(2 * math.pi * self.f * t)
        return round(a + 0.25 * self.lp * 4 + 0.08 * self.r.gauss(0, 1) + 0.1 * math.sin(2 * math.pi * 1.3 * t), 4)


def synthetic(loop):
    w1, w2 = Wave(1, 10.0), Wave(2, 9.5)
    n = 0
    period = 60.0
    t = 0.0
    sent_wrong = False
    while True:
        tl = t % period
        if tl < HOP_S:
            sent_wrong = False
        l1, ok1, l2, ok2, send = scenario(tl)
        d1 = [w1.sample(n + i, l1, ok1) for i in range(BATCH)]
        d2 = [w2.sample(n + i, l2, ok2) for i in range(BATCH)]
        if send:
            pair = min(l1, l2) if (ok1 and ok2) else 0.0
            msg = {'v': 2, 'fs': FS, 'n': n, 'd1_level': round(l1, 3), 'd1_ok': ok1,
                   'd2_level': round(l2, 3), 'd2_ok': ok2, 'pair_level': round(pair, 3),
                   'd1_w': d1, 'd2_w': d2}
            yield t, msg
            if 47.0 <= tl < 47.0 + HOP_S and not sent_wrong:
                sent_wrong = True
                yield t, {'ts': n, 'd1_ch0': d1[0], 'd1_ch1': d1[1], 'd1_ch2': d1[2],
                          'd2_ch0': d2[0], 'd2_ch1': d2[1], 'd2_ch2': d2[2]}     # v1 shape: no "v"
        n += BATCH                                    # the app keeps counting through silence
        t += HOP_S
        if not loop and t >= period:
            return


def replay(path, loop):
    rows = []
    with open(path) as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                rows.append((float(row['t_ms']) / 1000.0, row['msg']))
            except (ValueError, KeyError, TypeError) as e:
                print('skipping line %d: %s' % (i + 1, e), file=sys.stderr)
    if not rows:
        raise SystemExit('no messages in ' + path)
    span = rows[-1][0] - rows[0][0] + HOP_S
    offset = 0.0
    while True:
        for t, msg in rows:
            yield t - rows[0][0] + offset, msg
        if not loop:
            return
        offset += span


# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument('--file', help='td_stream.jsonl recorded by the Dual Alpha page')
    src.add_argument('--synthetic', action='store_true', help='send the scripted 60 s two-person scenario')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=9000)
    ap.add_argument('--loop', action='store_true', help='repeat forever')
    ap.add_argument('--speed', type=float, default=1.0, help='playback speed factor (default 1)')
    ap.add_argument('--stdlib', action='store_true', help='use the built-in RFC 6455 client even if websockets is installed')
    ap.add_argument('--max-seconds', type=float, default=0, help='stop after this many seconds (0 = no limit)')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args()

    gen = synthetic(a.loop) if a.synthetic else replay(a.file, a.loop)
    try:
        ws = connect(a.host, a.port, a.stdlib)
    except (OSError, ConnectionError) as e:
        print('cannot connect to ws://%s:%d/: %s (is TouchDesigner running with webserver1 active?)'
              % (a.host, a.port, e), file=sys.stderr)
        return 1
    t0 = time.monotonic()
    count = bad = 0
    last_report = 0.0
    try:
        for t, msg in gen:
            due = t0 + t / a.speed
            delay = due - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            ws.send(json.dumps(msg, separators=(',', ':')))
            count += 1
            if msg.get('v') != 2:
                bad += 1
            el = time.monotonic() - t0
            if not a.quiet and el - last_report >= 1.0:
                last_report = el
                print('%6.1f s  sent %5d  n=%-8s d1 %.2f/%s  d2 %.2f/%s  pair %.2f%s' % (
                    el, count, msg.get('n', '-'), msg.get('d1_level', 0), msg.get('d1_ok', '-'),
                    msg.get('d2_level', 0), msg.get('d2_ok', '-'), msg.get('pair_level', 0),
                    '' if msg.get('v') == 2 else '  [wrong version]'))
            if a.max_seconds and el >= a.max_seconds:
                break
    except KeyboardInterrupt:
        pass
    except (ConnectionError, OSError) as e:
        print('connection lost: %s' % e, file=sys.stderr)
        return 1
    finally:
        try:
            ws.close()
        except Exception:
            pass
    print('done: %d messages sent (%d not v2)' % (count, bad))
    return 0


if __name__ == '__main__':
    sys.exit(main())
