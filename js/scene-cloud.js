/* The point cloud: several tens of thousands of points that resolve out of
 * noise into a building envelope over a ground plane.
 *
 * All of the animation happens in the vertex shader, driven by a single tick
 * uniform. The CPU uploads the geometry once and then does nothing per frame,
 * which is what lets this run at 60fps on a mid-range phone. Written in TSL so
 * one source compiles to both WGSL and GLSL — the WebGL2 fallback path is the
 * same code, just fewer points.
 *
 * Module contract (kept deliberately small so the scene can be swapped later):
 *   createCloudScene({ quality }) -> { object3D, resolveTicks, setTick, dispose }
 */

import * as THREE from 'three/webgpu';
import {
  attribute, uniform, float, vec3, vec4, mix, positionGeometry, positionView,
} from 'three/tsl';

const COLOR = {
  viewport: new THREE.Color('#0C1116'),
  grid:     new THREE.Color('#1A2129'),
  signal:   new THREE.Color('#0B5FFF'),
  dim:      new THREE.Color('#3D6E9E'),
  hot:      new THREE.Color('#DCE6F2'),
};

/* Ease over 90 ticks with up to 30 ticks of stagger — 120 ticks at 60Hz, so
 * the cloud is resolved in about two seconds. */
const EASE_TICKS = 90;
const STAGGER_TICKS = 30;
export const RESOLVE_TICKS = EASE_TICKS + STAGGER_TICKS;

/* Depth fade window, in world units from the camera. Set by the stage on
 * resize, because the camera distance changes with viewport aspect and a
 * fixed window would black the scene out on a phone. */
const FADE_NEAR = 18;
const FADE_FAR = 72;

/* Distant points sink toward the background but never all the way — losing
 * them entirely reads as a rendering fault rather than as depth. */
const FADE_FLOOR = 0.3;

/* Framing belongs to the scene, not the stage — the numbers describe how big
 * this particular composition is. Shared with tools/shoot.html so captured
 * stills frame identically to the live render. */
export const CAMERA = {
  fov: 50,
  lookAt: [0, 3.5, 0],
  theta: 0.62,
  phi: 1.16,

  /* Radius of the part of the scene that must stay in frame. Smaller than the
   * ground plane on purpose — the terrain may run off the edges, the building
   * cluster may not. */
  fitRadius: 10,
  minRadius: 26,
  maxRadius: 46,

  /* A tall phone viewport has a very narrow horizontal field of view, so the
   * distance that frames well on a desktop clips the towers. Solve for
   * whichever of the two fields of view is tighter. */
  radiusFor(aspect) {
    const vFov = (this.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const tight = Math.min(vFov, hFov);
    const r = this.fitRadius / Math.sin(tight / 2);
    return Math.min(Math.max(r, this.minRadius), this.maxRadius);
  },
};

export function createCloudScene({ quality = 'high' } = {}) {
  const count = quality === 'low' ? 22000 : 64000;

  const group = new THREE.Group();

  const target = new Float32Array(count * 3);
  const origin = new Float32Array(count * 3);
  const colour = new Float32Array(count * 3);
  const delay = new Float32Array(count);

  buildGeometry({ count, target, origin, colour, delay });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(target, 3));
  geometry.setAttribute('aOrigin', new THREE.BufferAttribute(origin, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colour, 3));
  geometry.setAttribute('aDelay', new THREE.BufferAttribute(delay, 1));
  geometry.computeBoundingSphere();

  const uTick = uniform(0);
  // (canvasHeight / 2) / tan(fov/2) — set by the stage on every resize, so
  // points keep a constant apparent size across viewports and pixel ratios.
  const uPixelScale = uniform(600);
  const uFadeNear = uniform(FADE_NEAR);
  const uFadeFar = uniform(FADE_FAR);

  const aOrigin = attribute('aOrigin', 'vec3');
  const aColor = attribute('aColor', 'vec3');
  const aDelay = attribute('aDelay', 'float');

  // Per-point progress, 0..1, offset by that point's stagger.
  const progress = uTick.sub(aDelay).div(EASE_TICKS).clamp(0, 1);
  // easeOutCubic — fast commit, long settle. Reads as converging rather than
  // arriving, which is the whole idea.
  const eased = float(1).sub(float(1).sub(progress).pow(3));

  const material = new THREE.PointsNodeMaterial();
  material.positionNode = mix(aOrigin, positionGeometry, eased);

  // Squares, not soft discs. This is how real point-cloud viewers draw data,
  // and it dodges the glowing-particle look the brief rules out.
  const depth = positionView.z.negate().max(float(0.001));
  material.sizeNode = uPixelScale.mul(0.045).div(depth).clamp(1.0, 5.0);

  // Distant points sink toward the background rather than fogging to grey.
  const fade = depth.smoothstep(uFadeFar, uFadeNear).mul(1 - FADE_FLOOR).add(FADE_FLOOR);
  material.colorNode = vec4(mix(vec3(...COLOR.viewport.toArray()), aColor, fade), 1);

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  group.add(points);

  const grid = buildGrid(uFadeNear, uFadeFar);
  group.add(grid);

  return {
    object3D: group,
    resolveTicks: RESOLVE_TICKS,
    setTick(tick) { uTick.value = tick; },
    setPixelScale(v) { uPixelScale.value = v; },
    setFade(near, far) { uFadeNear.value = near; uFadeFar.value = far; },
    dispose() {
      geometry.dispose();
      material.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
    },
  };
}

