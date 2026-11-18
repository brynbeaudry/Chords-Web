#!/usr/bin/env python3
"""Static checks of an expanded .toe (no TouchDesigner needed).

usage: verify_toe.py <V15.toe.dir> <V15.toe.toc> [<new.toe.dir> <new.toc> [<pyc_out_dir>]]
       (new defaults to touchdesigner/expanded/dual-alpha-V16.toe.*, pyc to a temp dir)

1. .toc <-> .dir consistency
2. every Python DAT compiles (py_compile on the extracted text)
3. every wired input (.n inputs, .network compinputs) names an existing operator
4. every op('...') in an active parameter expression and in a Python DAT resolves,
   compared old vs new (new breakage = regression)
5. every op('X')['chan'] / Select channames resolves to a channel, by channel-name
   inference through the CHOP chain, compared old vs new
6. the Python embedded in the DATs is byte-identical to callback_v3.py and td_py/*.py
"""
import os, re, struct, sys, py_compile, fnmatch

import tempfile
TDDIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLD_D, OLD_T = sys.argv[1:3]
NEW_D = sys.argv[3] if len(sys.argv) > 3 else os.path.join(TDDIR, 'expanded', 'dual-alpha-V16.toe.dir')
NEW_T = sys.argv[4] if len(sys.argv) > 4 else os.path.join(TDDIR, 'expanded', 'dual-alpha-V16.toe.toc')
PYC = sys.argv[5] if len(sys.argv) > 5 else tempfile.mkdtemp(prefix='v16pyc')


def toks(line):
    out, cur, inq, had = [], '', False, False
    for ch in line:
        if ch == '"':
            inq = not inq; had = True
        elif ch == ' ' and not inq:
            if cur or had: out.append(cur)
            cur, had = '', False
        else:
            cur += ch
    if cur or had: out.append(cur)
    return out


