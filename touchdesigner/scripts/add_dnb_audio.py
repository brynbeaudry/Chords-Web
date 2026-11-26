#!/usr/bin/env python3
"""Add the EEG-driven drum-and-bass chain to the expanded text, then re-collapse.

    python3 scripts/add_dnb_audio.py            # edits expanded/ in place

Every operator type string and menu token here was read off a running TouchDesigner rather
than guessed, because two of them are truncated in the file format and would have produced an
unloadable .toe: Audio Dynamics writes `audiodyna` and Audio Band EQ writes `audioband`.

The signal path, all in /project1, prefixed dnb_
-----------------------------------------------
    dnb_state -> dnb_ctl          Select CHOP (by path, because a wired input cannot
                                  cross a container) into a Filter CHOP, 0.35 s.
                                  Everything reads
                                  this rather than STATE itself, so no level, speed,
                                  cutoff or mute can step in a single frame.

Five stems play in phase from touchdesigner/audio/ (copied next to the .toe, like the models),
each at its own level, all sharing one speed:

    dnb_kick  dnb_snare  dnb_haton  dnb_hatoff  dnb_sub  dnb_reese

    dnb_hatoff -> dnb_swing       Delay CHOP: pushes the off-grid sixteenths late. That is
                                  what swing physically is, which is why the hat was rendered
                                  as two stems.
    dnb_kick   -> dnb_envabs      Limit CHOP, Positive Only: rectifies the kick
               -> dnb_env         Filter CHOP, 80 ms: an envelope follower on the beat
    dnb_wob                       LFO CHOP: the wobble, its rate from pair_level
    dnb_sub                       goes straight to the mix: low-passing or clipping the
                                  fundamental is how a sub stops being a sub
    dnb_reese  -> dnb_bassfilt    Audio Filter, low pass. Cutoff = floor + person 2's weight
                                  + the kick envelope + the wobble. This is the filter
                                  envelope: it opens on every kick.
               -> dnb_drive       Audio Dynamics as distortion: input gain into a limiter is
                                  hard clipping
    all        -> dnb_sum         Math CHOP, Combine CHOPs = add
               -> dnb_eq          Audio Band EQ, 16 bands: bass from person 2, treble from
                                  person 1, mid left flat
               -> dnb_echo        Delay CHOP, a dotted eighth. There is no Reverb CHOP in
                                  TouchDesigner and no VST installed, so this stands in, and
                                  a dub delay suits the material better anyway
               -> dnb_mix         Math CHOP add: dry plus echo
               -> dnb_limit       Audio Dynamics as a limiter at -1 dB: the only
                                  thing guaranteeing the output stays in +-1

dnb_limit becomes a fourth input on /project1/filein_or_AudioLinein and the switch is set to it.
Setting that switch back to 1 restores Kaz's line-in path exactly; nothing existing is removed.

The mapping
-----------
Person 1 is the right side, person 2 the left.

    pair_level   resolves the mix: wobble, resonance and distortion all fall away as it
                 rises, the tempo settles very slightly, and the echo opens up
    max(d1, d2)  kick and snare weight -- the backbone grows as anyone engages
    d1_level     hats and treble, so detail lives up top
    d2_level     sub and Reese level, bass cutoff floor, drive amount, EQ bass
    stale        mutes everything, so silence means nobody is connected

Nothing is read raw: every expression reads dnb_ctl, the 0.35 s smoothed copy of STATE, so no
level, tempo, cutoff or mute can step in a single frame.
"""
import io
import os
import re
import struct

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(HERE, 'expanded', 'dual-alpha-V16.toe.dir')
TOCP = os.path.join(HERE, 'expanded', 'dual-alpha-V16.toe.toc')
NET = 'project1'
toc = [l.rstrip('\n') for l in io.open(TOCP, encoding='utf-8')]

STATE_PATH = 'SYNCD/container1websocket_example/STATE'
# Every expression below reads the *smoothed* copy, never STATE directly. STATE steps:
# it updates about 8 times a second and `stale` flips in one frame, which turns silence
# into a full mix instantly and makes `speed` jump in pitch. dnb_ctl fixes that once,
# for all of them.
ST = "op('dnb_ctl')"
L1 = ST + "['d1_level']"
L2 = ST + "['d2_level']"
PR = ST + "['pair_level']"
LIVE = '(1-' + ST + "['stale'])"
# Engagement: is anyone in alpha at all. Sync: are they in it together.
EN = 'max(' + L1 + ',' + L2 + ')'
CALM = '(1-' + PR + ')'          # the agitation sources ride this, not pair_level
SPEED = '1.00-0.05*' + PR        # a settle, not a lurch


def q(s):
    assert '"' not in s and chr(92) not in s and chr(10) not in s, s
    return s if (s and ' ' not in s) else '"%s"' % s


