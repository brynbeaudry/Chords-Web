#!/usr/bin/env python3
"""Build one zip that makes Dual Alpha V16 runnable on a laptop that has never seen it.

    python3 scripts/make_show_bundle.py [out.zip]
        # default: ../V16-dual-alpha.zip, beside the repo

What goes in
------------
    Chords-Web/      this repository as it stands, including .git *and* `node_modules`, so
                     the show laptop needs no `npm install` -- extract and run. `.next` is
                     left out because `npm run dev` rebuilds it on the first request anyway.

                     Shipping `node_modules` means shipping the native binaries npm picked for
                     *this* machine, so the bundle is **Windows x64 only**. On any other
                     platform, delete the folder and run `npm install`; SETUP.md says so.
    TD/              only the assets `dual-alpha-V16.toe` actually loads, plus the V15
                     fallback and the drum stems. The source `TD.zip` is 821 MB, almost all
                     of it Blender sources (.blend, .blend1) and unused models that the piece
                     never opens; the required set is about 14 MB.
    SETUP.md         what to install and in what order, written for someone starting cold.

Why the TD folder has to exist separately
-----------------------------------------
The File In operators store *bare* file names -- `Face-mono2.obj` and so on -- which
TouchDesigner resolves against the folder of the open project. So the `.toe` has to sit beside
the models, and a copy therefore lives in `TD/` as well as in the repo. `touchdesigner/ASSETS.md`
is the source for this list; it was built by reading every file-path parameter in the expanded
file, and `make_show_bundle` checks each one is present rather than trusting the list.
"""
import os
import shutil
import sys
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TD_SRC = r'C:\Users\Bryn\TD'
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(REPO), 'V16-dual-alpha.zip')

# Build output and caches, pruned **at the repo root only**. `node_modules` is deliberately
# not here: see the header.
#
# Matching these names at any depth is a trap, and it bit once: `out` pruned `fast-glob/out/`,
# which is that package's own source, so the bundle extracted and then died with
# "Cannot find module .../fast-glob/out/index.js". Package directories are named after build
# conventions all the time, so only the top level is pruned.
SKIP_TOP = {'.next', '.turbo', 'out', 'coverage'}

# From touchdesigner/ASSETS.md: every file the show file opens from disk.
MODELS = [
    'Face-mono2.obj', 'Face-mono2.mtl',                      # the two turning faces
    'Face-mono.obj', 'Face-mono.mtl',                        # the ring of copied faces
    'DECH-object only-STAND3.mtl.obj', 'DECH-object only-STAND3.mtl.mtl',
    'SQUARE-object only-STAND3.obj', 'SQUARE-object only-STAND3.mtl',
    'SPHERE-object only-STAND2.obj', 'SPHERE-object only-STAND2.mtl',
    'TRI-object only-STAND2.obj', 'TRI-object only-STAND2.mtl',
    'Wave-container.tox',
]
STEMS = ['break_kick.wav', 'break_snare.wav', 'break_hat_on.wav', 'break_hat_off.wav',
         'break_sub.wav', 'break_reese.wav']
TOES = ['dual-alpha-V16.toe', '20260108_Iterface2V15_Otherworld.toe']