class Net:
    def __init__(self, d, toc):
        self.d = d
        self.toc = [l.rstrip('\n') for l in open(toc)]
        self.ops = {}          # path -> dict(type, inputs, parms{name:(flag,val,expr)}, text)
        for l in self.toc:
            if not l.endswith('.n'):
                continue
            path = '/' + l[:-2]
            s = open(os.path.join(d, l)).read()
            typ = s.split('\n', 1)[0]
            m = re.search(r'\ninputs\n\{\n(.*?)\n\}', s, re.S)
            ins = [x.split('\t')[-1] for x in m.group(1).split('\n')] if m else []
            o = {'type': typ, 'inputs': ins, 'parms': {}, 'text': None, 'compinputs': []}
            pf = os.path.join(d, l[:-2] + '.parm')
            if os.path.exists(pf):
                for pl in open(pf).read().split('\n'):
                    if pl in ('?', ''):
                        continue
                    t = toks(pl)
                    if len(t) >= 3 and t[1].lstrip('-').isdigit():
                        o['parms'][t[0]] = (int(t[1]), t[2], t[3] if len(t) > 3 else None)
            tf = os.path.join(d, l[:-2] + '.text')
            if os.path.exists(tf):
                b = open(tf, 'rb').read()
                n = struct.unpack('>I', b[23:27])[0]
                assert b[:3] == b'2\n*' and n == len(b) - 27, tf
                o['text'] = b[27:].decode('utf-8')
            nf = os.path.join(d, l[:-2] + '.network')
            if os.path.exists(nf):
                m = re.search(r'compinputs\n\{\n(.*?)\n\}', open(nf).read(), re.S)
                if m:
                    lines = m.group(1).split('\n')
                    o['compinputs'] = [lines[i].split('\t')[-1] for i in range(0, len(lines), 3)]
            self.ops[path] = o

    def resolve(self, base, ref):
        """op(ref) relative to network base ('/project1/SYNCD')."""
        if ref.startswith('/'):
            p = ref
        else:
            p = base.rstrip('/') + '/' + ref
        parts = []
        for x in p.split('/'):
            if x in ('', '.'):
                continue
            if x == '..':
                parts and parts.pop()
            else:
                parts.append(x)
        p = '/' + '/'.join(parts)
        return p if p in self.ops else None

    def par(self, path, name, default=None):
        v = self.ops[path]['parms'].get(name)
        return default if v is None else v[1]

    # ---- channel-name inference
    def chans(self, path, depth=0):
        if depth > 60 or path not in self.ops:
            return None
        o = self.ops[path]
        typ = o['type']
        net = path.rsplit('/', 1)[0] or '/'
        def inp(i=0):
            if i >= len(o['inputs']):
                return None
            return self.chans(self.resolve(net, o['inputs'][i]), depth + 1)
        if typ == 'CHOP:constant':
            names = [];
            i = 0
            while ('const%dname' % i) in o['parms'] or i < 40:
                v = self.par(path, 'const%dname' % i)
                if v: names.extend(expand(v))
                i += 1
                if i > 60: break
            return names
        if typ == 'CHOP:script':
            t = self.ops.get(net + '/' + self.par(path, 'callbacks', ''), {}).get('text') or ''
            m = re.search(r'^(?:ORDER|CHANS) = \((.*?)\)', t, re.M | re.S)
            return re.findall(r"'([^']+)'", m.group(1)) if m else None
        if typ in ('CHOP:select',):
            src = inp() if o['inputs'] else None
            if src is None and self.par(path, 'chops'):
                r = self.resolve(net, self.par(path, 'chops'))
                src = self.chans(r, depth + 1) if r else None
            if src is None:
                return None
            pat = self.par(path, 'channames', '*')
            sel = [c for c in src if match(pat, c)]
            return rename(sel, self.par(path, 'renamefrom', '*'), self.par(path, 'renameto'))
        if typ == 'CHOP:rename':
            src = inp()
            return None if src is None else rename(src, self.par(path, 'renamefrom', '*'), self.par(path, 'renameto'))
        if typ in ('CHOP:merge', 'CHOP:trail'):
            out = []
            for i in range(len(o['inputs'])):
                c = inp(i)
                if c is None: return None
                out.extend(c)
            return out
        if typ == 'CHOP:math':
            chanop = self.par(path, 'chanop', 'off')
            if len(o['inputs']) > 1 and self.par(path, 'chopop', 'off') == 'off':
                out = []
                for i in range(len(o['inputs'])):
                    c = inp(i)
                    if c is None: return None
                    out.extend(c)
                return out
            c = inp()
            if c is None: return None
            return c[:1] if chanop != 'off' else c
        if typ == 'CHOP:switch':
            idx = self.par(path, 'index', '0')
            try: idx = int(float(idx))
            except ValueError: idx = 0
            return inp(min(idx, len(o['inputs']) - 1))
        if typ == 'CHOP:par':
            return expand(self.par(path, 'renameto', 'v1').split()[0]) if True else None
        if typ == 'CHOP:in':
            return None
        if typ == 'CHOP:out':
            return inp()
        if typ.startswith('CHOP:') and o['inputs']:
            return inp()          # null, filter, lag, limit, speed, trigger, timeslice, audiospect, resample, envelope, logic ...
        if typ.startswith('COMP:'):
            return None
        return None


def expand(pat):
    """'chan[0-24]' / 'v1 v2' -> list of names."""
    out = []
    for w in re.split(r'[ ,]+', pat.strip()):
        if not w: continue
        m = re.match(r'^(.*)\[(\d+)-(\d+)\](.*)$', w)
        if m:
            out.extend('%s%d%s' % (m.group(1), i, m.group(4)) for i in range(int(m.group(2)), int(m.group(3)) + 1))
        else:
            m = re.match(r'^(.*)\[([a-z]+)\](.*)$', w)
            out.extend([m.group(1) + ch + m.group(3) for ch in m.group(2)] if m else [w])
    return out


def match(pat, name):
    for w in re.split(r'[ ,]+', pat.strip()):
        if not w: continue
        for e in expand(w) if '[' in w and '-' in w else [w]:
            if fnmatch.fnmatchcase(name, e): return True
    return False


def rename(names, frm, to):
    if not to:
        return names
    fr = expand(frm) if frm and frm != '*' else None
    tt = expand(to)
    if fr is None:            # '*' -> positional
        return [tt[i] if i < len(tt) else n for i, n in enumerate(names)]
    out = []
    for n in names:
        out.append(tt[fr.index(n)] if n in fr and fr.index(n) < len(tt) else n)
    return out


