#!/usr/bin/env python3
"""A stand-in for TouchDesigner's Web Server DAT, for testing mock_sender.py (or the app)
without TouchDesigner. Standard library only.

  python3 scripts/ws_test_server.py --port 9000 --seconds 65
  python3 mock_sender.py --synthetic --port 9000          (in another terminal)

It accepts WebSocket clients (RFC 6455), unmasks text frames, checks each message against
contract v2, and when the time is up feeds every received message, at the time it arrived,
through the V16 TD Python (callback_v3.py, td_py/*.py) under the same stand-in TD globals
as test_td_logic.py, cooking the Script CHOPs at 60 frames a second. It prints a timeline
of what the piece would do, one line per second, and a summary.
"""
import argparse, base64, hashlib, json, math, os, select, socket, struct, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_td_logic as shim          # noqa: E402

GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
V2_KEYS = {'v', 'fs', 'n', 'd1_level', 'd1_ok', 'd2_level', 'd2_ok', 'pair_level', 'd1_w', 'd2_w'}


def handshake(conn):
    data = b''
    while b'\r\n\r\n' not in data:
        chunk = conn.recv(4096)
        if not chunk:
            return None
        data += chunk
    head, rest = data.split(b'\r\n\r\n', 1)
    hdr = {}
    for line in head.decode('latin-1').split('\r\n')[1:]:
        if ':' in line:
            k, v = line.split(':', 1)
            hdr[k.strip().lower()] = v.strip()
    key = hdr.get('sec-websocket-key')
    if not key or hdr.get('upgrade', '').lower() != 'websocket':
        conn.sendall(b'HTTP/1.1 400 Bad Request\r\n\r\n')
        return None
    acc = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    conn.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                  'Sec-WebSocket-Accept: %s\r\n\r\n' % acc).encode())
    return rest


def frames(buf):
    """Parse complete frames from buf; return (list of (opcode, payload, masked), rest)."""
    out = []
    while len(buf) >= 2:
        b1, b2 = buf[0], buf[1]
        n, off = b2 & 0x7F, 2
        if n == 126:
            if len(buf) < 4: break
            n, off = struct.unpack('>H', buf[2:4])[0], 4
        elif n == 127:
            if len(buf) < 10: break
            n, off = struct.unpack('>Q', buf[2:10])[0], 10
        masked = bool(b2 & 0x80)
        mask = buf[off:off + 4] if masked else b''
        off += 4 if masked else 0
        if len(buf) < off + n:
            break
        payload = buf[off:off + n]
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        out.append((b1 & 0x0F, payload, masked, bool(b1 & 0x80)))
        buf = buf[off + n:]
    return out, buf


def serve(port, seconds):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', port))
    srv.listen(4)
    print('listening on ws://127.0.0.1:%d/ for %.0f s' % (port, seconds))
    t0 = time.monotonic()
    clients = {}
    received = []        # (t, text)
    stats = {'frames': 0, 'unmasked': 0, 'nonfinal': 0, 'binary': 0, 'connections': 0}
    while time.monotonic() - t0 < seconds:
        r, _, _ = select.select([srv] + list(clients), [], [], 0.05)
        for s in r:
            if s is srv:
                conn, _ = srv.accept()
                rest = handshake(conn)
                if rest is None:
                    conn.close()
                    continue
                clients[conn] = rest
                stats['connections'] += 1
                continue
            try:
                chunk = s.recv(65536)
            except OSError:
                chunk = b''
            if not chunk:
                clients.pop(s)
                s.close()
                continue
            fs, clients[s] = frames(clients[s] + chunk)
            for opcode, payload, masked, fin in fs:
                stats['frames'] += 1
                stats['unmasked'] += 0 if masked else 1
                stats['nonfinal'] += 0 if fin else 1
                if opcode == 0x1:
                    received.append((time.monotonic() - t0, payload.decode('utf-8')))
                elif opcode == 0x2:
                    stats['binary'] += 1
                elif opcode in (0x8, 0x9):
                    try:
                        s.sendall(b'\x88\x02\x03\xe8' if opcode == 0x8 else bytes([0x8A, len(payload)]) + payload)
                    except OSError:
                        pass
    for c in clients:
        c.close()
    srv.close()
    return received, stats


