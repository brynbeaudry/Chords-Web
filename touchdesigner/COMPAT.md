# Compatibility: App Page, Contract and TD File

Which page of the app goes with which TouchDesigner file, what each sends, and how to rebuild and check the `.toe` in this folder.

---

## The two pairs

| Page | App | Contract | TD file | Callback in the file |
|---|---|---|---|---|
| `/dual-alpha` | 2.7.0a (this branch, `dual-alpha`) | **v2**: one JSON message every 128 ms, 10 keys | `dual-alpha-V16.toe` (this folder) | `callback_v3.py` |
| `/dual-stream` | unchanged page, any build since `61e864a` | **v1**: one JSON message per sample (~1000 a second), 25 positional slots | Kaz's `20260108_Iterface2V15_Otherworld.toe` (V15, not in the repo) | `touchdesigner_websocket.py` at the repo root (byte-identical to V15's) |

**The pairs are not interchangeable.** Both pages send to port 9000, so only one may be open at a time.

| Mismatch | What happens |
|---|---|
| `/dual-stream` → V16 | every message lights `contract_error`; no values are taken; after 2 s both sides grey and "CONTRACT ERROR" and "NO DATA" show on the `/controls` panel |
| `/dual-alpha` → V15 | V15's callback writes 0 into all 25 slots (the v2 keys are not among them): the visuals sit still. Nothing marks the error in V15 |

The file names its pair inside: `/project1/SYNCD/container1websocket_example/compat_info` reads `contract v2 · app 2.7.0a · /dual-alpha`.

## Contract v2, as V16 reads it

`{"v":2,"fs":125,"n":int,"d1_level":0-1,"d1_ok":0/1,"d2_level":0-1,"d2_ok":0/1,"pair_level":0-1,"d1_w":[16 floats],"d2_w":[16 floats]}`

- `v` must be 2 and `fs` must be 125, else the message is refused (`contract_error`).
- `n` is the index of the first of the 16 samples; it rises by 16 per message. A jump forward is filled by holding the last sample; a jump back restarts the buffer.
- Missing level/ok keys keep their last value; `STATE` turns both people not ok after 2 s without a valid message.
- Plan: `docs/alpha-v2/dual-alpha-route-2026-11-18.md` §4.

## Files in this folder

