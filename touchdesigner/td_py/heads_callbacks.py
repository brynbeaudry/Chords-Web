# heads_callbacks -- Script CHOP 'heads' for dual-alpha-V16.toe
# Location: /project1/SYNCD/heads_callbacks (callbacks DAT of /project1/SYNCD/heads)
# Input 0: filter18 (the existing 3 s ease of 'together'), read as E in 0..1.
#
# Angle convention (plan section 6.3, "The heads"): each head's turn from facing the
# front; +45 = turned away (where V15 rests), 0 = facing forward (where V15's faces
# met), negative = turned toward the other person.
# V15 mapped filter18 0..1 to FrotatepositionR 45..0 (math15) and FrotatepositionL
# -45..0 (math16), feeding transform6.ry (right face) and transform5.ry (left face).
# So the right head's ry = angle and the left head's ry = -angle: "toward the other"
# is ry < 0 on the right and ry > 0 on the left. Person 1 (d1) is the right side and
# person 2 (d2) the left, as for the objects (device 1 -> *R operators, x = +9).
#
# Per side (own level L, other level Lo, ok, time in alpha t):
#   not in alpha or not ok : eases back to +45 (away)
#   in alpha, alone        : eases to 0 (fast in, TAU_TURN_IN), then reaches toward the other:
#                            -(REACH_MAX * min(1, t/REACH_RAMP) * dip(t) + DEPTH_MAX * L)
#                            dip(t) = 0.5 - 0.5 cos(2 pi t / REACH_PERIOD): reach and dip back
#   both in (E -> 1)       : TOGETHER_ANGLE - DEEPER_EXTRA * clamp(DEEPER_GAIN (L - Lo), 0, 1)
#   angle = solo * (1 - E) + together * E
# Also per side: sat (ok eased, 1 colour .. 0 grey), calm = 1 - CALM * L (scales the
# object's rotation wobble), colormult = 1 + COLOR_GAIN * max(0, L - Lo) (deeper head's
# colour speed factor; not wired yet, see TD_CHANGES.md).
#
# Output channels (one sample, not time sliced):
#   R_ry, L_ry (-> sel_rotR / sel_rotL renamed chan5 -> FrotatepositionR / L),
#   d1_angle, d2_angle, d1_sat, d2_sat, d1_calm, d2_calm, d1_colormult, d2_colormult,
#   d1_t, d2_t, E

import math

STATE = '/project1/SYNCD/container1websocket_example/STATE'

AWAY = 45.0               # deg, not in alpha / not ok
REACH_MAX = 12.0          # deg, reach toward the other while waiting
# Alpha on these montages arrives in bursts of roughly half a second to three seconds, so the
# whole solo gesture has to be legible inside one. These were 8 s and 8 s, shaped for a hold
# nobody actually produces: a real burst moved the head partway and never got past "turned
# away". scripts/head_timing.py runs step() offline and prints what a burst now looks like.
REACH_RAMP = 1.0          # s to reach full reach amplitude
REACH_PERIOD = 3.0        # s, one reach-and-dip cycle (0 = no dip: lean and hold)
DEPTH_MAX = 8.0           # deg extra reach at level 1
TOGETHER_ANGLE = -20.0    # deg, both in: face each other
DEEPER_EXTRA = 5.0        # deg, the deeper head turns up to this much further
DEEPER_GAIN = 2.0         # a level lead of 0.5 gives the full DEEPER_EXTRA
# Fast in, slow out, and deliberately asymmetric. Fast in so half a second of alpha is a
# visible turn rather than a twitch; slow out so the head does not snap back and chatter when
# a burst ends, and so two bursts close together read as one gesture instead of two flinches.
TAU_TURN_IN = 0.25        # s, ease toward the other while in alpha
TAU_TURN_OUT = 1.2        # s, ease back to +45 when alpha ends
TAU_LEVEL = 0.3           # s, smoothing of level for depth / calm / colour
TAU_GREY = 1.0            # s, fade to grey and back
CALM = 0.7                # rotation wobble x (1 - 0.7 level)
COLOR_GAIN = 0.5          # deeper head colour speed x (1 + 0.5 (L - Lo))
MAX_DT = 0.5


