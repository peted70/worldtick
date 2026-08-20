/* The point cloud: tens of thousands of points that resolve out of noise into
 * a city block, with traffic running the streets between the towers.
 *
 * All animation happens in the vertex shader, driven by two tick uniforms.
 * The CPU uploads geometry once and then does nothing per frame, which is what
 * lets this hold 60fps on a mid-range phone. Written in TSL so one source
 * compiles to both WGSL and GLSL — the WebGL2 fallback runs the same code with
 * fewer points.
 *
 * Two clocks, deliberately:
 *   uTick        monotonic — traffic keeps flowing, never resets
 *   uResolveTick resets on re-run — only the buildings rebuild
 *
 * Module contract (small on purpose, so the scene can be swapped later):
 *   createCloudScene({ quality })
 *     -> { object3D, setTick, setResolveTick, setPixelScale, setFade,
 *          regenerate, dispose }
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
  traffic:  new THREE.Color('#EAF1FA'),
};

/* Ease over 90 ticks with up to 30 ticks of stagger — 120 ticks at 60Hz, so
 * the block resolves in about two seconds. */
const EASE_TICKS = 90;
const STAGGER_TICKS = 30;
export const RESOLVE_TICKS = EASE_TICKS + STAGGER_TICKS;

/* Traffic fades up once the buildings have settled, so the resolve reads as
 * one event rather than two competing ones. */
const TRAFFIC_IN = 70;

const FADE_NEAR = 18;
const FADE_FAR = 72;
const FADE_FLOOR = 0.3;

/* Street layout. Buildings are kept out of the carriageways, which is what
 * makes the traffic legible as traffic rather than as drifting sparks. */
const STREET_HALF = 2.6;   // half-width of the clear corridor
const LANE_OFFSET = 0.95;  // lanes either side of the centreline
const AVENUES = [0, -10.5, 10.5];
const STREET_EXTENT = 17;
const ROAD_Y = 0.12;

