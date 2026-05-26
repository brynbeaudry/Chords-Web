% Alpha Predominance Detection — Diagnosis & Improvement Plan
% Chords-Web · dual-stream EEG → TouchDesigner
% Prepared 2026-05-24 · revised 2026-05-25 (alpha-only, spectral prominence)

## 1. Executive summary

The on-chart "alpha predominant region" highlight only lights up during **wild
activity** (large bursts, artifacts). The **subtle, clinically real alpha** that
the doctors demonstrated — e.g. the eyes-closed / relaxed alpha rise — is **not
detected**.

This is **not a tuning accident**; it is structural. The current detector asks a
question alpha can almost never answer "yes" to:

> *"Within this sample, does the alpha band hold more than 50% of the combined
> alpha + theta + delta power, and lead the runner-up by 15 points, continuously
> for ~0.48 s?"*

Because EEG power falls off with frequency (the **1/f spectrum**), delta and
theta carry far more raw power than alpha at rest. Alpha rarely wins that
absolute three-way contest even when it genuinely rises. So only freak spikes
cross the line.

**The fix** is to stop scoring alpha against delta/theta and instead score
**alpha by its spectral prominence** — how far the ~10 Hz bump rises above the
1/f background at its own neighbouring frequencies (delta excluded). That is
unit-free, needs no calibration, and fires whenever real alpha is present during
*any* activity. Add **artifact rejection** so blinks don't mask or fake it, and
**hysteresis** so natural waxing/waning isn't chopped up.

**Scope:** this is **alpha-only**. Theta and delta predominance detection (the
`is_theta` / `is_delta` booleans) is removed for now — they existed only as
alpha's opponents in the old 3-way ratio, which we are abandoning. TouchDesigner
receives a single `is_alpha` flag per channel.

\newpage

## 2. How detection works today

### 2.1 Signal chain (per channel, per sample)

```
 raw ADC count (12-bit, one channel)
        |
        v
 +--------------------------+
 | HighPass 1 Hz (Butter)   |  remove DC / slow drift  ->  hpOutput (raw counts)
 +-----------+--------------+
             |
             |  hpOutput is fanned out, UNSCALED, to three band envelopes
   +---------+-----------------+-----------------------+
   v                           v                       v
 +-----------+            +-----------+           +-----------+
 | Alpha BP  |            | Theta BP  |           | Delta BP  |   BandpassFilter
 | 8-12 Hz   |            | 4-7.5 Hz  |           | 1-4 Hz    |   (biquad HP+LP)
 +-----+-----+            +-----+-----+           +-----+-----+
       v                        v                       v
     v * v                    v * v                   v * v       square = power
       v                        v                       v
   EMA tau~500ms            EMA tau~500ms           EMA tau~500ms  single-pole
       v                        v                       v
      pA                       pT                      pD          smoothed powers
       +------------------------+-----------------------+
                                v
                       total = pA + pT + pD
                                v
            rA = pA/total   rT = pT/total   rD = pD/total
                                v
 +---------------------------------------------------------------+
 | classify THIS sample (only enabled bands compete):            |
 |   alpha(1) if rA >= 0.50  AND  rA - max(rT,rD) >= 0.15         |
 |   theta(2) if rT >= 0.50  AND  rT - max(rA,rD) >= 0.15         |
 |   delta(3) if rD >= 0.50  AND  rD - max(rA,rT) >= 0.15         |
 |   else none(0)                                                 |
 +-------------------------------+-------------------------------+
                                 v
        push label code into the per-channel ring buffer
```

Code: classification `page.tsx:910-943`; envelope `filters.tsx:343-392`;
bandpass `filters.tsx:220-339`.

### 2.2 Stage C — region decision (longest run)

```
 ring buffer over the visible window (timeBase 4 s = 2000 samples @ 500 Hz):

 idx ->  0                                                         N-1
 label   0 0 1 1 1 1 0 0 2 2 0 1 1 1 1 1 1 1 1 1 1 0 0 3 3 0 0 ...
                            |<------- run of '1' = alpha ------->|
                                          length L

 scanLongestRun() = longest CONSECUTIVE run of one non-zero code.
 Highlight that band  iff  L >= minRunFrac * N = 0.12 * 2000 = 240 samples
                                                             = 0.48 s continuous.
```

Code: `scanLongestRun` `page.tsx:1706-1734`; threshold `page.tsx:1758-1762`.

### 2.3 Current parameters

