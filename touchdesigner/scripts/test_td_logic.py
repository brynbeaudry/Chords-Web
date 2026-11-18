"""Offline test of the V16 TD Python (callback v3, wave, pair_logic, heads) with a
minimal stand-in for the TouchDesigner globals (op, absTime, CookLevel, me, OP storage,
Constant CHOP pars, Script CHOP channels). Proves the logic, not TouchDesigner's API.

usage: python3 test_td_logic.py      (exit 0 when every check passes)"""
import json, math, os, sys, types, random

HERE = os.path.dirname(os.path.abspath(__file__))
TD = os.path.dirname(HERE)          # touchdesigner/


class Par:
    def __init__(self, v=0.0): self.val = v
    def eval(self): return self.val


class Pars:
    def __init__(self, names):
        for n in names: setattr(self, n, Par())


class Chan:
    def __init__(self, name, n): self.name = name; self.vals = [0.0] * n
    def __setitem__(self, i, v): self.vals[i] = v
    def __getitem__(self, i): return self.vals[i]
    def eval(self): return self.vals[-1]


class OP:
    def __init__(self, parnames=()):
        self.par = Pars(parnames); self.storage = {}; self.chans = []
        self.rate = 60; self.isTimeSlice = False; self.numSamples = 1; self.inputs = []
    def fetch(self, k, d=None, search=True, storeDefault=False): return self.storage.get(k, d)
    def store(self, k, v): self.storage[k] = v; return v
    def clear(self): self.chans = []; self.rate = 60
    def appendChan(self, name): c = Chan(name, self.numSamples); self.chans.append(c); return c
    def chan(self, name):
        for c in self.chans:
            if c.name == name: return c
        return None
    @property
    def numChans(self): return len(self.chans)
    def __getitem__(self, i): return self.chans[i] if isinstance(i, int) else self.chan(i)


class Const(OP):
    """Constant CHOP: const{i}value pars; chan(name) reads them."""
    def __init__(self, names):
        super().__init__(['const%dvalue' % i for i in range(len(names))])
        self.names = names
    def chan(self, name):
        i = self.names.index(name); c = Chan(name, 1); c.vals = [getattr(self.par, 'const%dvalue' % i).val]; return c


class Clock:
    seconds = 0.0


def load(name, ops):
    rel = 'callback_v3.py' if name == 'webserver1_callbacks1' else os.path.join('td_py', name + '.py')
    src = open(os.path.join(TD, rel)).read()
    g = {'__name__': name, 'op': lambda p: ops.get(p), 'absTime': Clock,
         'CookLevel': types.SimpleNamespace(ALWAYS=3), 'me': types.SimpleNamespace(time=types.SimpleNamespace(rate=60))}
    exec(compile(src, name, 'exec'), g)
    return g


def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: check.failed += 1
check.failed = 0


