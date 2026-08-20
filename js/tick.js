/* Fixed-timestep loop.
 *
 * The whole identity is world.tick() — so the visible counter and the point
 * cloud must advance off the same clock. Everything that moves subscribes
 * here; nothing gets its own interval or reads rAF timestamps directly.
 *
 * Accumulator pattern: rAF fires at whatever rate the display runs at, and we
 * drain it into a fixed 60Hz simulation step. A 120Hz screen and a struggling
 * phone therefore produce identical behaviour, just at different smoothness.
 */

export const TICK_HZ = 60;

const STEP_MS = 1000 / TICK_HZ;

/* A tab that was backgrounded, or a phone that stalled on a GC pause, can
 * return a delta of many seconds. Simulating all of it would freeze the page
 * while it caught up, so we drop the excess instead. */
const MAX_FRAME_MS = 250;

export function createTicker({ reducedMotion = false } = {}) {
  let tick = 0;
  let accumulator = 0;
  let last = 0;
  let raf = 0;
  let running = false;

  const stepSubs = new Set();
  const frameSubs = new Set();

  function frame(now) {
    raf = requestAnimationFrame(frame);

    let delta = now - last;
    last = now;
    if (delta > MAX_FRAME_MS) delta = MAX_FRAME_MS;
    accumulator += delta;

    while (accumulator >= STEP_MS) {
      accumulator -= STEP_MS;
      tick += 1;
      for (const fn of stepSubs) fn(tick);
    }

    // alpha is how far we are between the last step and the next one, for
    // renderers that want to interpolate rather than judder at low frame rates.
    const alpha = accumulator / STEP_MS;
    for (const fn of frameSubs) fn(tick, alpha);
  }

  const api = {
    get tick() { return tick; },
    get running() { return running; },
    reducedMotion,

    /** Called once per fixed 60Hz step. Simulation goes here. */
    onStep(fn) { stepSubs.add(fn); return () => stepSubs.delete(fn); },

    /** Called once per animation frame. Rendering goes here. */
    onFrame(fn) { frameSubs.add(fn); return () => frameSubs.delete(fn); },

    start() {
      if (running) return api;
      running = true;
      last = performance.now();
      accumulator = 0;
      raf = requestAnimationFrame(frame);
      return api;
    },

    stop() {
      if (!running) return api;
      running = false;
      cancelAnimationFrame(raf);
      raf = 0;
      return api;
    },

    /** Advance without rendering — used to pre-resolve the static frame. */
    advance(steps) {
      for (let i = 0; i < steps; i++) {
        tick += 1;
        for (const fn of stepSubs) fn(tick);
      }
      for (const fn of frameSubs) fn(tick, 0);
      return api;
    },
  };

  /* Don't burn battery rendering a tab nobody is looking at. On resume the
   * accumulator is reset by start(), so we never try to simulate the gap. */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (running) { api.stop(); api._wasRunning = true; }
    } else if (api._wasRunning) {
      api._wasRunning = false;
      api.start();
    }
  });

  return api;
}

/** Zero-padded, fixed width, so the counter never changes layout width. */
export function formatTick(value, width = 7) {
  return String(value % 10 ** width).padStart(width, '0');
}