| File | What |
|---|---|
| `dual-alpha-V16.toe` | the show file (built from V15; see `TD_CHANGES.md`) |
| `expanded/dual-alpha-V16.toe.dir/`, `expanded/dual-alpha-V16.toe.toc` | the same file as text, from `toeexpand`, for diffs and review |
| `callback_v3.py` | the Web Server DAT callback inside the file, standalone |
| `td_py/wave_callbacks.py`, `td_py/pair_logic_callbacks.py`, `td_py/heads_callbacks.py` | the three Script CHOP callbacks inside the file |
| `mock_sender.py` | sends a recorded `td_stream.jsonl` or a scripted two-person stream to TD |
| `TD_CHANGES.md` | every change V15 → V16, with checks and the "confirm on first open" list |
| `ASSETS.md` | the models and media the file loads, which are not in the repo |
| `scripts/` | expand, collapse, build, verify and test tools (below) |
| `scripts/make_debug_build.py` | builds a local-only copy with a Python query endpoint, for inspecting the file while it runs ([below](#inspecting-the-file-while-it-runs)). Never used for a show |

**The `.py` files are the source of truth.** `scripts/verify_toe.py` fails if the Python inside the `.toe` differs from them.

## Rebuilding and checking the `.toe`

`toeexpand` and `toecollapse` ship with TouchDesigner (`TouchDesigner.app/Contents/MacOS/` on macOS, `bin\` on Windows). They also run on a Mac without TouchDesigner being able to run: take them from the official installer image.

| Task | Command (from `touchdesigner/`) |
|---|---|
| `.toe` from the text copy | `scripts/td-collapse.sh` (by hand: `cd expanded && toecollapse dual-alpha-V16.toe.dir`, then move `expanded/dual-alpha-V16.toe` up one folder) |
| text copy from the `.toe`, after saving in TD | `scripts/td-expand.sh` |
| is the text copy current? | `scripts/td-expand.sh --check` |
| rebuild V16 from V15 | `toeexpand 20260108_Iterface2V15_Otherworld.toe`, then `python3 scripts/build_v16_from_v15.py <V15>.toe.dir <V15>.toe.toc expanded`, then `scripts/td-collapse.sh` |
| static checks | `python3 scripts/verify_toe.py <V15>.toe.dir <V15>.toe.toc` |
| logic tests | `python3 scripts/test_td_logic.py` |
| socket test without TD | `python3 scripts/ws_test_server.py --seconds 65` and, in a second terminal, `python3 mock_sender.py --synthetic` |

Set `TOEEXPAND` / `TOECOLLAPSE` to the tools' paths if they are not in the default install location. `toeexpand` exits with status 1 even when it succeeds; the scripts judge success by its output. `toecollapse` packs only what the `.toc` lists, so a file added to `expanded/` needs a `.toc` line.

**After editing in TouchDesigner**, save, run `scripts/td-expand.sh`, and commit the `.toe` and `expanded/` together. If the Python in a DAT changed, copy it back to its `.py` file so `verify_toe.py` stays green.

## Inspecting the file while it runs

Most of what goes wrong here is invisible in the expanded text: a parameter being ignored, a
CHOP quietly emitting one sample instead of two, an expression naming an operator that was
renamed. `scripts/make_debug_build.py` takes `expanded/` and adds a query endpoint, so those
questions take one request instead of a rebuild-and-look cycle.

| Task | Command (from `touchdesigner/`) |
|---|---|
| build it | `python3 scripts/make_debug_build.py /tmp/dbg` |
| collapse it | `cd /tmp/dbg && toecollapse dual-alpha-V16.toe.dir` |
| stage it | copy the result into the `TD/` folder as `dual-alpha-V16-debug.toe` |
| query it | `curl -s --get --data-urlencode "q=<python>" http://127.0.0.1:9980/` |

A handy shell helper:

```sh
q() { curl -s --get --data-urlencode "q=$1" http://127.0.0.1:9980/ ; echo; }

q "op('/project1/SYNCD/heads')['R_ry'].eval()"                 # read a channel
q "op('/project1/SYNCD/heads').cookFrame"                      # is it cooking?
q "op('/project1/SYNCD/waveline').par.widthfar.eval()"         # read a parameter
q "op('/project1/SYNCD/waveline').par.widthfar = 5"            # set one, live
q "[(o.path, o.warnings()) for o in op('/project1').findChildren(maxDepth=8) if o.warnings()]"
```

An expression is evaluated and its `repr` returned; a statement is exec'd and returns `OK`;
anything else returns the traceback.

Two traps worth knowing. `findChildren(depth=N)` matches **exactly** depth N — use `maxDepth`,
or an empty list will look like a clean file. And parameter changes made this way are live only:
bake anything worth keeping into `expanded/` and re-collapse, or it dies with the process.

**This is not a show file.** The endpoint executes arbitrary Python that is sent to it. It is
bound to `127.0.0.1` through the Web Server DAT's `localaddress` parameter, which matters: left
blank, a Web Server DAT listens on *every* interface, which on a venue network is remote code
execution. Verified bound — loopback answers, and the machine's own LAN address refuses.

- Never use a debug build for a show, or leave one running unattended.
- Never copy it over `dual-alpha-V16.toe`.
- The show file is the one with no `dbg_*` operators: `grep -c dbg_webserver expanded/*.toc`
  is 0, and nothing listens on 9980 while it runs.

## Sending test data

| Goal | Command |
|---|---|
| the scripted scenario, forever | `python3 mock_sender.py --synthetic --loop` |
| every head state, for checking the look | `python3 mock_sender.py --tour --loop` (90 s; both sides through away, solo reach, together, deeper, grey, stale) |
| a recording at its own timing | `python3 mock_sender.py --file <session>.td_stream.jsonl --loop` |
| TD on another machine | add `--host <PC address> --port 9000` (open port 9000 in the Windows firewall) |

`mock_sender.py` needs Python 3 only. It uses the `websockets` package if installed, else its own RFC 6455 client (`--stdlib` forces that).

**Use `--stdlib` for long or looping runs against TouchDesigner.** The `websockets` package sends keepalive pings; the Web Server DAT does not answer them, so the sender hangs up with `keepalive ping timeout` after a few minutes. The built-in client does not ping and runs indefinitely.
