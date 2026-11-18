#!/usr/bin/env python3
"""Build dual-alpha-V16.toe.dir/.toc from Kaz's V15 expanded with toeexpand.

usage: build_v16_from_v15.py <V15.toe.dir> <V15.toe.toc> <out_dir> [<touchdesigner_dir>]
Writes <out_dir>/dual-alpha-V16.toe.dir and <out_dir>/dual-alpha-V16.toe.toc; then
scripts/td-collapse.sh turns them into the .toe. V15 itself is not in the repo
(20260108_Iterface2V15_Otherworld.toe from TD.zip): expand it with toeexpand first.
The Python embedded in the DATs is read from callback_v3.py and td_py/*.py, so those
files are the source of truth. Every change V15 -> V16 is in this file;
TD_CHANGES.md describes the same steps for a person working in TouchDesigner.
"""
import os, re, shutil, struct, sys

SRC_DIR, SRC_TOC, OUT = sys.argv[1:4]
TDDIR = sys.argv[4] if len(sys.argv) > 4 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = 'dual-alpha-V16.toe'
D = os.path.join(OUT, NAME + '.dir')
TOC = os.path.join(OUT, NAME + '.toc')

if os.path.exists(D):
    shutil.rmtree(D)
shutil.copytree(SRC_DIR, D)
toc = [l.rstrip('\n') for l in open(SRC_TOC)]

WS = 'project1/SYNCD/container1websocket_example'
SY = 'project1/SYNCD'
CT = 'controls'
GREY = '0.67 0.67 0.67'
NEW = '0.3 0.5 0.75'          # new operators are tinted blue so they stand out in the network

# ---------------------------------------------------------------- helpers

def p(rel):
    return os.path.join(D, rel)


def toc_add(rel, after_prefix):
    """Insert rel after the last toc line starting with after_prefix."""
    if rel in toc:
        return
    idx = max(i for i, l in enumerate(toc) if l.startswith(after_prefix))
    toc.insert(idx + 1, rel)