SETUP = """# Dual Alpha V16: setting up a laptop from scratch

Everything the piece needs is in this zip except the two installers, which are downloads.

## 1. Install

| | |
|---|---|
| **TouchDesigner 2025.33230** | the version this file was built against. A newer 2025 build should open it; an older one may not |
| **Node.js 22 LTS** | `node --version` should print v22 or newer. The packages are already in the zip, so there is nothing to install for the app itself |
| **Chrome** or **Edge** | the page needs Web Bluetooth, which Safari and Firefox do not have |

## 2. Put the folders somewhere

* `Chords-Web/` anywhere you like.
* `TD/` anywhere you like — but **keep it together**. The `.toe` loads its models by bare
  file name and resolves them against its own folder, so opening `dual-alpha-V16.toe` from
  anywhere else gives you a scene with no faces and no objects.

## 3. Start Chords-Web

```
cd Chords-Web
npm run dev
```

**No `npm install` needed** — the dependencies are in the zip. That does mean the bundle is
**Windows x64 only**, because npm's native binaries are platform-specific. On a Mac or Linux
box, delete `Chords-Web/node_modules` and run `npm install` instead.

Open **http://localhost:3000/dual-alpha** in Chrome. Use the `localhost` address, not a public
one: the page opens a plain `ws://` socket to TouchDesigner, which a page served over https is
not allowed to do.

## 4. Open TouchDesigner

Open `TD/dual-alpha-V16.toe`. The Chrome toolbar dot should turn green and read
**TD connected**.

## 5. Check it without headsets

```
cd Chords-Web/touchdesigner
python3 mock_sender.py --tour --loop
```

That walks every documented state in a 90 s loop: one person alone, both together, the merge,
a side greying out. Stop it before connecting a real headset — two senders write the same
operator and their values interleave.

## Then read

`Chords-Web/touchdesigner/OPERATOR_GUIDE.md` is the run-the-show document: what to press, in
what order, what each reading means, and what to do when something looks wrong. The settings
that matter on a new laptop are in its section 1.

`Chords-Web/touchdesigner/TD_CHANGES.md` records every change made to Kaz's V15 and why,
including what was measured to confirm it.

`Chords-Web/touchdesigner/ASSETS.md` lists what the `.toe` loads from disk — read it before
moving any file in `TD/`.
"""


def main():
    missing = []
    stage_files = []        # (absolute source, path inside the zip)

    # ── the repo ──────────────────────────────────────────────────────────────────────────
    for root, dirs, files in os.walk(REPO):
        if os.path.relpath(root, REPO) == '.':
            dirs[:] = [d for d in dirs if d not in SKIP_TOP]
        for f in files:
            src = os.path.join(root, f)
            stage_files.append((src, os.path.join('Chords-Web', os.path.relpath(src, REPO))))

    # ── the TD folder, only what the file opens ───────────────────────────────────────────
    for name in MODELS + TOES:
        src = os.path.join(TD_SRC, name)
        (stage_files.append((src, os.path.join('TD', name)))
         if os.path.exists(src) else missing.append(name))
    # The stems live in the repo and are copied next to the .toe, as ASSETS.md says.
    for name in STEMS:
        src = os.path.join(REPO, 'touchdesigner', 'audio', name)
        (stage_files.append((src, os.path.join('TD', name)))
         if os.path.exists(src) else missing.append('audio/' + name))

    if missing:
        print('missing, so the bundle would not run:')
        for m in missing:
            print('  ' + m)
        return 1

    total = sum(os.path.getsize(s) for s, _ in stage_files)
    print('%d files, %.0f MB before compression' % (len(stage_files), total / 1e6))

    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.writestr('SETUP.md', SETUP)
        for src, rel in stage_files:
            z.write(src, rel)

    print('wrote %s  (%.0f MB)' % (OUT, os.path.getsize(OUT) / 1e6))

    # Count node_modules on disk against the zip. A bundle that is quietly short a few files
    # extracts fine and then fails at the first import, which is a miserable thing to discover
    # on the show laptop -- so it is checked here instead.
    nm = os.path.join(REPO, 'node_modules')
    if os.path.isdir(nm):
        on_disk = sum(len(fs) for _, _, fs in os.walk(nm))
        with zipfile.ZipFile(OUT) as z:
            in_zip = sum(1 for n in z.namelist() if n.startswith('Chords-Web/node_modules/'))
        print('node_modules: %d files on disk, %d in the zip%s'
              % (on_disk, in_zip, '' if on_disk == in_zip else '   <-- MISMATCH'))
        if on_disk != in_zip:
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