export const CAMERA = {
  fov: 50,
  lookAt: [0, 3.5, 0],
  theta: 0.62,
  // Higher vantage than a street-level view: the streets have to be
  // visible from above or the traffic is hidden in canyons.
  phi: 0.95,
  fitRadius: 15,
  minRadius: 30,
  maxRadius: 62,

  radiusFor(aspect) {
    const vFov = (this.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const tight = Math.min(vFov, hFov);
    const r = this.fitRadius / Math.sin(tight / 2);
    return Math.min(Math.max(r, this.minRadius), this.maxRadius);
  },
};

export function createCloudScene({ quality = 'high' } = {}) {
  const low = quality === 'low';
  const count = low ? 34000 : 64000;
  // Deliberately sparse. Traffic has to read as discrete vehicles; pack the
  // lanes and it turns into a solid glowing line.
  const trafficCount = low ? 460 : 950;

  const group = new THREE.Group();

  const target = new Float32Array(count * 3);
  const origin = new Float32Array(count * 3);
  const colour = new Float32Array(count * 3);
  const delay = new Float32Array(count);

  // Seeded for the first build, so the generated poster and OG image match
  // what a visitor actually sees on load. Re-runs use a fresh random seed.
  let masses = generateMasses(mulberry32(0x5EED));
  buildCloud({ count, masses, target, origin, colour, delay });

  const geometry = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(target, 3);
  const aOrg = new THREE.BufferAttribute(origin, 3);
  const aCol = new THREE.BufferAttribute(colour, 3);
  const aDly = new THREE.BufferAttribute(delay, 1);
  geometry.setAttribute('position', aPos);
  geometry.setAttribute('aOrigin', aOrg);
  geometry.setAttribute('aColor', aCol);
  geometry.setAttribute('aDelay', aDly);

  const uTick = uniform(0);
  const uResolveTick = uniform(0);
  const uPixelScale = uniform(600);
  const uFadeNear = uniform(FADE_NEAR);
  const uFadeFar = uniform(FADE_FAR);

  const bgColor = vec3(...COLOR.viewport.toArray());

  /* ---- buildings ---- */

  const progress = uResolveTick.sub(attribute('aDelay', 'float')).div(EASE_TICKS).clamp(0, 1);
  // easeOutCubic — fast commit, long settle. Reads as converging rather than
  // arriving, which is the whole idea.
  const eased = float(1).sub(float(1).sub(progress).pow(3));

  const material = new THREE.PointsNodeMaterial();
  material.positionNode = mix(attribute('aOrigin', 'vec3'), positionGeometry, eased);

  // Squares, not soft discs. This is how real point-cloud viewers draw data,
  // and it dodges the glowing-particle look the brief rules out.
  const depth = positionView.z.negate().max(float(0.001));
  material.sizeNode = uPixelScale.mul(0.045).div(depth).clamp(1.0, 5.0);

  const fade = depth.smoothstep(uFadeFar, uFadeNear).mul(1 - FADE_FLOOR).add(FADE_FLOOR);
  material.colorNode = vec4(mix(bgColor, attribute('aColor', 'vec3'), fade), 1);

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  group.add(points);

  /* ---- traffic ---- */

  const traffic = buildTraffic({
    trafficCount, uTick, uResolveTick, uPixelScale, uFadeNear, uFadeFar, bgColor,
  });
  group.add(traffic.object);

  const grid = buildGrid(uFadeNear, uFadeFar);
  group.add(grid);

  return {
    object3D: group,
    resolveTicks: RESOLVE_TICKS,

    setTick(t) { uTick.value = t; },
    setResolveTick(t) { uResolveTick.value = t; },
    setPixelScale(v) { uPixelScale.value = v; },
    setFade(near, far) { uFadeNear.value = near; uFadeFar.value = far; },

    /** New massing, same streets. The city changes; the grid it sits on doesn't. */
    regenerate(seed = (Math.random() * 0xffffffff) >>> 0) {
      masses = generateMasses(mulberry32(seed));
      buildCloud({ count, masses, target, origin, colour, delay });
      aPos.needsUpdate = true;
      aOrg.needsUpdate = true;
      aCol.needsUpdate = true;
      aDly.needsUpdate = true;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
      traffic.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
    },
  };
}

/* ---------- Traffic ---------- */

function buildTraffic({
  trafficCount, uTick, uResolveTick, uPixelScale, uFadeNear, uFadeFar, bgColor,
}) {
  const lanes = buildLanes();

  const a = new Float32Array(trafficCount * 3);
  const b = new Float32Array(trafficCount * 3);
  const speed = new Float32Array(trafficCount);
  const phase = new Float32Array(trafficCount);
  const colour = new Float32Array(trafficCount * 3);

  const c = new THREE.Color();

  for (let i = 0; i < trafficCount; i++) {
    const lane = lanes[i % lanes.length];
    const o = i * 3;
    a[o] = lane.a[0]; a[o + 1] = lane.a[1]; a[o + 2] = lane.a[2];
    b[o] = lane.b[0]; b[o + 1] = lane.b[1]; b[o + 2] = lane.b[2];

    // Coherent speed per lane with a little jitter. Fully random speeds read
    // as noise; a shared lane speed reads as flow.
    speed[i] = lane.speed * (0.88 + Math.random() * 0.24);
    phase[i] = Math.random();

    c.copy(COLOR.traffic).lerp(COLOR.signal, Math.random() * 0.45);
    colour[o] = c.r; colour[o + 1] = c.g; colour[o + 2] = c.b;
  }

  const geometry = new THREE.BufferGeometry();
  // `position` is required by three even though the shader ignores it.
  geometry.setAttribute('position', new THREE.BufferAttribute(a, 3));
  geometry.setAttribute('aA', new THREE.BufferAttribute(a, 3));
  geometry.setAttribute('aB', new THREE.BufferAttribute(b, 3));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colour, 3));

  const aA = attribute('aA', 'vec3');
  const aB = attribute('aB', 'vec3');

  // fract() gives a free respawn at the start of the lane once a vehicle
  // reaches the end.
  const t = uTick.mul(attribute('aSpeed', 'float')).add(attribute('aPhase', 'float')).fract();

  const material = new THREE.PointsNodeMaterial();
  material.positionNode = mix(aA, aB, t);

  const depth = positionView.z.negate().max(float(0.001));
  // Larger than the structure points: these are the only things moving, and
  // at 1px a moving point just reads as noise.
  material.sizeNode = uPixelScale.mul(0.16).div(depth).clamp(2.0, 9.0);

  // Much gentler than the structure fade: these are lights, and they should
  // stay legible into the distance rather than sinking into the background.
  const distanceFade = depth.smoothstep(uFadeFar, uFadeNear).mul(0.35).add(0.65);
  // Hide the wrap: fade each vehicle in and out at the ends of its lane.
  const endFade = t.smoothstep(0, 0.05).mul(float(1).sub(t.smoothstep(0.95, 1)));
  // Hold traffic back until the buildings have settled.
  const arrival = uResolveTick.smoothstep(RESOLVE_TICKS, RESOLVE_TICKS + TRAFFIC_IN);

  material.colorNode = vec4(
    mix(bgColor, attribute('aColor', 'vec3'), distanceFade.mul(endFade).mul(arrival)),
    1,
  );

  const object = new THREE.Points(geometry, material);
  object.frustumCulled = false;

  return {
    object,
    dispose() { geometry.dispose(); material.dispose(); },
  };
}