def receiver_and_wave():
    eeg = Const(['d1_level', 'd1_ok', 'd2_level', 'd2_ok', 'pair_level'])
    meta = Const(['n', 'last_msg', 'msgs', 'bad_msgs', 'lost_samples'])
    cerr = Const(['contract_error'])
    wave = OP()
    ops = {'eeg': eeg, 'eeg_meta': meta, 'contract_error': cerr, 'wave': wave}
    cb = load('webserver1_callbacks1', ops)
    wv = load('wave_callbacks', ops)
    # synthetic stream: a sample counter as the waveform, so order/gaps are visible
    sent = []
    out = []
    n = 1000
    t = 0.0
    next_msg = 0.0
    drop = {20, 21}             # lose two messages
    stop_at = 6.0               # stream stops at 6 s
    frame = 1 / 60.0
    while t < 8.0:
        Clock.seconds = t
        while next_msg <= t and next_msg < stop_at:
            k = int(round(next_msg / 0.128))
            msg = {'v': 2, 'fs': 125, 'n': n, 'd1_level': 0.5, 'd1_ok': 1, 'd2_level': 0, 'd2_ok': 1,
                   'pair_level': 0, 'd1_w': [float(n + i) for i in range(16)], 'd2_w': [-float(n + i) for i in range(16)]}
            if k not in drop:
                cb['onWebSocketReceiveText'](None, 'c', json.dumps(msg))
            sent.extend(range(n, n + 16))
            n += 16
            next_msg += 0.128
        wv['onCook'](wave)
        out.append((t, wave.rate, wave.isTimeSlice, list(wave.chans[0].vals), list(wave.chans[1].vals)))
        t += frame
    total = sum(len(o[3]) for o in out)
    check(all(o[1] == 125 and o[2] for o in out), 'wave outputs rate 125, time sliced, every cook')
    check(abs(total - 8.0 * 125) <= 3, 'wave emits 125 samples per second (got %d in 8 s)' % total)
    check(all(len(o[3]) >= 1 for o in out), 'every cook outputs at least one sample')
    seq = [v for o in out if 1.5 < o[0] < 2.4 for v in o[3]]   # before the dropped messages
    diffs = [b - a for a, b in zip(seq, seq[1:])]
    check(all(d in (0.0, 1.0, 2.0) for d in diffs) and diffs.count(1.0) > 0.9 * len(diffs),
          'steady state: consecutive samples in order (repeat/skip only from drift correction)')
    # delay: at t=2.0 the newest sample sent so far vs the sample being played
    o = min(out, key=lambda o: abs(o[0] - 2.0))
    newest = 1000 + 16 * int(2.0 / 0.128 + 1) - 1
    delay_s = (newest - o[3][-1]) / 125.0
    check(0.24 <= delay_s <= 0.39, 'play-out delay behind newest received sample in 0.25-0.38 s (got %.3f s)' % delay_s)
    ds = []
    for o in out:
        if 1.5 < o[0] < 2.4:
            nw = 1000 + 16 * (int(o[0] / 0.128) + 1) - 1
            ds.append((nw - o[3][-1]) / 125.0)
    check(min(ds) >= 0.23 and max(ds) <= 0.40, 'delay over 0.9 s stays within %.3f-%.3f s' % (min(ds), max(ds)))
    check(meta.par.const4value.val == 32, 'two lost messages counted as 32 lost samples (got %s)' % meta.par.const4value.val)
    gapseg = [v for o in out if 2.4 < o[0] < 3.4 for v in o[3]]
    check(any(b == a for a, b in zip(gapseg, gapseg[1:])), 'gap in n: last sample held (repeats present)')
    check(all(b >= a for a, b in zip(gapseg, gapseg[1:])), 'gap in n: no jump backwards')
    tail = [v for o in out if o[0] > 6.6 for v in o[3]]
    check(set(tail) == {1751.0}, 'stream stopped: output holds the last sample sent (%s)' % sorted(set(tail))[:3])
    check(all(a == -b for o in out for a, b in zip(o[3], o[4])), 'd2_w carried alongside d1_w')
    check(eeg.par.const0value.val == 0.5 and eeg.par.const1value.val == 1, 'eeg values written to const0value..')
    check(abs(meta.par.const1value.val - 5.888) < 0.1, 'eeg_meta last_msg = time of last message')
    check(cerr.par.const0value.val == 0, 'contract_error 0 on v2')
    # v1 message from /dual-stream
    v1 = {'ts': 1167960, 'd1_ch0': -0.39, 'd1_ch1': 1.3, 'd1_ch2': 0.5, 'd2_ch0': 0, 'd2_ch1': 0, 'd2_ch2': 0}
    cb['onWebSocketReceiveText'](None, 'c', json.dumps(v1))
    check(cerr.par.const0value.val == 1, 'v1 message lights contract_error')
    check(eeg.par.const0value.val == 0.5, 'v1 message takes no values')
    cb['onWebSocketReceiveText'](None, 'c', '{not json')
    check(cerr.par.const0value.val == 1 and meta.par.const3value.val == 2, 'bad JSON lights contract_error, counted')
    cb['onWebSocketReceiveText'](None, 'c', json.dumps({'v': 2, 'fs': 250, 'n': 0}))
    check(meta.par.const3value.val == 3, 'wrong fs refused')
    cb['onWebSocketReceiveText'](None, 'c', json.dumps({'v': 2, 'fs': 125, 'n': n, 'd1_level': 0.1, 'd1_ok': 1,
        'd2_level': 0, 'd2_ok': 0, 'pair_level': 0, 'd1_w': [1] * 16, 'd2_w': [None] * 16}))
    check(cerr.par.const0value.val == 0, 'next valid v2 message clears contract_error')
    check(wave.storage['ring']['d2_w'][-1] == wave.storage['ring']['d2_w'][-17], 'null samples hold the last good value')
    # restart of the app: n jumps back to 0 -> ring restarts
    cb['onWebSocketReceiveText'](None, 'c', json.dumps({'v': 2, 'fs': 125, 'n': 0, 'd1_level': 0, 'd1_ok': 1,
        'd2_level': 0, 'd2_ok': 1, 'pair_level': 0, 'd1_w': [7] * 16, 'd2_w': [7] * 16}))
    r = wave.storage['ring']
    check(r['first'] == 0 and r['next'] == 16 and len(r['d1_w']) == 16, 'app restart (n back to 0) restarts the ring')
    check(len(r['d1_w']) <= 250, 'ring is at most 2 s')


