"""Report every parameter in the *running* file that disagrees with `expanded/` on disk.

Run it inside TouchDesigner, through the debug endpoint:

    exec(open(r'C:\\Users\\Bryn\\Chords-Web\\touchdesigner\\scripts\\live_diff.py').read())

and the result lands in `LIVE_DIFF` (a list of strings), so the next query can read it in
pieces without a huge HTTP response.

Why this exists
---------------
Edits made by hand in TouchDesigner live only in memory: reload the file and they are gone.
When someone has been tuning the look in the running instance, the edits have to be found and
baked into `expanded/` *before* anything triggers a reload -- and "which operator did you
touch?" is not a reliable way to find them.

A `.parm` file stores exactly the parameters that are not at their default value, which is the
same set TouchDesigner will report through `par.isDefault`. So the two are directly
comparable, and the diff finds every hand edit rather than the ones somebody remembered.

Numbers are compared as numbers (TouchDesigner prints 3.0 where the file says 3), expressions
as text. Parameters that are expressions on both sides and agree are skipped.
"""
import os

EXPANDED = r'C:\Users\Bryn\Chords-Web\touchdesigner\expanded\dual-alpha-V16.toe.dir'
ROOT = '/project1'
# Operators added only to the debug build, which `expanded/` rightly does not contain.
SKIP_PREFIX = ('dbg_',)


def _toks(line):
    """Split a .parm line, respecting double quotes (same rule verify_toe.py uses)."""
    out, cur, inq = [], '', False
    for ch in line:
        if ch == '"':
            inq = not inq
        elif ch == ' ' and not inq:
            if cur:
                out.append(cur)
            cur = ''
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def _file_pars(op_path):
    """{name: (mode, value-as-text)} from this operator's .parm file, or None if absent.

    A line is `name mode cached [expr]`. Mode 0 is a plain constant; 17 is an expression; the
    higher numbers are binds and exports. Only constants are worth comparing here -- the
    expressions are already checked by verify_toe.py, which compares them as text.
    """
    rel = op_path.lstrip('/').replace('/', os.sep)
    path = os.path.join(EXPANDED, rel + '.parm')
    if not os.path.exists(path):
        return None
    out = {}
    for line in open(path, encoding='utf-8'):
        line = line.rstrip('\n')
        if not line or line.startswith('?'):
            continue
        t = _toks(line)
        if len(t) >= 3:
            out[t[0]] = (t[1], t[2])
    return out


# TouchDesigner hands back True/False where the file stores on/off, and 3.0 where it stores 3.
_BOOL = {'on': True, 'off': False, '1': True, '0': False, 'true': True, 'false': False}


def _same(live, text):
    if isinstance(live, bool):
        return _BOOL.get(str(text).strip().lower()) is live
    try:
        return abs(float(live) - float(text)) < 1e-6
    except (TypeError, ValueError):
        return str(live).strip() == str(text).strip()


LIVE_DIFF = []
_missing = 0
for o in op(ROOT).findChildren(maxDepth=12):
    if o.name.startswith(SKIP_PREFIX):
        continue
    fp = _file_pars(o.path)
    if fp is None:
        _missing += 1
        continue
    for p in o.pars():
        try:
            if p.isDefault:
                continue
        except Exception:
            continue
        if p.mode.name == 'EXPRESSION':
            continue                      # expressions are compared by verify_toe.py
        name, live = p.name, p.val
        if name in ('exttcop', 'rate', 'autoexportroot'):
            continue                      # bookkeeping, always expressions upstream
        if name not in fp:
            LIVE_DIFF.append('%s . %s = %r   (not in the file at all)' % (o.path, name, live))
            continue
        mode, text = fp[name]
        if mode != '0':
            continue                      # bound or exported in the file, not a hand edit
        if not _same(live, text):
            LIVE_DIFF.append('%s . %s : file %s -> live %r' % (o.path, name, text, live))

LIVE_DIFF.sort()
LIVE_SUMMARY = '%d differences, %d operators had no .parm file' % (len(LIVE_DIFF), _missing)
print(LIVE_SUMMARY)