| Param          | Value   | Meaning / derived                                  |
|----------------|---------|----------------------------------------------------|
| samplingRate   | 500 Hz  | also supports 250 Hz                               |
| timeBase (N)   | 4 s     | ring length N = 2000 samples                       |
| `dominance`    | 0.50    | a band must hold >= 50% of (pA+pT+pD)              |
| `margin`       | 0.15    | and lead the runner-up by >= 15 points             |
| `minRunFrac`   | 0.12    | run must last >= 0.48 s continuously               |
| `emaMs`        | 500 ms  | power smoothing, EMA alpha = 1/(0.5*500) = 0.004   |
| `noiseFloor`   | 1e-6    | in counts^2 -> effectively inert (see 4.F)         |

Code: `DEFAULT_DETECTION_PARAMS` `page.tsx:213-219`; ring init `page.tsx:300-303`.

\newpage

## 3. What alpha actually looks like (the target signal)

This is the signal the doctors pointed at — the thing we must catch. Two views,
both with time on the x-axis.

**Up close (~1 s): a ~10 Hz rhythm that waxes and wanes (an alpha "spindle").**

```
 amp (counts)          amplitude envelope:  waxes -> peaks -> wanes
  +30 |                 .-''''''''''''-.
  +20 |             .-''                ''-.
  +10 |   /\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\      ~10 Hz carrier (8-13 Hz)
    0 +--/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\--------------> time
  -10 |   \/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/
  -20 |             '-..                ..-'
  -30 |                 '-............-'
      +------|-----------|-----------|-----------|----------|----->
            0.0         0.25        0.50        0.75       1.0    s
                  |<--------- one alpha spindle (~10 Hz) --------->|
```

**Over time (~5 s): eyes-open vs eyes-closed vs a blink artifact.**

```
 amp     EYES OPEN                EYES CLOSED  =  ALPHA            EYE BLINK
   ^     (low, irregular,         (rhythmic ~10 Hz band that       (one big, SLOW
   |      alpha suppressed)        waxes & wanes; subtle)           deflection)
   |                              .-'''''-.      .-''-.                 _
   |   /\   /\   /\        /\/\/\/\/\/\/\/\/\/\/\/\/\/\/\           ___/   \___
 0 +--/\/\-/\\-/\-/\---/\-/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\-------/           \--> t
   |  \/  \/  \/  \/      \/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\        (artifact: huge
   |                              '-.....-'      '-..-'           & slow = NOT alpha)
   +---|------|------|------|------|------|------|------|------|------|-----> time (s)
      0.5    1.0    1.5    2.0    2.5    3.0    3.5    4.0    4.5    5.0
                              [===== alpha present: DETECT =====]   [== reject ==]
```

What should drive detection is the **alpha envelope** (the dashed humps) measured
against the eyes-open baseline — *not* the absolute height of the trace. A blink
has a huge envelope too, but it lives below ~4 Hz (delta) with a tell-tale slow
monophasic shape, so the artifact gate must reject it. Key properties:

- **Frequency:** ~8-13 Hz (about 10 cycles/s). *Note:* the code currently
  bandpasses **8-12 Hz**, which clips fast (12-13 Hz) alpha — consider widening.
- **Amplitude:** we read **uncalibrated device units (12-bit ADC counts, 0-4095),
  not volts**. There is no counts->volts calibration, so absolute level has *no
  fixed meaning* across people, sessions, or electrodes. Within one recording,
  alpha is *modest* and usually *smaller* than delta/theta. (Clinical literature
  cites ~10-50 µV, but we cannot map our counts to µV without a known reference.)
- **Time course:** comes and goes in 0.5-2 s bursts; strongest eyes-closed/relaxed,
  and *suppressed* by attention / eye-opening (that suppression is itself signal).
- **Not alpha:** big slow swings (blinks), sharp spikes (movement, EMG) — artifacts
  to gate out, not detections.

> **Units note.** The device streams uncalibrated ADC counts, not volts. That is
> not a limitation here — it is *why* the detector must be **relative**. The
> usable, scale-free properties of alpha are its **frequency (8-13 Hz)**, its
> **time course (~1 s waxing/waning spindles)**, and its **reactivity (eyes-open
> vs eyes-closed)**. Absolute amplitude — in counts or µV — is not a usable
> threshold; the baseline-normalization in Section 5 is what makes the signal
> measurable without ever knowing the voltage.

## 4. Why subtle alpha is missed

### A. The 1/f spectrum — the dominant cause