def pair_and_heads():
    pl = load('pair_logic_callbacks', {})
    hd = load('heads_callbacks', {})
    st = {'t': 0, 'hold_s': 0.0, 'gap_s': 1e9}
    dt = 1 / 60.0
    # pair up 0-2 s, blink 0.5 s, up again 2.5-6 s; hold 3, forgiveness 1
    held_at = None; t = 0.0
    while t < 6.0:
        p = 0.0 if 2.0 <= t < 2.5 else 0.4
        o = pl['step'](st, dt, p, 3.0, 0.0, 1.0)
        if o['held'] and held_at is None: held_at = t
        t += dt
    check(held_at is not None and 3.4 < held_at < 3.6, 'blink shorter than Forgiveness pauses the count: held at %.2f s' % held_at)
    st = {'t': 0, 'hold_s': 0.0, 'gap_s': 1e9}; held_at = None; t = 0.0
    while t < 8.0:
        p = 0.0 if 2.0 <= t < 3.5 else 0.4
        o = pl['step'](st, dt, p, 3.0, 0.0, 1.0)
        if o['held'] and held_at is None: held_at = t
        t += dt
    check(held_at is not None and 6.4 < held_at < 6.6, 'drop longer than Forgiveness restarts the count: held at %.2f s' % held_at)
    st = {'t': 0, 'hold_s': 0.0, 'gap_s': 1e9}
    o = pl['step'](st, dt, 0.0, 0.0, 0.0, 1.0)
    check(o['together'] == 1 and o['held'] == 1 and o['forced'] == 1, 'Hold time 0 forces together and held with no data')
    st = {'t': 0, 'hold_s': 0.0, 'gap_s': 1e9}
    for _ in range(600): o = pl['step'](st, dt, 0.3, 3.0, 0.5, 1.0)
    check(o['together'] == 0 and o['held'] == 0, 'pair_level below Relative alpha sync does not count')
    # heads
    hs = hd['new_state']()
    o = hd['step'](hs, dt, 0.0, (0.0, 0.0), (1, 1))
    check(abs(o['R_ry'] - 45) < 1e-6 and abs(o['L_ry'] + 45) < 1e-6, 'rest: R ry +45, L ry -45 (as V15 apart)')
    angles = []
    for i in range(int(20 / dt)):
        o = hd['step'](hs, dt, 0.0, (0.6, 0.0), (1, 1)); angles.append(o['d1_angle'])
    check(abs(angles[int(3 / dt)] - 0) < 8, 'one in: person 1 near forward after ~3 s (%.1f deg)' % angles[int(3 / dt)])
    mn = min(angles[int(8 / dt):])
    check(-12 - 8 * 0.6 - 0.5 <= mn <= -10, 'one in: reach toward the other up to about -(12 + 8 x level) (min %.1f)' % mn)
    mx = max(angles[int(9 / dt):])
    check(mx > -6, 'one in: dips back toward forward between reaches (max after 9 s %.1f)' % mx)
    check(abs(o['L_ry'] + 45) < 1e-6, 'one in: the other head stays turned away')
    check(abs(o['d1_calm'] - (1 - 0.7 * 0.6)) < 0.01 and o['d2_calm'] == 1.0, 'calm = 1 - 0.7 level per person')
    for i in range(int(10 / dt)):
        o = hd['step'](hs, dt, 1.0, (0.8, 0.4), (1, 1))
    check(abs(o['d1_angle'] - (-24)) < 0.1 and abs(o['d2_angle'] - (-20)) < 0.1,
          'both in (E=1): -20, the deeper one (lead 0.4) -24 (got %.1f, %.1f)' % (o['d1_angle'], o['d2_angle']))
    check(o['R_ry'] < 0 and o['L_ry'] > 0, 'both in: R ry negative, L ry positive (toward each other)')
    check(abs(o['d1_colormult'] - 1.2) < 0.01 and o['d2_colormult'] == 1.0, 'deeper head colour speed x(1+0.5 lead)')
    for i in range(int(6 / dt)):
        o = hd['step'](hs, dt, 0.0, (0.0, 0.0), (0, 1))
    check(o['d1_sat'] < 0.01 and o['d2_sat'] > 0.99 and abs(o['d1_angle'] - 45) < 0.5,
          'ok = 0: that side grey and turned away')


