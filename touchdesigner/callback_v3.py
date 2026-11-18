# webserver1_callbacks1 -- callback v3 for dual-alpha-V16.toe (contract v2, app 2.7.0a, /dual-alpha)
# Location in the show file: /project1/SYNCD/container1websocket_example/webserver1_callbacks1
#
# One JSON text message every 128 ms on the Web Server DAT (port 9000):
#   {"v":2,"fs":125,"n":int,"d1_level":0-1,"d1_ok":0/1,"d2_level":..,"d2_ok":..,
#    "pair_level":0-1,"d1_w":[16 floats],"d2_w":[16 floats]}
#
# Writes (all siblings of this DAT):
#   eeg            Constant CHOP  d1_level d1_ok d2_level d2_ok pair_level   (const0..4)
#   eeg_meta       Constant CHOP  n last_msg msgs bad_msgs lost_samples      (const0..4)
#   contract_error Constant CHOP  contract_error                             (const0)
#   wave           Script CHOP    its storage key 'ring' holds the last 2 s of d1_w / d2_w
#
# Anything that is not a v2 message at fs 125 (for example a v1 message from
# /dual-stream, which has "ts", "d1_ch0" ... and no "v") lights contract_error and
# is otherwise ignored: no values are taken, so after 2 s STATE turns both people
# not ok (grey). The next valid v2 message clears contract_error.
#
# Constant CHOP parameter names: since TouchDesigner 2023 the pars are
# const{i}name / const{i}value; name{i} / value{i} are only legacy aliases
# (Release Notes 2023, bundled offline help). _value_par() tries the new name first.

import json
import math

KEYS = ('d1_level', 'd1_ok', 'd2_level', 'd2_ok', 'pair_level')   # channel order in 'eeg'
WAVE = ('d1_w', 'd2_w')
FS = 125
RING_LEN = 2 * FS            # 2 s of waveform per person
CONTRACT_V = 2


def _value_par(chop, i):
	p = getattr(chop.par, 'const%dvalue' % i, None)
	if p is None:
		p = getattr(chop.par, 'value%d' % i, None)      # pre-2023 alias
	return p


def _set(name, i, v):
	c = op(name)
	if c is None:
		return
	p = _value_par(c, i)
	if p is not None:
		p.val = v


def _get(name, i, default=0.0):
	c = op(name)
	if c is None:
		return default
	p = _value_par(c, i)
	return default if p is None else p.val


def _num(x, default=0.0):
	try:
		f = float(x)
	except (TypeError, ValueError):
		return default
	if math.isnan(f) or math.isinf(f):
		return default
	return f


def _ring():
	w = op('wave')
	if w is None:
		return None
	r = w.fetch('ring', None, search=False)
	if r is None:
		r = {'d1_w': [], 'd2_w': [], 'first': 0, 'next': None}
		w.store('ring', r)
	return r


def _contract_error():
	_set('contract_error', 0, 1)
	_set('eeg_meta', 3, _get('eeg_meta', 3) + 1)


def _append_wave(n, w1, w2):
	"""Append one batch to the 2 s ring. n is the index of the batch's first sample."""
	r = _ring()
	if r is None:
		return
	m = min(len(w1), len(w2))
	b1 = r['d1_w']
	b2 = r['d2_w']
	last1 = b1[-1] if b1 else 0.0
	last2 = b2[-1] if b2 else 0.0
	s1 = []
	s2 = []
	for i in range(m):                       # clean values, holding the last good one
		last1 = _num(w1[i], last1)
		last2 = _num(w2[i], last2)
		s1.append(last1)
		s2.append(last2)
	nxt = r['next']
	if nxt is None or n > nxt + RING_LEN or n < nxt - RING_LEN:
		# first message, app restarted, or a gap longer than the ring: start afresh
		del b1[:]
		del b2[:]
		r['first'] = n
		r['next'] = n
	elif n > nxt:
		# messages lost: repeat the last sample for the missing count
		gap = n - nxt
		h1 = b1[-1] if b1 else (s1[0] if s1 else 0.0)
		h2 = b2[-1] if b2 else (s2[0] if s2 else 0.0)
		b1.extend([h1] * gap)
		b2.extend([h2] * gap)
		r['next'] = n
		_set('eeg_meta', 4, _get('eeg_meta', 4) + gap)
	elif n < nxt:
		# overlap or duplicate: keep only samples not already held
		skip = nxt - n
		s1 = s1[skip:]
		s2 = s2[skip:]
	b1.extend(s1)
	b2.extend(s2)
	r['next'] += len(s1)
	extra = len(b1) - RING_LEN
	if extra > 0:
		del b1[:extra]
		del b2[:extra]
		r['first'] += extra


def onWebSocketOpen(dat, client, uri):
	print('dual-alpha: app connected: %s' % (client,))
	return True


def onWebSocketClose(dat, client):
	print('dual-alpha: app disconnected: %s' % (client,))


def onWebSocketReceiveText(dat, client, data):
	try:
		msg = json.loads(data)
	except ValueError:                       # json.JSONDecodeError is a ValueError
		_contract_error()
		return
	if not isinstance(msg, dict) or msg.get('v') != CONTRACT_V or msg.get('fs') != FS:
		_contract_error()                    # app and TD file out of step (e.g. /dual-stream v1)
		return
	for i, k in enumerate(KEYS):
		if k in msg:
			_set('eeg', i, _num(msg[k]))
	n = int(_num(msg.get('n'), -1))
	w1 = msg.get('d1_w') or []
	w2 = msg.get('d2_w') or []
	if n >= 0 and isinstance(w1, list) and isinstance(w2, list):
		_append_wave(n, w1, w2)
		_set('eeg_meta', 0, n)
	_set('eeg_meta', 1, absTime.seconds)     # when we last heard; STATE's stale test reads this
	_set('eeg_meta', 2, _get('eeg_meta', 2) + 1)
	_set('contract_error', 0, 0)


def onWebSocketReceiveBinary(dat, client, data):
	pass


def onWebSocketReceivePing(dat, client, data):
	return True


def onWebSocketReceivePong(dat, client, data):
	pass
