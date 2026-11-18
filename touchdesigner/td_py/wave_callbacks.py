# wave_callbacks -- Script CHOP 'wave' for dual-alpha-V16.toe
# Location: /project1/SYNCD/container1websocket_example/wave_callbacks (callbacks DAT of 'wave')
#
# Plays the two 125 Hz waveforms (d1_w, d2_w) out of the 2 s ring buffer that
# webserver1_callbacks1 fills (stored on this Script CHOP as storage key 'ring').
#   - output: 2 channels, d1_w and d2_w, sample rate 125, time sliced
#     (each cook outputs the samples that fell due since the last cook, ~2 at 60 fps)
#   - the playhead runs 250 ms (just before a batch) to 378 ms (just after one) behind
#     the newest sample, so a message up to 250 ms late does not starve the output; it drifts back to that delay at up to +-5 % speed
#     and, when new data arrives, snaps if it is more than 0.5 s off (start, app
#     restart, resume after a stall). While no data arrives it never snaps back, so a
#     stopped stream holds its last sample instead of replaying old ones
#   - a gap (no data at the playhead) holds the last sample, so motion does not jump
#
# Script CHOP API used (scriptCHOP / CHOP / Channel class, TD 2025 offline help):
#   scriptOp.clear(), .rate, .isTimeSlice, .numSamples, .appendChan(name), channel.vals,
#   OP.fetch(key, default, search=False) / OP.store(key, value), absTime.seconds,
#   onGetCookLevel -> CookLevel.ALWAYS.
# clear() resets the rate to the global rate (Release Notes), so rate is set after it,
# and before numSamples (CHOP class: set rate/start before length).

import math

FS = 125
CHANS = ('d1_w', 'd2_w')
DELAY_S = 0.25            # play-out delay behind the newest sample
SNAP_S = 0.5              # re-centre the playhead if it is this far off when new data arrives
MAX_DRIFT = 0.05          # +-5 % speed correction toward the target delay
BATCH = 16                # samples per message (128 ms at 125 Hz)
MAX_SLICE_S = 0.5         # after a stall, never emit more than this in one cook
TIMESLICE = True          # False: fallback, one sample per cook at the timeline rate


def onSetupParameters(scriptOp):
	return


def onPulse(par):
	return


def onGetCookLevel(scriptOp):
	return CookLevel.ALWAYS


def _state(scriptOp, now):
	st = scriptOp.fetch('play', None, search=False)
	if st is None:
		st = {'t': now, 'acc': 0.0, 'P': None, 'seen': None, 'last': [0.0, 0.0], 'out': [[0.0], [0.0]]}
		scriptOp.store('play', st)
	return st


def _emit(scriptOp, cols, rate, timeslice):
	scriptOp.clear()
	scriptOp.rate = rate
	scriptOp.isTimeSlice = timeslice
	scriptOp.numSamples = len(cols[0])
	for name, vals in zip(CHANS, cols):
		c = scriptOp.appendChan(name)
		c.vals = vals


def play(st, ring, k, now):
	"""Advance the playhead by k samples and return the k output samples per channel.
	Pure Python (no TD globals) so it can be tested outside TouchDesigner."""
	step = 1.0
	if ring is not None and ring.get('next') is not None and ring['next'] > ring['first']:
		fresh = ring['next'] != st.get('seen')     # new samples since the last cook
		if fresh:
			st['seen'] = ring['next']
			st['t_fresh'] = now
		# where the playhead should be now: DELAY_S behind the newest sample, counting
		# the newest as advancing in real time between batches (at most one batch),
		# so it is 0.25 s behind just before a batch and 0.25 + 0.128 s just after one
		ahead = min((now - st.get('t_fresh', now)) * FS, BATCH)
		target = ring['next'] - DELAY_S * FS - BATCH + ahead
		if st['P'] is None or (fresh and abs(target - st['P']) > SNAP_S * FS):
			st['P'] = target
		else:
			step += max(-MAX_DRIFT, min(MAX_DRIFT, (target - st['P']) / FS))
	cols = [[], []]
	for _ in range(k):
		if st['P'] is not None and ring is not None:
			i = int(math.floor(st['P']))
			j = i - ring['first']
			if 0 <= i - ring['first'] < len(ring['d1_w']) and i < ring['next']:
				st['last'][0] = ring['d1_w'][j]
				st['last'][1] = ring['d2_w'][j]
			st['P'] += step
		cols[0].append(st['last'][0])    # gap / underrun: hold the last sample
		cols[1].append(st['last'][1])
	return cols


def onCook(scriptOp):
	now = absTime.seconds
	st = _state(scriptOp, now)
	ring = scriptOp.fetch('ring', None, search=False)
	dt = now - st['t']
	st['t'] = now
	if dt <= 0:                            # cooked twice in one frame: same output again
		_emit(scriptOp, st['out'], FS if TIMESLICE else me.time.rate, TIMESLICE)
		return
	st['acc'] += min(dt, MAX_SLICE_S) * FS
	k = int(st['acc'])
	if k < 1:
		k = 1                              # always output something; borrow from the next cook
	st['acc'] -= k
	cols = play(st, ring, k, now)
	if TIMESLICE:
		st['out'] = cols
		_emit(scriptOp, cols, FS, True)
	else:
		st['out'] = [[cols[0][-1]], [cols[1][-1]]]
		_emit(scriptOp, st['out'], me.time.rate, False)
	return


cook = onCook                              # older builds call cook()