/* Two opposing lanes on every avenue, in both directions. */
function buildLanes() {
  const lanes = [];
  const E = STREET_EXTENT;

  for (const at of AVENUES) {
    // Ticks to traverse the full lane — roughly 9 to 14 seconds.
    const zSpeed = 1 / (520 + Math.random() * 300);
    // Running along Z, at fixed X.
    lanes.push({ a: [at + LANE_OFFSET, ROAD_Y, -E], b: [at + LANE_OFFSET, ROAD_Y, E], speed: zSpeed });
    lanes.push({ a: [at - LANE_OFFSET, ROAD_Y, E], b: [at - LANE_OFFSET, ROAD_Y, -E], speed: zSpeed * 1.08 });

    const xSpeed = 1 / (520 + Math.random() * 300);
    // Running along X, at fixed Z.
    lanes.push({ a: [-E, ROAD_Y, at - LANE_OFFSET], b: [E, ROAD_Y, at - LANE_OFFSET], speed: xSpeed });
    lanes.push({ a: [E, ROAD_Y, at + LANE_OFFSET], b: [-E, ROAD_Y, at + LANE_OFFSET], speed: xSpeed * 1.08 });
  }
  return lanes;
}

/* ---------- Massing ---------- */

const GROUND_RADIUS = 34;

/* One block per quadrant, inset far enough to keep the carriageways clear.
 * Heights are biased low so a single tower dominates, which frames better
 * than four similar slabs. */
function generateMasses(rand) {
  const quads = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const inset = STREET_HALF + 0.7;

  return quads.map(([sx, sz]) => {
    const w = 3.6 + rand() * 3.4;
    const d = 3.6 + rand() * 3.4;
    const h = 4.0 + rand() ** 1.8 * 8.6;
    const x = sx * (inset + w / 2 + rand() * 1.6);
    const z = sz * (inset + d / 2 + rand() * 1.6);
    // Points are allocated by surface area, so big towers don't come out sparse.
    return { x, z, w, d, h, weight: 2 * (w + d) * h + w * d };
  });
}

function buildCloud({ count, masses, target, origin, colour, delay }) {
  const totalWeight = masses.reduce((s, m) => s + m.weight, 0);
  const groundShare = 0.34;

  let maxH = 0;
  for (const m of masses) maxH = Math.max(maxH, m.h);

  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    let x, y, z;
    const isGround = i < count * groundShare;
    // Ground points dim toward the edge of the disc. Without this the sampled
    // circle has a visible rim, which reads as a rendering boundary rather
    // than as terrain running out of capture range.
    let edge = 1;

    if (isGround) {
      const rn = Math.sqrt(Math.random());
      const r = rn * GROUND_RADIUS;
      const ang = Math.random() * Math.PI * 2;
      x = Math.cos(ang) * r;
      z = Math.sin(ang) * r;
      y = Math.sin(x * 0.18) * Math.cos(z * 0.15) * 0.28;
      edge = 1 - smoothstep(0.45, 1.0, rn);
    } else {
      let pick = Math.random() * totalWeight;
      let m = masses[0];
      for (const cand of masses) {
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

    // Resolve from the ground upward, so it reads as a survey being built up
    // rather than everything landing at once.
    const height01 = Math.min(y / maxH, 1);
    delay[i] = (Math.random() * 0.55 + height01 * 0.45) * STAGGER_TICKS;

    // Brightness means motion. Only vehicles are near-white, so the eye reads
    // the moving points immediately instead of hunting for them among a
    // sparkly ground plane. Terrain gets no highlights at all and sits back.
    c.copy(COLOR.dim).lerp(COLOR.signal, Math.random() ** 0.7);
    if (isGround) c.lerp(COLOR.viewport, 0.32);
    else if (Math.random() > 0.95) c.copy(COLOR.hot);
    if (edge < 1) c.lerp(COLOR.viewport, 1 - edge);

    colour[o] = c.r; colour[o + 1] = c.g; colour[o + 2] = c.b;
  }
}

/* Uniformly sample the four walls and the roof. The floor is never visible
 * and would waste points. */
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
  m.colorNode = vec4(
    vec3(...COLOR.grid.toArray()),
    d.smoothstep(uFadeFar, uFadeNear).mul(0.9).add(0.25),
  );

  const lines = new THREE.LineSegments(g, m);
  lines.frustumCulled = false;
  return lines;
}

/* ---------- Utilities ---------- */

/** Hermite step, matching the GPU smoothstep so CPU and shader agree. */
function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** mulberry32 — small seeded PRNG, so the first build is reproducible. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