def expr(name, cached, e):
    return '%s 17 %s %s' % (name, q(str(cached)), q(e))


def write(rel, data):
    path = os.path.join(D, *rel.split('/'))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if isinstance(data, bytes):
        io.open(path, 'wb').write(data)
    else:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(data)
    if rel not in toc:
        idx = max(i for i, l in enumerate(toc) if l.startswith(NET + '/'))
        toc.insert(idx + 1, rel)


def add(name, optype, tile, inputs=(), parms=()):
    s = '%s\ntile %d %d %d %d\nflags =  parlanguage 0\n' % ((optype,) + tile)
    if inputs:
        s += 'inputs\n{\n' + ''.join('%d \t%s\n' % (i, n) for i, n in enumerate(inputs)) + '}\n'
    s += 'color 0.85 0.55 0.2 \nend\n'
    write('%s/%s.n' % (NET, name), s)
    # Time Slice on every one of them. Measured on the running file: without it a Math
    # CHOP summing audio-rate slices produced an 8820-sample buffer instead of the
    # frame's 735, and everything downstream inherited it.
    parms = list(parms) + ['timeslice 0 on']
    write('%s/%s.parm' % (NET, name),
          '?\n' + ''.join(p + '\n' for p in parms) + '?\n')


def set_inputs(name, inputs):
    path = os.path.join(D, NET, name + '.n')
    s = io.open(path, encoding='utf-8', newline='').read()
    block = 'inputs\n{\n' + ''.join('%d \t%s\n' % (i, n) for i, n in enumerate(inputs)) + '}\n'
    s2, k = re.subn(r'inputs\n\{\n.*?\}\n', block, s, flags=re.S)
    assert k == 1, path
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s2)


def set_parm(name, line):
    path = os.path.join(D, NET, name + '.parm')
    lines = io.open(path, encoding='utf-8', newline='').read().split('\n')
    key = line.split(' ', 1)[0]
    for i, l in enumerate(lines):
        if l.split(' ', 1)[0] == key and i > 0:
            lines[i] = line
            break
    else:
        lines.insert(max(i for i, l in enumerate(lines) if l == '?'), line)
    io.open(path, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))


# ---------------------------------------------------------------- smoothed controls
# A Select CHOP reaches across containers by path; a wired input cannot -- it resolves
# sibling names only, and wiring the path directly fails with "Not enough sources
# specified", which leaves every expression downstream reading None.
add('dnb_state', 'CHOP:select', (-1850, 1500, 130, 90),
    parms=['chops 0 ' + STATE_PATH, 'channames 0 *'])
add('dnb_ctl', 'CHOP:filter', (-1700, 1500, 130, 90), inputs=['dnb_state'],
    parms=['width 0 0.35'])

# ---------------------------------------------------------------- the five stems
X, Y = -1400, 1500
STEMS = (
    # Kick and snare are the backbone: they follow engagement, so they get louder as anyone
    # comes in rather than only when both do.
    ('dnb_kick',   'break_kick.wav',     '0.30+0.70*' + EN),
    ('dnb_snare',  'break_snare.wav',    '0.30+0.50*' + EN + '+0.20*' + PR),
    # The busyness lives up top, where it reads as detail.
    ('dnb_haton',  'break_hat_on.wav',   '0.20+0.80*' + L1),
    ('dnb_hatoff', 'break_hat_off.wav',  '0.10+0.90*max(' + L1 + ',' + PR + ')'),
    ('dnb_sub',    'break_sub.wav',      '0.30+0.70*' + L2),
    # The growl recedes as they sync: that is the point.
    ('dnb_reese',  'break_reese.wav',    '0.25+0.55*' + L2 + '*' + CALM),
)
for i, (name, wav, vol) in enumerate(STEMS):
    add(name, 'CHOP:audiofilein', (X, Y - i * 160, 130, 90), parms=[
        'file 0 ' + wav, 'play 0 on', 'repeat 0 on',
        expr('speed', 1.0, SPEED),
        expr('volume', 0.5, LIVE + '*(' + vol + ')')])

# ---------------------------------------------------------------- swing, envelope, wobble
add('dnb_swing', 'CHOP:delay', (X + 200, Y - 480, 130, 90), inputs=['dnb_hatoff'], parms=[
    expr('delay', 0.02, '0.012+0.023*' + PR), 'delayunit 0 seconds'])

add('dnb_envabs', 'CHOP:limit', (X + 200, Y, 130, 90), inputs=['dnb_kick'],
    parms=['positive 0 on'])
add('dnb_env', 'CHOP:filter', (X + 350, Y, 130, 90), inputs=['dnb_envabs'],
    parms=['width 0 0.08'])
add('dnb_wob', 'CHOP:lfo', (X + 200, Y - 760, 130, 90), parms=[
    expr('frequency', 1.6, '1.0+1.2*' + CALM), 'amp 0 1'])

