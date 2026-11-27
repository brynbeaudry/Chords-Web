#!/usr/bin/env python3
"""What one person's head does during a short alpha episode, from the real `step()`.

    python3 scripts/head_timing.py            # 0.5 s, 1 s, 2 s and 3 s episodes

Why this exists
---------------
Alpha on these montages comes in bursts of roughly half a second to three seconds. The solo
head gesture was shaped for something much longer -- a 1 s ease, then a reach that needed
eight seconds to reach full amplitude -- so a real burst moved the head partway and never got
past "turned away". This runs the actual `heads_callbacks.step()` offline at 60 fps so the
gesture can be judged and tuned without TouchDesigner, and without another WebSocket client
interleaving its own values into `eeg`.

Angles follow the file's convention: **+45 is turned away**, 0 is facing forward, negative is
turned toward the other person. So a bigger negative number is a stronger gesture.
"""
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, 'td_py'))

# heads_callbacks calls TD-only names at import time only inside its callbacks, so the module
# imports cleanly as long as `op` and `CookLevel` exist.
import builtins
builtins.op = lambda *a, **k: None
builtins.absTime = type('t', (), {'seconds': 0.0})()
builtins.me = type('m', (), {'time': type('tt', (), {'rate': 60.0})()})()
builtins.CookLevel = type('c', (), {'ALWAYS': 0})()

import heads_callbacks as H

FPS = 60.0
DT = 1.0 / FPS


def episode(alpha_s, level=0.8, lead_s=0.5, tail_s=2.0):
    """Returns [(t, person 1's angle)] with person 1 in alpha alone for `alpha_s`."""
    st = H.new_state()
    out = []
    n = int((lead_s + alpha_s + tail_s) * FPS)
    for i in range(n):
        t = i * DT
        on = lead_s <= t < lead_s + alpha_s
        r = H.step(st, DT, 0.0, (level if on else 0.0, 0.0), (1.0, 1.0))
        out.append((t - lead_s, r['d1_angle'], r['d1_t']))
    return out


print('person 1 in alpha alone at level 0.8. +45 = turned away, 0 = forward,')
print('negative = turned toward the other person.\n')
print('TAU_TURN_IN %.2f s  TAU_TURN_OUT %.2f s  REACH_RAMP %.1f s  REACH_PERIOD %.1f s'
      % (H.TAU_TURN_IN, H.TAU_TURN_OUT,
         H.REACH_RAMP, H.REACH_PERIOD))

for alpha_s in (0.5, 1.0, 2.0, 3.0):
    rows = episode(alpha_s)
    during = [a for t, a, _ in rows if 0 <= t < alpha_s]
    best = min(during) if during else 45.0
    at_end = [a for t, a, _ in rows if t >= alpha_s][0]
    print('\n%.1f s episode: furthest %+.1f deg, %+.1f deg at the moment alpha ends'
          % (alpha_s, best, at_end))
    print('  travel from rest: %.1f deg%s' % (45.0 - best,
          '' if best < 44 else '   <-- barely moves'))
    print('  crosses forward: %s' % ('yes' if best < 0 else 'NO, stays turned away'))
    marks = [t for t, a, _ in rows if 0 <= t <= alpha_s]
    step = max(1, len(marks) // 6)
    trace = [(t, a) for t, a, _ in rows if 0 <= t <= alpha_s][::step]
    print('  ' + '  '.join('%.1fs %+.0f' % (t, a) for t, a in trace))
