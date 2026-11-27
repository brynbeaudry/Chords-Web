# pair_logic_callbacks -- Script CHOP 'pair_logic' for dual-alpha-V16.toe
# Location: /project1/SYNCD/pair_logic_callbacks (callbacks DAT of /project1/SYNCD/pair_logic)
#
# Replaces V15's waveform comparison (select16/17, filter15/16, math13/14/18, logic1,
# math19/23 and the "Sync Trigger" slider) with the pair rule of contract v2:
#   together = pair_level > Relative alpha sync   (pair_level is 0 unless both are ok)
#   held     = together has lasted Hold time seconds; a drop shorter than Forgiveness
#              is ignored (the count pauses), a longer one restarts the count
#   Hold time 0 (<= FORCE_EPS) forces both to 1 whatever the data: the cheat code;
#   the operator sees "FORCED SYNC" on /controls/status_label, not in the projection.
#
# Output channels (one sample, not time sliced):
#   together  0/1 -> sel_together (renamed chan5) -> filter18 (the existing 3 s ease)
#   held      0/1 -> sel_held (renamed chan5)     -> trigger3 (threshold 0.5)
#   hold_s, gap_s, forced, hold_time, rel_sync, forgiveness  (for monitoring)
#
# Inputs read by path: STATE (stale-gated values) and the three /controls sliders.

STATE = '/project1/SYNCD/container1websocket_example/STATE'
CONTROLS = '/controls/'
DEFAULTS = {'Hold_time': 0.2, 'Relative_alpha_sync': 0.0, 'Forgiveness': 1.0}
FORCE_EPS = 0.05          # Hold time at or below this counts as 0 (slider end stop)
MAX_DT = 0.5


def onSetupParameters(scriptOp):
	return


def onPulse(par):
	return


def onGetCookLevel(scriptOp):
	return CookLevel.ALWAYS


def _ctl(name):
	o = op(CONTROLS + name)
	if o is None:
		return DEFAULTS[name]
	return float(o.par.value0.eval())


def _chan(chop, name, default=0.0):
	if chop is None:
		return default
	c = chop.chan(name)
	return default if c is None else float(c.eval())


def step(st, dt, pair_level, hold_time, rel_sync, forgiveness):
	"""One update of the hold logic. Pure Python so it can be tested outside TD."""
	dt = max(0.0, min(dt, MAX_DT))
	forced = hold_time <= FORCE_EPS
	cond = pair_level > rel_sync and pair_level > 0.0
	if cond:
		st['gap_s'] = 0.0
		st['hold_s'] += dt
	else:
		st['gap_s'] += dt
		if st['gap_s'] > forgiveness:
			st['hold_s'] = 0.0
	in_grace = st['hold_s'] > 0.0 and st['gap_s'] <= forgiveness
	together = 1.0 if (cond or in_grace) else 0.0
	held = 1.0 if (st['hold_s'] >= hold_time and together) else 0.0
	if forced:
		together = 1.0
		held = 1.0
	return {'together': together, 'held': held, 'hold_s': st['hold_s'],
			'gap_s': st['gap_s'], 'forced': 1.0 if forced else 0.0,
			'hold_time': hold_time, 'rel_sync': rel_sync, 'forgiveness': forgiveness}


ORDER = ('together', 'held', 'hold_s', 'gap_s', 'forced', 'hold_time', 'rel_sync', 'forgiveness')


def onCook(scriptOp):
	now = absTime.seconds
	st = scriptOp.fetch('hold', None, search=False)
	if st is None:
		st = {'t': now, 'hold_s': 0.0, 'gap_s': 1e9}
		scriptOp.store('hold', st)
	dt = now - st['t']
	st['t'] = now
	s = op(STATE)
	out = step(st, dt, _chan(s, 'pair_level'), _ctl('Hold_time'),
			   _ctl('Relative_alpha_sync'), _ctl('Forgiveness'))
	scriptOp.clear()
	scriptOp.rate = me.time.rate
	scriptOp.numSamples = 1
	for name in ORDER:
		c = scriptOp.appendChan(name)
		c[0] = out[name]
	return


cook = onCook