EEG power falls off steeply with frequency. At rest, delta (1-4 Hz) and theta
(4-7.5 Hz) carry most of the power; alpha (8-12 Hz) is physiologically a small
slice. The detector compares **absolute** band power, so alpha is fighting
uphill.

```
 power
  ^
  | ##
  | ##  ##
  | ##  ##
  | ##  ##  ..          ## delta   ## theta   .. alpha
  | ##  ##  ..
  +--delta--theta--alpha--> band         (schematic 1/f falloff)
    pD~0.55  pT~0.30  pA~0.15   (fraction of total at rest)

 A HEALTHY eyes-closed alpha rise (alpha roughly doubles, delta/theta dip a bit):
     pA: 0.15 -> 0.30,  pD: 0.55 -> 0.45,  pT: 0.30 -> 0.25
     rA = 0.30 / (0.45 + 0.25 + 0.30) = 0.30   ->  still < 0.50   ->  NOT detected
```

The detector effectively asks *"does alpha beat delta + theta combined?"* — which
even strong physiological alpha usually cannot. Only a freak spike crosses 0.50,
which is exactly the "wild activity" behaviour observed.

### B. Wrong reference — alpha is judged against the 1/f floor

"Alpha is predominant" should mean *there is a peak at ~10 Hz standing above the
background*. The current code instead measures alpha as a fraction of
alpha+theta+delta — i.e. it judges alpha against the **1/f floor itself**
(delta+theta), the one reference alpha can never beat. The right reference is
alpha's **spectral neighbours** (the background just beside the alpha band), not
the low-frequency bulk. This does **not** require any baseline capture or
eyes-open/closed step.

### C. Eye blinks & movement artifacts corrupt the ratio

Blinks/movement are large **low-frequency** transients. They (1) inflate `total`
via delta/theta, pushing `rA` **down** — so a real alpha moment right after a
blink is suppressed — and (2) can themselves register as delta/theta runs. There
is currently **no artifact rejection**, so artifacts both *mask* real alpha and
*fake* other bands.

### D. Thresholds are tuned for a contest alpha can't win

`dominance = 0.50` + `margin = 0.15` are reasonable for a winner-take-all 3-way
split, but per (A) that split is the wrong frame for alpha. Lowering them alone
won't fix it cleanly — it would just make delta/theta trip more often too.

### E. Hard continuous-run requirement chops natural alpha

Real alpha waxes and wanes. The "longest **consecutive** run >= 0.48 s" rule
resets on a single sub-threshold sample. Combined with (A)-(D), brief, genuine
alpha episodes never accumulate a long enough unbroken run.

### F. `noiseFloor` is mis-scaled and inert

Envelopes run on **raw ADC counts** (`hpOutput`), so powers are in counts^2
(tens to thousands). `noiseFloor = 1e-6` is in those units, so `total >=
noiseFloor` is essentially always true — the gate does nothing. Not the cause of
the miss, but worth noting: there is currently **no** effective low-power /
noise gate.

\newpage

## 5. Proposed approach — single-band alpha by spectral prominence

Score alpha by how much it stands **above the background at its own neighbouring
frequencies** — a peak/bump detector. Unit-free, no calibration, no eyes
protocol. Keep the existing bandpass + envelope machinery; only change *what we
compare to*. **Alpha-only** — no theta/delta detection.

```
 hpOutput (one channel)
    |
    +--> Alpha BP     8-13 Hz --> square --> EMA(~250 ms) = P_alpha
    |
    +--> Reference (delta EXCLUDED): flanks ~6-7 Hz & ~13-15 Hz,
    |        or broadband 6-20 Hz   --> square --> EMA = P_ref
    |
    +--> Artifact probe: |raw| amplitude OR low-freq(0.5-3 Hz) power
             |
             v   over threshold ->  mark sample ARTIFACT (blink/move)

  Alpha prominence (per sample, per channel):
      prom = P_alpha / P_ref      (~1 when no alpha bump; > 1 when a ~10 Hz peak
                                   sits above the local background)

  Region decision with hysteresis + min duration (Schmitt trigger):
      OFF -> ON   when  prom >= ENTER_HI  sustained >= T_on   AND not ARTIFACT
      ON  -> OFF  when  prom <  EXIT_LO   sustained >= T_off

   prom ^                  ____________
   ENTER_HI ------------- /            \ ----------------
    EXIT_LO ------ ______/              \____ ----------
        +-------------------------------------------------> time
                       [   alpha predominant region   ]
```

