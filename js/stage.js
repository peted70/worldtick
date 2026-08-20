/* The persistent 3D stage.
 *
 * One fixed canvas behind the whole page. Owns the renderer, the camera and
 * all input state; the scene module owns geometry and shading. Renders off
 * the shared ticker so it stays locked to the same clock as the counter.
 */

import * as THREE from 'three/webgpu';
import { createCloudScene, RESOLVE_TICKS, CAMERA } from './scene-cloud.js';

const FOV = CAMERA.fov;
const LOOK_AT = new THREE.Vector3(...CAMERA.lookAt);

const SCROLL_PULLBACK = 20;   // world units the camera retreats over the page
const MAX_SCRIM = 0.65;       // how far the stage dims behind the document

const DRIFT_PER_TICK = 0.00035;  // ~1.2 degrees per second. Drift, not spin.
const POINTER_THETA = 0.10;      // radians of parallax at full deflection
const POINTER_PHI = 0.05;

export async function createStage({ root, canvas, hero, ticker, reducedMotion }) {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0c1116, 1);

  // Throws if neither WebGPU nor WebGL2 is usable. main.js keeps the poster.
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 200);

  const narrow = window.matchMedia('(max-width: 500px)').matches;
  const cloud = createCloudScene({ quality: narrow ? 'low' : 'high' });
  scene.add(cloud.object3D);

  /* ---- input state ---- */

  let pointerX = 0, pointerY = 0;      // target, -1..1
  let smoothX = 0, smoothY = 0;        // eased toward target
  let dragTheta = 0, dragVel = 0;      // touch nudge with inertia
  let scroll01 = 0, smoothScroll = 0;
  let baseRadius = CAMERA.minRadius;
  let resolveEpoch = 0;         // tick at which the current resolve started

  const scrim = root.querySelector('.stage__scrim');

  function resize() {
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (!w || !h) return;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    baseRadius = CAMERA.radiusFor(camera.aspect);

    // Fade window follows the camera, so the scene reads the same at every
    // aspect instead of going black on a phone.
    cloud.setFade(baseRadius * 0.5, baseRadius * 2.2);

    // Perspective scale in framebuffer pixels, so points hold a constant
    // apparent size across viewport sizes and pixel ratios.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cloud.setPixelScale((h * dpr * 0.5) / Math.tan((FOV * Math.PI) / 360));

    if (reducedMotion) renderStatic();
  }

  function readScroll() {
    // Progress across the first two viewport heights: by then the document
    // has fully covered the stage and further scrolling changes nothing.
    const span = window.innerHeight * 2;
    scroll01 = Math.min(window.scrollY / span, 1);
  }

  function placeCamera(tick) {
    const theta = CAMERA.theta + tick * DRIFT_PER_TICK + smoothX * POINTER_THETA + dragTheta;
    const phi = CAMERA.phi - smoothY * POINTER_PHI - smoothScroll * 0.10;
    const radius = baseRadius + smoothScroll * SCROLL_PULLBACK;

    camera.position.set(
      LOOK_AT.x + radius * Math.sin(phi) * Math.sin(theta),
      LOOK_AT.y + radius * Math.cos(phi),
      LOOK_AT.z + radius * Math.sin(phi) * Math.cos(theta),
    );
    camera.lookAt(LOOK_AT);
  }

  function renderStatic() {
    // One resolved frame, a little past full resolution so nothing is mid-ease
    // and the traffic has fully arrived.
    cloud.setTick(RESOLVE_TICKS + 200);
    cloud.setResolveTick(RESOLVE_TICKS + 200);
    placeCamera(0);
    renderer.render(scene, camera);
  }

  /* New massing, replayed from scattered. Traffic is on the monotonic clock,
   * so it keeps flowing through the rebuild rather than teleporting. */
  function replay() {
    cloud.regenerate();
    if (reducedMotion) {
      // Honour the preference: a new block, but no animation to get there.
      renderStatic();
    } else {
      resolveEpoch = ticker.tick;
    }
  }

  /* ---- listeners ---- */

  const ro = new ResizeObserver(resize);
  ro.observe(root);
  window.addEventListener('resize', resize, { passive: true });

  if (!reducedMotion) {
    window.addEventListener('scroll', readScroll, { passive: true });

    // Desktop parallax only — a coarse pointer means a finger, and the drag
    // handler below covers that case.
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      window.addEventListener('pointermove', (e) => {
        pointerX = (e.clientX / window.innerWidth) * 2 - 1;
        pointerY = (e.clientY / window.innerHeight) * 2 - 1;
      }, { passive: true });
    }

    var drag = attachDrag(hero, {
      onDrag: (dx) => { dragVel += dx * 0.00045; },
    });
  }

  /* Tap or click the hero background to re-run the simulation. Purely an
   * enhancement — the visible button in the hero is the discoverable route,
   * and this is the shortcut for people who try poking the scene. */
  if (hero) {
    hero.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;   // never steal a real control
      if (drag && drag.wasDragging()) return;      // that was an orbit gesture
      replay();
    });
  }

  /* ---- loop ---- */

  let live = false;

  function markLive() {
    if (live) return;
    live = true;
    root.classList.add('is-live');
  }

  if (reducedMotion) {
    resize();
    renderStatic();
    markLive();
  } else {
    resize();
    readScroll();

    ticker.onStep((tick) => {
      // Fixed-step, so these easing constants behave identically everywhere.
      smoothX += (pointerX - smoothX) * 0.035;
      smoothY += (pointerY - smoothY) * 0.035;
      smoothScroll += (scroll01 - smoothScroll) * 0.08;

      dragTheta += dragVel;
      dragVel *= 0.94;          // inertia
      dragTheta *= 0.97;        // ease back to rest
    });

    ticker.onFrame((tick) => {
      cloud.setTick(tick);
      cloud.setResolveTick(tick - resolveEpoch);
      placeCamera(tick);
      if (scrim) scrim.style.opacity = String(smoothScroll * MAX_SCRIM);
      renderer.render(scene, camera);
      markLive();
    });
  }

  return {
    renderer,
    replay,
    dispose() {
      ro.disconnect();
      cloud.dispose();
      renderer.dispose();
    },
  };
}

/* Horizontal-dominant drag only. A vertical gesture has to keep scrolling the
 * page, so we only claim the touch once it is clearly sideways. */
function attachDrag(el, { onDrag }) {
  if (!el) return null;
  let active = false, claimed = false, lastX = 0, startX = 0, startY = 0;
  let draggedAt = 0;

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    active = true; claimed = false;
    startX = lastX = e.clientX;
    startY = e.clientY;
  }, { passive: true });

  el.addEventListener('pointermove', (e) => {
    if (!active) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!claimed) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) >= Math.abs(dx)) { active = false; return; }  // it's a scroll
      claimed = true;
    }

    if (e.cancelable) e.preventDefault();
    onDrag(e.clientX - lastX);
    lastX = e.clientX;
    draggedAt = performance.now();
  }, { passive: false });

  const end = () => { active = false; claimed = false; };
  el.addEventListener('pointerup', end, { passive: true });
  el.addEventListener('pointercancel', end, { passive: true });

  return {
    // The click event fires right after pointerup, so a short window is enough
    // to tell "finished dragging" from "tapped".
    wasDragging: () => performance.now() - draggedAt < 250,
  };
}