def onSetupParameters(scriptOp):
	return


def onPulse(par):
	return


def onGetCookLevel(scriptOp):
	return CookLevel.ALWAYS


def _ease(x, target, dt, tau):
	return x + (target - x) * (1.0 - math.exp(-dt / tau))


def _clamp(x, lo, hi):
	return lo if x < lo else hi if x > hi else x


def new_state():
	return {'t': None, 'tin': [0.0, 0.0], 'e': [0.0, 0.0], 'lv': [0.0, 0.0], 'sat': [0.0, 0.0]}


def step(st, dt, E, lv, ok):
	"""One update. lv, ok: (person1, person2). Pure Python, testable outside TD."""
	dt = max(0.0, min(dt, MAX_DT))
	E = _clamp(E, 0.0, 1.0)
	out = {}
	for s in (0, 1):
		o = 1 - s
		is_ok = ok[s] > 0.5
		inside = is_ok and lv[s] > 0.0
		st['tin'][s] = st['tin'][s] + dt if inside else 0.0
		st['e'][s] = _ease(st['e'][s], 1.0 if inside else 0.0, dt,
		                   TAU_TURN_IN if inside else TAU_TURN_OUT)
		st['lv'][s] = _ease(st['lv'][s], lv[s] if is_ok else 0.0, dt, TAU_LEVEL)
		st['sat'][s] = _ease(st['sat'][s], 1.0 if is_ok else 0.0, dt, TAU_GREY)
	for s in (0, 1):
		o = 1 - s
		t = st['tin'][s]
		dip = 1.0 if REACH_PERIOD <= 0 else 0.5 - 0.5 * math.cos(2.0 * math.pi * t / REACH_PERIOD)
		reach = REACH_MAX * min(1.0, t / REACH_RAMP) * dip
		alone = -(reach + DEPTH_MAX * st['lv'][s])
		solo = AWAY * (1.0 - st['e'][s]) + alone * st['e'][s]
		lead = st['lv'][s] - st['lv'][o]
		together = TOGETHER_ANGLE - DEEPER_EXTRA * _clamp(DEEPER_GAIN * lead, 0.0, 1.0)
		angle = solo * (1.0 - E) + together * E
		p = 'd%d_' % (s + 1)
		out[p + 'angle'] = angle
		out[p + 'sat'] = st['sat'][s]
		out[p + 'calm'] = 1.0 - CALM * st['lv'][s]
		out[p + 'colormult'] = 1.0 + COLOR_GAIN * max(0.0, lead)
		out[p + 't'] = t
	# Person 1 is the LEFT side of the projection: that is where device 1 sits in the room.
	out['R_ry'] = out['d2_angle']           # right face  = person 2, transform6.ry via FrotatepositionR
	out['L_ry'] = -out['d1_angle']          # left face   = person 1, transform5.ry via FrotatepositionL
	out['E'] = E
	return out


ORDER = ('R_ry', 'L_ry', 'd1_angle', 'd2_angle', 'd1_sat', 'd2_sat', 'd1_calm', 'd2_calm',
		 'd1_colormult', 'd2_colormult', 'd1_t', 'd2_t', 'E')


def _chan(chop, name, default=0.0):
	if chop is None:
		return default
	c = chop.chan(name)
	return default if c is None else float(c.eval())


def onCook(scriptOp):
	now = absTime.seconds
	st = scriptOp.fetch('heads', None, search=False)
	if st is None:
		st = new_state()
		scriptOp.store('heads', st)
	dt = 0.0 if st['t'] is None else now - st['t']
	st['t'] = now
	E = 0.0
	if len(scriptOp.inputs) > 0 and scriptOp.inputs[0].numChans > 0:
		E = float(scriptOp.inputs[0][0].eval())
	s = op(STATE)
	out = step(st, dt, E,
			   (_chan(s, 'd1_level'), _chan(s, 'd2_level')),
			   (_chan(s, 'd1_ok'), _chan(s, 'd2_ok')))
	scriptOp.clear()
	scriptOp.rate = me.time.rate
	scriptOp.numSamples = 1
	for name in ORDER:
		c = scriptOp.appendChan(name)
		c[0] = out[name]
	return


cook = onCook