**Why this detects subtle alpha:** `prom` asks "is there a ~10 Hz peak above the
nearby background right now?" — independent of absolute scale and of how big
delta is (the 1/f floor cancels, since it sits in both `P_alpha` and `P_ref`). A
modest-but-real alpha bump registers. No baseline capture, no eyes-open/closed
step, works during any activity.

*Optional refinement:* a very slow per-channel normaliser can ride out electrode
/ impedance drift, but it is secondary — `prom` works on its own.

\newpage

## 6. Phased implementation plan

**Phase 1 — Instrument before tuning.**
Expose the live numbers so we can see what the doctors see: plot/stream
`P_alpha`, `P_ref`, and `prom` per channel, and log them. Add a debug overlay/CSV
so a clinician can mark "alpha here" against the traces. *Goal: ground truth.*

**Phase 2 — Prominence metric + artifact gate; remove theta/delta.**
Add the delta-excluded reference (`P_ref`) and the artifact probe, and compute
`prom = P_alpha / P_ref`. **Rip out the 3-way absolute ratio and the `is_theta` /
`is_delta` detection booleans** — alpha-only from here. *Goal: subtle alpha
becomes visible; the wire to TD carries just `is_alpha`.*

**Phase 3 — Hysteresis + min-duration region logic.**
Replace "longest consecutive run >= 0.48 s" with enter/exit thresholds on `prom`
and `T_on`/`T_off` durations driving the highlight + the `is_alpha` flag to TD.
*Goal: stable regions that track natural waxing/waning.*

**Phase 4 — Per-channel tuning + validation.**
Per-channel `ENTER_HI / EXIT_LO / T_on / T_off` and artifact-threshold controls.
Validate against clinician-labeled recordings (Section 7). No baseline-capture
step — `prom` needs no calibration. *Goal: trustworthy on real sessions.*

**Phase 5 — Later (out of scope now).**
Re-introduce theta/delta if needed, each with its own prominence reference;
consider FFT/Welch PSD over a sliding window if envelope estimates prove too coarse.

## 7. Validation method (uses the replay path)

We already made recording + background-safe replay → TouchDesigner. Use it:

1. Record clips of the **actual activities** where alpha should rise (and, as an
   easy known-good check, one eyes-open->eyes-closed clip — optional, not required).
2. Have a clinician mark where real alpha is.
3. Replay and compare detector output (`prom`, regions, `is_alpha`) to the marks.
4. Tune `ENTER_HI / EXIT_LO / T_on / T_off` and the artifact threshold to match.

Replay is deterministic and now runs even when backgrounded, so the same file
can be re-scored repeatedly while tuning.

## 8. Risks & open questions

- **Alpha-only scope.** Theta/delta detection is removed; only `is_alpha` is
  produced. Re-adding them later means giving each its own prominence reference.
- **Reference-band choice (`P_ref`).** Flanks (~6-7 & ~13-15 Hz) track the local
  1/f best; broadband 6-20 Hz is simpler but includes beta — revisit if
  movement/EMG beta inflates `P_ref` and suppresses `prom`.
- **Sampling rate** (250 vs 500 Hz) changes EMA constants — keep `prom`
  rate-independent.
- **Artifact threshold** is montage/impedance dependent — must be tunable per channel.
- **Electrode placement decides the channel** — each displayed channel *is* one
  electrode's reading (3 channels = 3 electrodes per device), and detection runs
  per channel. "Which channel carries alpha" is a *physical placement* question:
  put an electrode over the **occiput** (O1/O2/Oz) and enable alpha detection on
  that channel. A **central** electrode may instead show **mu rhythm**
  (alpha-frequency, reacts to movement not eye-opening) — it can still produce an
  alpha-band peak, so placement, not the algorithm, is what keeps mu out.

## Appendix — code references

| Concept                         | Location                                  |
|---------------------------------|-------------------------------------------|
| Per-sample classification       | `src/app/dual-stream/page.tsx:910-943`    |
| `scanLongestRun`                | `src/app/dual-stream/page.tsx:1706-1734`  |
| Stage C run threshold           | `src/app/dual-stream/page.tsx:1758-1762`  |
| `DEFAULT_DETECTION_PARAMS`      | `src/app/dual-stream/page.tsx:213-219`    |
| Label ring init (N = sr*timeBase)| `src/app/dual-stream/page.tsx:300-303`   |
| `BandPowerEnvelope`             | `src/components/filters.tsx:343-392`      |
| `BandpassFilter` (per band)     | `src/components/filters.tsx:220-339`      |