def write(rel, data, after_prefix):
    path = p(rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = 'wb' if isinstance(data, bytes) else 'w'
    with open(path, mode) as f:
        f.write(data)
    toc_add(rel, after_prefix)


def text_bytes(text):
    """TD .text file: '2\\n*' + six big-endian uint32 (1,1,1,1,2,len) + UTF-8 text.
    Verified against all 404 .text files in V15 and the bundled snippets."""
    b = text.encode('utf-8')
    return b'2\n*' + struct.pack('>6I', 1, 1, 1, 1, 2, len(b)) + b


def node(optype, tile, inputs=(), color=GREY, flags='flags =  parlanguage 0', extra=()):
    s = '%s\ntile %d %d %d %d\n%s\n' % ((optype,) + tuple(tile) + (flags,))
    if inputs:
        s += 'inputs\n{\n' + ''.join('%d \t%s\n' % (i, n) for i, n in enumerate(inputs)) + '}\n'
    s += 'color %s \n' % color
    for e in extra:
        s += e + '\n'
    return s + 'end\n'


def parm(lines):
    return '?\n' + ''.join(l + '\n' for l in lines) + '?\n'


def q(s):
    """Quote a .parm token like TD does: bare if no spaces, else double-quoted."""
    s = str(s)
    assert '"' not in s and '\\' not in s and '\n' not in s, s
    return s if (s and ' ' not in s) else '"%s"' % s


def expr(name, cached, expression):
    return '%s 17 %s %s' % (name, q(cached), q(expression))


def add_op(net, name, optype, tile, inputs=(), parms=None, text=None, extra=(), color=NEW):
    base = '%s/%s' % (net, name)
    write(base + '.n', node(optype, tile, inputs, color=color, extra=extra), net + '/')
    if parms is not None:
        write(base + '.parm', parm(parms), net + '/')
    if text is not None:
        write(base + '.text', text_bytes(text), net + '/')


def delete_op(net, name):
    base = '%s/%s' % (net, name)
    hits = [l for l in toc if l == base or l.startswith(base + '.') or l.startswith(base + '/')]
    assert any(l == base + '.n' for l in hits), 'no such op ' + base
    for l in hits:
        toc.remove(l)
    for fn in os.listdir(p(net)):
        if fn.split('.')[0] == name:
            fp = p(net + '/' + fn)
            shutil.rmtree(fp) if os.path.isdir(fp) else os.remove(fp)


def set_inputs(net, name, inputs):
    path = p('%s/%s.n' % (net, name))
    s = open(path).read()
    block = 'inputs\n{\n' + ''.join('%d \t%s\n' % (i, n) for i, n in enumerate(inputs)) + '}\n'
    s2, k = re.subn(r'inputs\n\{\n.*?\}\n', block, s, flags=re.S)
    assert k == 1, path
    open(path, 'w').write(s2)


def set_parm(net, name, line):
    """Replace the line for this parameter (first token) or add it before the closing '?'."""
    path = p('%s/%s.parm' % (net, name))
    lines = open(path).read().split('\n')
    key = line.split(' ', 1)[0]
    for i, l in enumerate(lines):
        if l.split(' ', 1)[0] == key and i > 0:
            lines[i] = line
            break
    else:
        last = max(i for i, l in enumerate(lines) if l == '?')
        lines.insert(last, line)
    open(path, 'w').write('\n'.join(lines))


def set_text(net, name, text):
    open(p('%s/%s.text' % (net, name)), 'wb').write(text_bytes(text))


def pysrc(fn):
    rel = 'callback_v3.py' if fn == 'webserver1_callbacks1.py' else os.path.join('td_py', fn)
    return open(os.path.join(TDDIR, rel)).read()


def copy_comp(net, src, dst, parm_edit, panel_edit, tile=None):
    """Copy a panel COMP (and its children) under a new name, then edit its parms/panel."""
    for l in [l for l in toc if l == '%s/%s.n' % (net, src) or l.startswith('%s/%s.' % (net, src))
              or l.startswith('%s/%s/' % (net, src))]:
        new = '%s/%s' % (net, dst) + l[len('%s/%s' % (net, src)):]
        os.makedirs(os.path.dirname(p(new)), exist_ok=True)
        shutil.copyfile(p(l), p(new))
        toc_add(new, net + '/')
    if tile:
        path = p('%s/%s.n' % (net, dst))
        s = open(path).read()
        s = re.sub(r'^tile (-?\d+) (-?\d+) ', 'tile %d %d ' % tile, s, flags=re.M)
        open(path, 'w').write(s)
    path = p('%s/%s.parm' % (net, dst))
    s = open(path).read()
    for a, b in parm_edit:
        assert a in s, (a, path)
        s = s.replace(a, b)
    open(path, 'w').write(s)
    path = p('%s/%s.panel' % (net, dst))
    s = open(path).read()
    for a, b in panel_edit:
        assert a in s, (a, path)
        s = s.replace(a, b)
    open(path, 'w').write(s)


FRESH = "absTime.seconds - float(op('eeg_meta')['last_msg']) < 2"

# ---------------------------------------------------------------- 1. receiver container

# callback v3 replaces the v1 callback (same DAT, same name: webserver1 keeps pointing at it)
set_text(WS, 'webserver1_callbacks1', pysrc('webserver1_callbacks1.py'))

# the 25-slot plumbing that only the old callback wrote
delete_op(WS, 'constant_eeg')
delete_op(WS, 'null')
delete_op(WS, 'fileout1')

add_op(WS, 'eeg', 'CHOP:constant', (50, -300, 130, 90), parms=[
    'const0name 0 d1_level', 'const0value 0 0',
    'const1name 0 d1_ok', 'const1value 0 0',
    'const2name 0 d2_level', 'const2value 0 0',
    'const3name 0 d2_ok', 'const3value 0 0',
    'const4name 0 pair_level', 'const4value 0 0'])
add_op(WS, 'eeg_meta', 'CHOP:constant', (50, -75, 130, 90), parms=[
    'const0name 0 n', 'const0value 0 0',
    'const1name 0 last_msg', 'const1value 0 0',
    'const2name 0 msgs', 'const2value 0 0',
    'const3name 0 bad_msgs', 'const3value 0 0',
    'const4name 0 lost_samples', 'const4value 0 0'])
add_op(WS, 'contract_error', 'CHOP:constant', (50, -500, 130, 90), parms=[
    'const0name 0 contract_error', 'const0value 0 0'])

# STATE: the five values, gated by freshness (no message for 2 s -> both not ok, levels 0)
add_op(WS, 'state_calc', 'CHOP:constant', (300, -400, 130, 90), parms=[
    'const0name 0 d1_level', expr('const0value', 0, "float(op('eeg')['d1_level']) * float(op('eeg')['d1_ok']) * (%s)" % FRESH),
    'const1name 0 d1_ok', expr('const1value', 0, "float(op('eeg')['d1_ok']) * (%s)" % FRESH),
    'const2name 0 d2_level', expr('const2value', 0, "float(op('eeg')['d2_level']) * float(op('eeg')['d2_ok']) * (%s)" % FRESH),
    'const3name 0 d2_ok', expr('const3value', 0, "float(op('eeg')['d2_ok']) * (%s)" % FRESH),
    'const4name 0 pair_level', expr('const4value', 0, "float(op('eeg')['pair_level']) * (%s)" % FRESH),
    'const5name 0 stale', expr('const5value', 1, "0 if %s else 1" % FRESH),
    'const6name 0 age', expr('const6value', 0, "absTime.seconds - float(op('eeg_meta')['last_msg'])"),
    'const7name 0 contract_error', expr('const7value', 0, "float(op('contract_error')['contract_error'])")])
add_op(WS, 'STATE', 'CHOP:null', (550, -400, 130, 90), inputs=['state_calc'])

# ts replacement for SYNCD/out1 (project1 slope1 -> logic1 -> timer1 switches scenes when
# the value stops changing): a clock that runs while messages arrive and freezes 2 s after
# the last one. It takes the old path rename1 -> switch1 -> timeslice1 -> select3 -> out3.
add_op(WS, 'ts_clock', 'CHOP:constant', (50, 100, 130, 90), parms=[
    'const0name 0 ts',
    expr('const0value', 0, "(absTime.seconds * 125) %% 1000000 if %s else (float(op('eeg_meta')['last_msg']) * 125) %% 1000000" % FRESH)])
set_inputs(WS, 'rename1', ['ts_clock'])

# wave: the 125 Hz play-out, then fanned out to the six old slot names so every existing
# consumer (limit1, audiospect1_FreqCalc, resample1, trail1 -> SYNCD selects) keeps reading
# chan1..chan6: chan1-3 = person 1's waveform, chan4-6 = person 2's.
add_op(WS, 'wave_callbacks', 'DAT:text', (1000, -950, 130, 90), parms=['language 0 python'],
       text=pysrc('wave_callbacks.py'), extra=['dock wave'])
add_op(WS, 'wave', 'CHOP:script', (1000, -700, 130, 90), parms=['callbacks 0 wave_callbacks'])
for i, (a, b) in enumerate((('chan1', 'chan4'), ('chan2', 'chan5'), ('chan3', 'chan6'))):
    add_op(WS, 'wave_slot%d' % (i + 1), 'CHOP:rename', (1300, -550 - 150 * i, 130, 90), inputs=['wave'],
           parms=['renamefrom 0 "d1_w d2_w"', 'renameto 0 "%s %s"' % (a, b)])
add_op(WS, 'wave_slots', 'CHOP:merge', (1600, -700, 130, 90),
       inputs=['wave_slot1', 'wave_slot2', 'wave_slot3'])
set_inputs(WS, 'null1', ['wave_slots'])

# Audio Spectrum on a real 125 Hz series: FFT 128 = 1.02 s window (V15: 64 at ~60/s, ~1 s)
set_parm(WS, 'audiospect1_FreqCalc', 'fftsize 0 128')

# the pair, named inside the file
add_op(WS, 'compat_info', 'DAT:text', (-350, -300, 230, 90), parms=['language 0 text'],
       text='contract v2 · app 2.7.0a · /dual-alpha\n')

# ---------------------------------------------------------------- 2. SYNCD: pair logic, heads, calm, grey

# the waveform comparison and the Sync Trigger slider go; filter18, trigger3, Ftransition,
# switch1 and the Frotateposition nulls stay
for name in ('select16', 'select17', 'filter15', 'filter16', 'math13', 'math14', 'math18',
             'logic1', 'math19', 'math23', 'Sync_Trigger', 'math15', 'math16', 'math17'):
    delete_op(SY, name)

add_op(SY, 'pair_logic_callbacks', 'DAT:text', (5250, 1250, 130, 90), parms=['language 0 python'],
       text=pysrc('pair_logic_callbacks.py'), extra=['dock pair_logic'])
add_op(SY, 'pair_logic', 'CHOP:script', (5450, 1025, 130, 90), parms=['callbacks 0 pair_logic_callbacks'])
add_op(SY, 'sel_together', 'CHOP:select', (5700, 1025, 130, 90), inputs=['pair_logic'],
       parms=['channames 0 together', 'renamefrom 0 together', 'renameto 0 chan5'])
set_inputs(SY, 'filter18', ['sel_together'])
add_op(SY, 'sel_held', 'CHOP:select', (5600, 1300, 130, 90), inputs=['pair_logic'],
       parms=['channames 0 held', 'renamefrom 0 held', 'renameto 0 chan5'])
set_inputs(SY, 'trigger3', ['sel_held'])
set_parm(SY, 'trigger3', 'threshup 0 0.5')
set_parm(SY, 'trigger3', 'threshold 0 on')     # release at the same 0.5, so it re-arms when held drops

add_op(SY, 'heads_callbacks', 'DAT:text', (6000, 600, 130, 90), parms=['language 0 python'],
       text=pysrc('heads_callbacks.py'), extra=['dock heads'])
add_op(SY, 'heads', 'CHOP:script', (6150, 800, 130, 90), inputs=['filter18'],
       parms=['callbacks 0 heads_callbacks'])
add_op(SY, 'sel_rotR', 'CHOP:select', (6200, 1000, 130, 90), inputs=['heads'],
       parms=['channames 0 R_ry', 'renamefrom 0 R_ry', 'renameto 0 chan5'])
add_op(SY, 'sel_rotL', 'CHOP:select', (6200, 1175, 130, 90), inputs=['heads'],
       parms=['channames 0 L_ry', 'renamefrom 0 L_ry', 'renameto 0 chan5'])
set_inputs(SY, 'FrotatepositionR', ['sel_rotR'])
set_inputs(SY, 'FrotatepositionL', ['sel_rotL'])

# calming: each object's rotation wobble x (1 - 0.7 level) (Math gain is applied before the
# -1..1 -> 0..1 range, so this narrows the swing around the same centre)
set_parm(SY, 'math22', expr('gain', 1.84, "op('select20')['v1'] * op('heads')['d1_calm']"))
set_parm(SY, 'math28', expr('gain', 1, "op('select20')['v1'] * op('heads')['d2_calm']"))

# grey on ok = 0: desaturate that person's object render (R = person 1 = render5 -> bloom1,
# L = person 2 = render4 -> bloom2)
add_op(SY, 'okgreyR', 'TOP:hsvadj', (2375, -1050, 130, 90), inputs=['bloom1'],
       parms=[expr('saturationmult', 1, "op('heads')['d1_sat']")])
set_inputs(SY, 'null15', ['okgreyR'])
add_op(SY, 'okgreyL', 'TOP:hsvadj', (2350, -200, 130, 90), inputs=['bloom2'],
       parms=[expr('saturationmult', 1, "op('heads')['d2_sat']")])
set_inputs(SY, 'null14', ['okgreyL'])

# the overlay that showed the Sync Trigger value now shows Hold time
set_parm(SY, 'text1', expr('text', '3.0', "str(round(op('/controls/Hold_time').par.value0.eval(), 1))"))

# ---------------------------------------------------------------- 3. /controls: three live controls + operator label

delete_op(CT, 'Sync_Trigger')
for name, label, default, hi, u, tile in (('Hold_time', 'Hold time (s)', 3, 5, 0.6, (-425, 750)),
                                          ('Relative_alpha_sync', 'Relative alpha sync (min pair_level)', 0, 1, 0, (-225, 750)),
                                          ('Forgiveness', 'Forgiveness (s)', 1, 3, 1 / 3.0, (-25, 750))):
    copy_comp(CT, 'BNoise2period1', name,
              parm_edit=[('label 0 BNoise2period1', 'label 0 ' + q(label)),
                         ('value0 0 5', 'value0 0 %g' % default),
                         ('valuerange0l 0 1\n', ''),
                         ('valuerange0h 0 5', 'valuerange0h 0 %g' % hi)],
              panel_edit=[('\nu 1\n', '\nu %g\n' % u), ('\ntrueu 1\n', '\ntrueu %g\n' % u),
                          ('\nstateu 1\n', '\nstateu %g\n' % u)], tile=tile)

STATUS = ("('FORCED SYNC  ' if op('Hold_time').par.value0.eval() <= 0.05 else '')"
          " + ('CONTRACT ERROR  ' if float(op('/project1/SYNCD/container1websocket_example/contract_error')['contract_error']) > 0.5 else '')"
          " + ('NO DATA' if float(op('/project1/SYNCD/container1websocket_example/STATE')['stale']) > 0.5 else '')")
write(CT + '/status_label.n', node('COMP:text', (-425, 600, 160, 76), color=NEW), CT + '/')
write(CT + '/status_label.parm', parm([
    'pageindex 0 4',
    expr('text', 'NO DATA', STATUS),
    'type 0 multiline', 'legacyfontselection 0 on', 'scaletofit 0 onlyshrink', 'fontsize 0 10',
    'fontcolorr 0 1', 'fontcolorg 0 0.15', 'fontcolorb 0 0.15',
    'textpaddingl 32 4', 'textpaddingr 32 4', 'textpaddingb 32 3', 'textpaddingt 32 3',
    'alignx 0 left', 'w 0 100', 'h 0 20', 'clickthrough 0 on',
    'bgcolorr 0 0.08', 'bgcolorg 0 0.08', 'bgcolorb 0 0.08', 'bgalpha 0 1']), CT + '/')
write(CT + '/status_label.panel', open(p(CT + '/BNoise2period1/text.panel')).read(), CT + '/')

# the controls container's saved panel state named the removed slider
s = open(p('controls.panel')).read()
s = s.replace('radio sSync_Trigger\n', 'radio sHold_time\n').replace('children 9\n', 'children 12\n')
open(p('controls.panel'), 'w').write(s)

with open(TOC, 'w') as f:
    f.write(''.join(l + '\n' for l in toc))
print('built', D, len(toc), 'toc entries')