REF = re.compile(r"""(?<![\w.])op\(\s*(['"])([^'"]+)\1\s*\)(\s*\[\s*(['"])([^'"]+)\4\s*\])?""")


def refs(net):
    """Yield (where, base, ref, chan) for op() refs in active expressions and Python DATs."""
    for path, o in net.ops.items():
        base = path.rsplit('/', 1)[0] or '/'
        for pn, (flag, val, ex) in o['parms'].items():
            if ex and flag & 1:
                for m in REF.finditer(ex):
                    yield ('%s.par.%s' % (path, pn), base, m.group(2), m.group(5))
        if o['text'] and o['parms'].get('language', (0, ''))[1] == 'python':
            for m in REF.finditer(o['text']):
                yield ('%s (script)' % path, base, m.group(2), m.group(5))


def script_refs(net):
    """Indirect references in the V16 Python DATs: _set/_get('name', i), STATE/CONTROLS paths
    with the channels/controls read from them, and scriptOp storage keys shared across DATs."""
    out = []
    for path, o in net.ops.items():
        t = o['text']
        if not t or o['parms'].get('language', (0, ''))[1] != 'python':
            continue
        base = path.rsplit('/', 1)[0] or '/'
        for m in re.finditer(r"_(set|get)\('(\w+)', (\d+)", t):
            out.append(('%s (script %s)' % (path, m.group(1)), base, m.group(2), ('#const%s' % m.group(3))))
        m = re.search(r"^STATE = '([^']+)'", t, re.M)
        if m:
            for c in sorted(set(re.findall(r"_chan\(s, '(\w+)'\)", t))):
                out.append(('%s (script STATE)' % path, base, m.group(1), c))
        m = re.search(r"^CONTROLS = '([^']+)'", t, re.M)
        d = re.search(r"^DEFAULTS = \{(.*?)\}", t, re.M)
        if m and d:
            for k in re.findall(r"'(\w+)':", d.group(1)):
                out.append(('%s (script CONTROLS)' % path, base, m.group(1) + k, None))
    return out


def check_net(net, label):
    res = {}
    for where, base, ref, ch in script_refs(net):
        target = net.resolve(base, ref)
        if target is None:
            res[(where, ref, ch)] = 'missing op'
        elif ch and ch.startswith('#const'):
            i = int(ch[6:])
            res[(where, ref, ch)] = 'ok' if net.par(target, 'const%dvalue' % i) is not None and net.par(target, 'const%dname' % i) else 'missing const%d' % i
        elif ch:
            cs = net.chans(target)
            res[(where, ref, ch)] = 'channels unknown' if cs is None else ('ok' if ch in cs else 'missing channel')
        else:
            res[(where, ref, ch)] = 'ok'
    for where, base, ref, ch in refs(net):
        target = net.resolve(base, ref)
        if target is None:
            res[(where, ref, ch)] = 'missing op'
            continue
        if ch:
            cs = net.chans(target)
            if cs is None:
                res[(where, ref, ch)] = 'channels unknown'
            elif ch not in cs:
                res[(where, ref, ch)] = 'missing channel (has %s)' % ','.join(cs[:8])
            else:
                res[(where, ref, ch)] = 'ok'
        else:
            res[(where, ref, ch)] = 'ok'
    for path, o in net.ops.items():
        if o['type'] == 'CHOP:select' and (o['inputs'] or net.par(path, 'chops')):
            cs = net.chans(path)
            key = (path + '.par.channames', net.par(path, 'channames', '*'), None)
            res[key] = 'channels unknown' if cs is None else ('ok' if cs else 'selects nothing')
    return res