# ---------------------------------------------------------------- bass: filter envelope + drive
# Exponential, so the wobble moves in octaves rather than in hertz, and shallow: 0.30 of
# an octave at full pair_level and none below it. The base is the filter envelope.
CUTOFF = ('(90+700*' + L2 + "+2200*op('dnb_env')[0]*" + L1 + ')'
          + "*2**(0.35*" + CALM + "*op('dnb_wob')[0])")
add('dnb_bassfilt', 'CHOP:audiofilter', (X + 350, Y - 640, 130, 90), inputs=['dnb_reese'], parms=[
    'filter 0 lowpass', 'units 0 frequency',
    expr('cutofffrequency', 400, CUTOFF),
    expr('resonance', 0.4, '0.8*' + CALM)])
add('dnb_drive', 'CHOP:audiodyna', (X + 500, Y - 640, 130, 90), inputs=['dnb_bassfilt'], parms=[
    expr('inputgain', 4.0, '12.0*' + L2 + '*' + CALM),
    'enablelimiter 0 on', 'thresholdlimiter 0 -1'])

# ---------------------------------------------------------------- sum, EQ, compress, echo
add('dnb_sum', 'CHOP:math', (X + 700, Y - 300, 130, 90),
    inputs=['dnb_kick', 'dnb_snare', 'dnb_haton', 'dnb_swing', 'dnb_sub', 'dnb_drive'],
    parms=['chopop 0 add', 'gain 0 0.22'])

eq = ['drywet 0 1']
for b in range(1, 5):                      # bass bands, person 2
    eq.append(expr('band%d' % b, 3.0, '-3.0+9.0*' + L2))
for b in range(5, 12):                     # mid, left alone
    eq.append('band%d 0 0' % b)
for b in range(12, 17):                    # treble, person 1
    eq.append(expr('band%d' % b, 3.0, '-3.0+9.0*' + L1))
add('dnb_eq', 'CHOP:audioband', (X + 850, Y - 300, 130, 90), inputs=['dnb_sum'], parms=eq)

# A dotted eighth at 170 BPM, summed in *before* the limiter so the output stays bounded.
add('dnb_echo', 'CHOP:delay', (X + 1000, Y - 140, 130, 90), inputs=['dnb_eq'], parms=[
    'delay 0 0.1058', 'delayunit 0 seconds'])
add('dnb_echolvl', 'CHOP:math', (X + 1150, Y - 140, 130, 90), inputs=['dnb_echo'],
    parms=[expr('gain', 0.2, '0.10+0.22*' + PR)])
add('dnb_mix', 'CHOP:math', (X + 1300, Y - 300, 130, 90),
    inputs=['dnb_eq', 'dnb_echolvl'], parms=['chopop 0 add'])

# The last stage is a limiter, not a compressor. Measured on the running file: the Audio
# Dynamics compressor added about 3.6x even with its makeup gain at 0, taking peaks to 6.7
# when audio has to stay inside +-1. Its ratio also maxes at 1.5 and its attack and release
# at 5.0, so conventional values are silently clamped. A limiter at -1 dB held the output at
# 0.891 while the EQ upstream was peaking at 1.248, which is what was wanted.
add('dnb_limit', 'CHOP:audiodyna', (X + 1450, Y - 300, 130, 90), inputs=['dnb_mix'], parms=[
    'enablecompressor 0 off', 'enablelimiter 0 on', 'thresholdlimiter 0 -1'])

# ---------------------------------------------------------------- hand it to the existing output
set_inputs('filein_or_AudioLinein',
           ['audiofilein1', 'audiodevin1', 'audiondi1', 'dnb_limit'])
set_parm('filein_or_AudioLinein', 'index 0 3')


def unbypass(name):
    """Clear the bypass flag. The whole output chain ships bypassed in V15, which is why the
    file is silent: filein_or_AudioLinein, null1 and audiodevout2 all carried `bypass on`, so
    the switch reported 0 channels at every index and nothing reached the device. Re-setting
    those three flags is how you get the silence back."""
    path = os.path.join(D, NET, name + '.n')
    t = io.open(path, encoding='utf-8', newline='').read()
    assert 'bypass on ' in t, name
    io.open(path, 'w', encoding='utf-8', newline=chr(10)).write(t.replace('bypass on ', '', 1))


for n in ('filein_or_AudioLinein', 'null1', 'audiodevout2'):
    unbypass(n)

io.open(TOCP, 'w', encoding='utf-8', newline='\n').write(''.join(l + '\n' for l in toc))
print('added the dnb_ chain, %d toc entries' % len(toc))
print('switch /project1/filein_or_AudioLinein set to input 3 (dnb_limit); 1 restores line-in')
