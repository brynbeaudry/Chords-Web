// Background-safe clock for the dual-stream pipeline.
//
// requestAnimationFrame is paused by the browser whenever the tab is hidden or
// the window is occluded — which happens when TouchDesigner is brought to the
// foreground. That froze any rAF-driven work and stopped data reaching TD. A
// dedicated worker's timers are NOT subject to the main thread's background
// throttling, so this fires a steady tick the page uses for two jobs:
//
//   - Replay: drain recorded rows due by the replay wall-clock and feed them
//     through the shared pipeline to TouchDesigner.
//   - Live + Replay: recompute the Stage C predominance verdicts
//     (is_alpha/is_theta/is_delta) so those flags stay fresh and keep flowing
//     to TouchDesigner even while the browser is backgrounded.
//
// In live mode the raw/filtered channels and band magnitudes already keep
// flowing on their own (BLE notifications are event-driven, not rAF-throttled);
// this tick is what keeps the Stage C booleans alive alongside them.

let timer: ReturnType<typeof setInterval> | null = null;

self.onmessage = (event: MessageEvent) => {
  const { action, intervalMs } = event.data ?? {};
  switch (action) {
    case 'start': {
      if (timer !== null) clearInterval(timer);
      const ms = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : 8;
      timer = setInterval(() => {
        self.postMessage({ tick: true });
      }, ms);
      break;
    }
    case 'stop': {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      break;
    }
  }
};