/* ---------- Geometry ---------- */

/* A small urban block: three masses of different heights on a ground plane.
 * Points sit on the surfaces only, like a scan would capture — a solid volume
 * of points reads as fog rather than as a building. */
const GROUND_RADIUS = 34;

/** Hermite step, matching the GPU smoothstep so CPU and shader agree. */
function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

const MASSES = [
  { x: -3.2, z: -1.4, w: 5.2, d: 5.0, h: 9.0, weight: 1.0 },
  { x:  3.4, z:  1.0, w: 4.2, d: 4.6, h: 5.4, weight: 0.7 },
  { x:  1.0, z: -5.2, w: 3.4, d: 3.2, h: 12.4, weight: 0.6 },
];

function buildGeometry({ count, target, origin, colour, delay }) {
  const totalWeight = MASSES.reduce((s, m) => s + m.weight, 0);
  const groundShare = 0.34;

  let maxH = 0;
  for (const m of MASSES) maxH = Math.max(maxH, m.h);

  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    let x, y, z;
    // Ground points dim toward the edge of the disc. Without this the sampled
    // circle has a visible rim, which immediately reads as a rendering
    // boundary rather than as terrain running out of capture range.
    let edge = 1;

    if (i < count * groundShare) {
      // Ground: radial scatter, denser toward the middle, with a slight
      // undulation so it reads as captured terrain rather than a flat plane.
      const rn = Math.sqrt(Math.random());
      const r = rn * GROUND_RADIUS;
      const a = Math.random() * Math.PI * 2;
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      y = Math.sin(x * 0.18) * Math.cos(z * 0.15) * 0.28;
      edge = 1 - smoothstep(0.45, 1.0, rn);
    } else {
      // Surfaces of one of the masses, chosen by weight.
      let pick = Math.random() * totalWeight;
      let m = MASSES[0];
      for (const cand of MASSES) {
        pick -= cand.weight;
        if (pick <= 0) { m = cand; break; }
      }
      const p = pointOnBoxShell(m);
      x = p[0]; y = p[1]; z = p[2];
    }

    const o = i * 3;
    target[o] = x; target[o + 1] = y; target[o + 2] = z;

    // Scattered start: a wide shell around the scene, so points sweep inward
    // from every direction rather than bubbling up from one place.
    const sa = Math.random() * Math.PI * 2;
    const sb = Math.acos(2 * Math.random() - 1);
    const sr = 26 + Math.random() * 26;
    origin[o]     = Math.sin(sb) * Math.cos(sa) * sr;
    origin[o + 1] = Math.abs(Math.cos(sb)) * sr * 0.5 + 2;
    origin[o + 2] = Math.sin(sb) * Math.sin(sa) * sr;

    // Resolve from the ground upward — the masses assemble after the terrain,
    // which reads as a survey being built up rather than everything landing
    // at once.
    const height01 = Math.min(y / maxH, 1);
    delay[i] = (Math.random() * 0.55 + height01 * 0.45) * STAGGER_TICKS;

    // Intensity ramp: mostly dim-to-signal, with a small near-white minority
    // to give the cloud sparkle without resorting to additive blending.
    const t = Math.random();
    if (t > 0.93) {
      c.copy(COLOR.hot);
    } else {
      c.copy(COLOR.dim).lerp(COLOR.signal, Math.random() ** 0.7);
    }
    if (edge < 1) c.lerp(COLOR.viewport, 1 - edge);
    colour[o] = c.r; colour[o + 1] = c.g; colour[o + 2] = c.b;
  }
}

/* Uniformly sample the four walls and the roof of a mass. The floor is never
 * visible and would waste points. */
function pointOnBoxShell(m) {
  const wallArea = 2 * (m.w + m.d) * m.h;
  const roofArea = m.w * m.d;
  const r = Math.random() * (wallArea + roofArea);

  if (r > wallArea) {
    return [
      m.x + (Math.random() - 0.5) * m.w,
      m.h,
      m.z + (Math.random() - 0.5) * m.d,
    ];
  }

  const perimeter = 2 * (m.w + m.d);
  let u = Math.random() * perimeter;
  const y = Math.random() * m.h;

  if (u < m.w) return [m.x - m.w / 2 + u, y, m.z - m.d / 2];
  u -= m.w;
  if (u < m.d) return [m.x + m.w / 2, y, m.z - m.d / 2 + u];
  u -= m.d;
  if (u < m.w) return [m.x + m.w / 2 - u, y, m.z + m.d / 2];
  u -= m.w;
  return [m.x - m.w / 2, y, m.z + m.d / 2 - u];
}

/* A faint ground grid, so the cloud sits in a space rather than floating. */
function buildGrid(uFadeNear, uFadeFar) {
  const half = 40;
  const step = 5;
  const verts = [];
  for (let v = -half; v <= half; v += step) {
    verts.push(-half, 0, v, half, 0, v);
    verts.push(v, 0, -half, v, 0, half);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));

  const m = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false });
  const d = positionView.z.negate().max(float(0.001));
  m.colorNode = vec4(vec3(...COLOR.grid.toArray()), d.smoothstep(uFadeFar, uFadeNear).mul(0.9).add(0.25));

  const lines = new THREE.LineSegments(g, m);
  lines.frustumCulled = false;
  return lines;
}