def jitter():
    """Messages arrive up to 200 ms late, in order (WebSocket over TCP): playback stays continuous."""
    eeg = Const(['d1_level', 'd1_ok', 'd2_level', 'd2_ok', 'pair_level'])
    meta = Const(['n', 'last_msg', 'msgs', 'bad_msgs', 'lost_samples'])
    cerr = Const(['contract_error']); wave = OP()
    ops = {'eeg': eeg, 'eeg_meta': meta, 'contract_error': cerr, 'wave': wave}
    cb = load('webserver1_callbacks1', ops); wv = load('wave_callbacks', ops)
    rnd = random.Random(1)
    sched = []
    n = 0
    last = 0.0
    for k in range(80):       # TCP keeps order: a late message delays the ones behind it
        last = max(last, k * 0.128 + rnd.uniform(0, 0.2)); sched.append((last, n)); n += 16
    t = 0.0; out = []; i = 0
    while t < 10.0:
        Clock.seconds = t
        while i < len(sched) and sched[i][0] <= t:
            nn = sched[i][1]
            cb['onWebSocketReceiveText'](None, 'c', json.dumps({'v': 2, 'fs': 125, 'n': nn, 'd1_level': 0, 'd1_ok': 1,
                'd2_level': 0, 'd2_ok': 1, 'pair_level': 0, 'd1_w': [float(nn + j) for j in range(16)], 'd2_w': [0.0] * 16}))
            i += 1
        wv['onCook'](wave); out.append((t, list(wave.chans[0].vals))); t += 1 / 60.0
    seq = [v for o in out if 2.0 < o[0] < 9.5 for v in o[1]]
    d = [b - a for a, b in zip(seq, seq[1:])]
    holds = d.count(0.0); back = sum(1 for x in d if x < 0)
    check(back == 0, 'jitter up to 200 ms: never plays backwards')
    check(holds <= 0.03 * len(d), 'jitter up to 200 ms: holds/repeats <= 3%% of samples (%d of %d)' % (holds, len(d)))


if __name__ == '__main__':
    receiver_and_wave()
    jitter()
    pair_and_heads()
    print('failed:', check.failed)
    sys.exit(1 if check.failed else 0)
