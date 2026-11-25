#!/usr/bin/env python3
"""Build a local-only debug copy of the show file with a Python query endpoint.

    python3 scripts/make_debug_build.py <out_dir>
    # then: cd <out_dir> && toecollapse dual-alpha-V16.toe.dir
    #       copy the result to the TD/ folder as dual-alpha-V16-debug.toe

Why this exists
---------------
Most of what goes wrong in this file is only visible while it runs: a parameter that is
being ignored, a CHOP that is quietly emitting one sample instead of two, an expression
naming an operator that was renamed. Reading the expanded text cannot see any of it. Three
regressions in one session were caused by inferring behaviour from the text instead of
measuring it, and each took several rebuild-and-reopen cycles to unwind. With this endpoint
the same class of question takes one query.

What it adds
------------
Two operators in `/project1/SYNCD`, tinted red:

    dbg_callbacks   Text DAT holding onHTTPRequest
    dbg_webserver   Web Server DAT, port 9980, bound to 127.0.0.1

It takes `expanded/` as its input and leaves the repo's `dual-alpha-V16.toe` untouched, so
the show file never contains any of this.

Safety
------
**The endpoint executes arbitrary Python sent to it over HTTP.** It is bound to
`127.0.0.1`, so it is reachable only from the machine itself — the `localaddress`
parameter matters, because a Web Server DAT left blank listens on every interface, which on
a venue network would be remote code execution.

Even so:

* never use a debug build for a show, or for anything unattended;
* never copy it over `dual-alpha-V16.toe`;
* the show file is the one without `dbg_*` operators. `grep -c 9980` over `expanded/`
  should be 0, and `Get-NetTCPConnection -LocalPort 9980` should find nothing when the show
  file is running.

Using it
--------
    q() { curl -s --get --data-urlencode "q=$1" http://127.0.0.1:9980/ ; echo; }

    q "op('/project1/SYNCD/heads')['R_ry'].eval()"              # read a channel
    q "op('/project1/SYNCD/heads').cookFrame"                   # is it cooking?
    q "op('/project1/SYNCD/waveline').par.widthfar.eval()"      # read a parameter
    q "op('/project1/SYNCD/waveline').par.widthfar = 5"         # set one, live
    q "[(o.path, o.warnings()) for o in op('/project1').findChildren(maxDepth=8)
        if o.warnings()]"                                       # every warning at once

An expression is evaluated and its repr returned; a statement is exec'd and returns `OK`;
anything else returns the traceback. Note `findChildren(depth=N)` means *exactly* depth N —
use `maxDepth`, or you will get an empty list and think the file is clean.

Parameter changes made this way are live and are lost on reload: bake anything worth keeping
into `expanded/` and re-collapse.
"""
import io
import os
import shutil
import struct
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(HERE, 'expanded', 'dual-alpha-V16.toe.dir')
SRC_TOC = os.path.join(HERE, 'expanded', 'dual-alpha-V16.toe.toc')
NAME = 'dual-alpha-V16.toe'
SY = 'project1/SYNCD'
PORT = 9980
BIND = '127.0.0.1'

if len(sys.argv) < 2:
    raise SystemExit(__doc__.strip().splitlines()[2].strip())
OUT = sys.argv[1]
D = os.path.join(OUT, NAME + '.dir')
TOC = os.path.join(OUT, NAME + '.toc')

if os.path.exists(D):
    shutil.rmtree(D)
shutil.copytree(SRC_DIR, D)
toc = [l.rstrip('\n') for l in io.open(SRC_TOC, encoding='utf-8')]

CALLBACK = '''# Local debug endpoint. NOT for the show file. Bound to %s only.
# GET http://%s:%d/?q=<python>   evaluates an expression, or execs a statement.
import traceback


def onHTTPRequest(webServerDAT, request, response):
\t# TD pre-parses the query string into request['pars']
\tcode = ''
\ttry:
\t\tcode = request['pars'].get('q', '')
\texcept Exception:
\t\tpass
\tif not code:
\t\ttry:
\t\t\tcode = request['data'].decode('utf-8')
\t\texcept Exception:
\t\t\tcode = ''
\tif not code:
\t\tbody = 'usage: /?q=<python expression>'
\telse:
\t\ttry:
\t\t\tbody = repr(eval(code))
\t\texcept SyntaxError:
\t\t\ttry:
\t\t\t\texec(code, globals())
\t\t\t\tbody = 'OK'
\t\t\texcept Exception:
\t\t\t\tbody = traceback.format_exc()
\t\texcept Exception:
\t\t\tbody = traceback.format_exc()
\tresponse['statusCode'] = 200
\tresponse['statusReason'] = 'OK'
\tresponse['data'] = body
\treturn response
''' % (BIND, BIND, PORT)


def text_bytes(text):
    b = text.encode('utf-8')
    return b'2\n*' + struct.pack('>6I', 1, 1, 1, 1, 2, len(b)) + b


def add(rel, data):
    path = os.path.join(D, *rel.split('/'))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if isinstance(data, bytes):
        io.open(path, 'wb').write(data)
    else:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(data)
    if rel not in toc:
        idx = max(i for i, l in enumerate(toc) if l.startswith(SY + '/'))
        toc.insert(idx + 1, rel)


def node(optype, tile):
    return ('%s\ntile %d %d %d %d\nflags =  parlanguage 0\ncolor 1 0.4 0.4 \nend\n'
            % ((optype,) + tile))


add(SY + '/dbg_callbacks.n', node('DAT:text', (6000, 1200, 130, 90)))
add(SY + '/dbg_callbacks.parm', '?\nlanguage 0 python\n?\n')
add(SY + '/dbg_callbacks.text', text_bytes(CALLBACK))

add(SY + '/dbg_webserver.n', node('DAT:webserver', (6200, 1200, 130, 90)))
add(SY + '/dbg_webserver.parm',
    '?\nactive 0 on\nport 0 %d\nlocaladdress 0 %s\ncallbacks 0 dbg_callbacks\nlanguage 0 text\n?\n'
    % (PORT, BIND))

io.open(TOC, 'w', encoding='utf-8', newline='\n').write(''.join(l + '\n' for l in toc))
print('debug build: %s' % D)
print('  %d toc entries, endpoint on %s:%d' % (len(toc), BIND, PORT))
print('  collapse it, stage as TD/dual-alpha-V16-debug.toe, and never use it for a show')
