/* Boot.
 *
 * Order matters: the counter and the scroll reveals start immediately and
 * cost nothing, then the 3D stage is imported lazily so ~670KB of renderer
 * never sits on the critical path. If it fails to load or the device has no
 * usable GPU backend, the poster stays and the page is unaffected.
 */

import { createTicker, formatTick } from './tick.js';
import { initReveals } from './reveal.js';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ticker = createTicker({ reducedMotion });

initReveals({ reducedMotion });
initCounter();
initStage();

/* ---------- Counter ---------- */

function initCounter() {
  const el = document.getElementById('tick-value');
  if (!el) return;

  if (reducedMotion) {
    // Frozen at a plausible value rather than zero — a stopped clock reading
    // 0000000 looks broken, which is worse than not animating.
    el.textContent = formatTick(108_540);
    return;
  }

  ticker.onFrame((tick) => { el.textContent = formatTick(tick); });
  ticker.start();
}

/* ---------- Stage ---------- */

async function initStage() {
  const root = document.querySelector('.stage');
  const canvas = document.getElementById('stage-canvas');
  const hero = document.querySelector('.hero');
  if (!root || !canvas) return;

  // Cheap gate before pulling in the renderer at all: a browser with no WebGL2
  // and no WebGPU has nothing to gain from the download.
  if (!navigator.gpu && !hasWebGL2()) return;

  /* Commit to the scene now and drop the poster, rather than holding a picture
   * of the resolved city over the wait and then dissolving it into the very
   * convergence it gives away. See .stage.will-render in the stylesheet.
   *
   * Not under reduced motion: there the canvas renders the same resolved frame
   * the poster already shows, so there is nothing to spoil and dropping it
   * would only introduce a blink. */
  if (!reducedMotion) root.classList.add('will-render');

  try {
    const { createStage } = await import('./stage.js');
    const stage = await createStage({ root, canvas, hero, ticker, reducedMotion });

    // Only now is there something for the control to act on.
    const rerun = document.getElementById('rerun');
    if (rerun) {
      rerun.hidden = false;
      rerun.addEventListener('click', () => stage.replay());
    }
  } catch (err) {
    // The renderer never arrived, so the poster is the fallback after all.
    // Nothing else on the page depends on this.
    root.classList.remove('will-render');
    console.warn('[worldtick] 3D stage unavailable:', err);
  }
}

function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}