def main():
    fails = 0
    old, new = Net(OLD_D, OLD_T), Net(NEW_D, NEW_T)
    # 1 toc <-> dir
    files = set()
    for root, ds, fs in os.walk(NEW_D):
        for f in fs:
            files.add(os.path.relpath(os.path.join(root, f), NEW_D))
    toc = set(new.toc)
    print('[1] toc entries %d, files %d, in toc not on disk %d, on disk not in toc %d, duplicate toc lines %d'
          % (len(new.toc), len(files), len(toc - files), len(files - toc), len(new.toc) - len(toc)))
    fails += len(toc - files) + len(files - toc) + len(new.toc) - len(toc)
    # 2 python DATs compile
    os.makedirs(PYC, exist_ok=True)
    n_ok = 0; bad = []
    for path, o in sorted(new.ops.items()):
        if o['text'] is not None and o['parms'].get('language', (0, ''))[1] == 'python':
            fn = os.path.join(PYC, path.strip('/').replace('/', '__') + '.py')
            open(fn, 'w').write(o['text'])
            try:
                py_compile.compile(fn, doraise=True); n_ok += 1
            except py_compile.PyCompileError as e:
                bad.append((path, str(e).splitlines()[-1]))
    print('[2] python DATs compiled: %d ok, %d failed %s' % (n_ok, len(bad), bad))
    fails += len(bad)
    # 3 wired inputs
    miss = []
    for path, o in new.ops.items():
        base = path.rsplit('/', 1)[0] or '/'
        for i in o['inputs'] + o['compinputs']:
            if new.resolve(base, i) is None:
                miss.append((path, i))
    print('[3] wired inputs: %d checked, unresolved %s' % (sum(len(o['inputs']) + len(o['compinputs']) for o in new.ops.values()), miss))
    fails += len(miss)
    # 4/5 references
    ro, rn = check_net(old, 'V15'), check_net(new, 'V16')
    regress = {k: v for k, v in rn.items() if v != 'ok' and v != 'channels unknown' and ro.get(k) in (None, 'ok', 'channels unknown')}
    pre = {k: v for k, v in rn.items() if v != 'ok' and k in ro and ro[k] == v}
    new_ok = sum(1 for k, v in rn.items() if v == 'ok' and k not in ro)
    unk = {k: v for k, v in rn.items() if v == 'channels unknown' and k not in ro}
    print('[4/5] references: V16 %d (%d ok), V15 %d; new refs in V16 resolved ok: %d' %
          (len(rn), sum(v == 'ok' for v in rn.values()), len(ro), new_ok))
    print('      regressions (resolved in V15 or new, broken in V16): %d' % len(regress))
    for k, v in sorted(regress.items()): print('        ', k, v)
    print('      new refs whose channels could not be inferred: %d' % len(unk))
    for k, v in sorted(unk.items()): print('        ', k, v)
    print('      pre-existing unresolved in V15, unchanged in V16: %d' % len(pre))
    for k, v in sorted(pre.items()): print('        ', k, v)
    gone = [k for k in ro if k not in rn]
    print('      V15 refs no longer present (their operators were deleted or re-pointed): %d' % len(gone))
    for k in sorted(gone): print('        ', k, ro[k])
    fails += len(regress)
    # spot list: the refs this change touched
    print('[5] channel refs on the re-pointed paths:')
    for k in sorted(rn):
        if any(s in k[0] for s in ('transform5', 'transform6', 'switch1.par.index', 'math22', 'math28', 'okgrey',
                                   'text1.par', 'status_label', 'state_calc', 'ts_clock', 'callbacks', 'SYNCD/select1',
                                   'select5', 'select6', 'select8', 'select9', 'select10', 'select11', 'select12', 'select13',
                                   'select14', 'select15', 'select18', 'select2.', 'select3', 'select4', 'sel_', '(script')):
            print('        %-75s %-60s %s' % (k[0], '%s %s' % (k[1], k[2] or ''), rn[k]))
    # 6 embedded Python == repo sources
    pairs = (('/project1/SYNCD/container1websocket_example/webserver1_callbacks1', 'callback_v3.py'),
             ('/project1/SYNCD/container1websocket_example/wave_callbacks', 'td_py/wave_callbacks.py'),
             ('/project1/SYNCD/pair_logic_callbacks', 'td_py/pair_logic_callbacks.py'),
             ('/project1/SYNCD/heads_callbacks', 'td_py/heads_callbacks.py'))
    for path, rel in pairs:
        same = new.ops.get(path, {}).get('text') == open(os.path.join(TDDIR, rel)).read()
        print('[6] %-66s == %-28s %s' % (path, rel, 'identical' if same else 'DIFFERENT'))
        fails += 0 if same else 1
    print('FAILURES:', fails)
    return fails


sys.exit(1 if main() else 0)