def through_td(received, duration):
    """Feed the messages through the V16 TD Python as TD would, cooking at 60 fps."""
    Const, OP, Clock = shim.Const, shim.OP, shim.Clock
    eeg = Const(['d1_level', 'd1_ok', 'd2_level', 'd2_ok', 'pair_level'])
    meta = Const(['n', 'last_msg', 'msgs', 'bad_msgs', 'lost_samples'])
    cerr = Const(['contract_error'])
    wave = OP()
    ops = {'eeg': eeg, 'eeg_meta': meta, 'contract_error': cerr, 'wave': wave}
    cb = shim.load('webserver1_callbacks1', ops)
    wv = shim.load('wave_callbacks', ops)
    pl = shim.load('pair_logic_callbacks', {})
    hd = shim.load('heads_callbacks', {})
    hold = {'t': 0, 'hold_s': 0.0, 'gap_s': 1e9}
    hs = hd['new_state']()
    E = 0.0                  # filter18 stand-in: 3 s moving average of 'together'
    hist = []
    frame = 1 / 60.0
    i = 0
    t = 0.0
    lines = []
    samples = 0
    held_events = 0
    prev_held = 0
    while t < duration:
        Clock.seconds = t
        while i < len(received) and received[i][0] <= t:
            cb['onWebSocketReceiveText'](None, 'test', received[i][1])
            i += 1
        wv['onCook'](wave)
        samples += len(wave.chans[0].vals)
        fresh = (t - meta.par.const1value.val) < 2
        v = [getattr(eeg.par, 'const%dvalue' % k).val for k in range(5)]
        d1l, d1ok, d2l, d2ok, pair = v[0] * v[1] * fresh, v[1] * fresh, v[2] * v[3] * fresh, v[3] * fresh, v[4] * fresh
        o = pl['step'](hold, frame, pair, 3.0, 0.0, 1.0)
        hist.append(o['together'])
        hist = hist[-180:]
        E = sum(hist) / len(hist)
        h = hd['step'](hs, frame, E, (d1l, d2l), (d1ok, d2ok))
        if o['held'] and not prev_held:
            held_events += 1
        prev_held = o['held']
        if abs(t - round(t)) < frame / 2:
            lines.append('%5.1f  err %d  stale %d  d1 %.2f/%d  d2 %.2f/%d  pair %.2f  together %d held %d  '
                         'R_ry %6.1f  L_ry %6.1f  sat %.2f/%.2f  wave %+.3f' % (
                             t, cerr.par.const0value.val, 0 if fresh else 1, d1l, d1ok, d2l, d2ok, pair,
                             o['together'], o['held'], h['R_ry'], h['L_ry'], h['d1_sat'], h['d2_sat'],
                             wave.chans[0].vals[-1]))
        t += frame
    return lines, {'msgs': meta.par.const2value.val, 'bad': meta.par.const3value.val,
                   'lost': meta.par.const4value.val, 'wave_samples': samples, 'held_events': held_events}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--port', type=int, default=9000)
    ap.add_argument('--seconds', type=float, default=65)
    a = ap.parse_args()
    received, stats = serve(a.port, a.seconds)
    v2 = bad = keys_bad = 0
    sizes = []
    for _, txt in received:
        try:
            m = json.loads(txt)
        except ValueError:
            bad += 1
            continue
        if m.get('v') == 2 and m.get('fs') == 125:
            v2 += 1
            if set(m) != V2_KEYS or len(m['d1_w']) != 16 or len(m['d2_w']) != 16:
                keys_bad += 1
            sizes.append(len(txt))
        else:
            bad += 1
    print('connections %d, frames %d (unmasked %d, fragmented %d, binary %d)' % (
        stats['connections'], stats['frames'], stats['unmasked'], stats['nonfinal'], stats['binary']))
    print('text messages %d: v2 %d (wrong key set or array length: %d), not v2 %d' % (len(received), v2, keys_bad, bad))
    if sizes:
        span = received[-1][0] - received[0][0]
        print('rate %.2f msg/s over %.1f s, mean size %d bytes' % (len(received) / max(span, 1e-9), span, sum(sizes) / len(sizes)))
    lines, summ = through_td(received, a.seconds)
    print('--- through callback v3 / wave / pair_logic / heads (60 fps, Hold 3 s, Forgiveness 1 s):')
    for l in lines:
        print(l)
    print('summary: eeg_meta msgs %d, bad_msgs %d, lost_samples %d, wave samples %d (%.1f/s), transitions fired %d' % (
        summ['msgs'], summ['bad'], summ['lost'], summ['wave_samples'], summ['wave_samples'] / a.seconds, summ['held_events']))


if __name__ == '__main__':
    main()
