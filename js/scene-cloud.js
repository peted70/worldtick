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
  attribute, uniform, float, vec3, vec4, mix, positionGeometry, positionView, uv,
} from 'three/tsl';

const COLOR = {
  viewport: new THREE.Color('#0C1116'),
  grid:     new THREE.Color('#1A2129'),
  signal:   new THREE.Color('#0B5FFF'),
  dim:      new THREE.Color('#3D6E9E'),
  hot:      new THREE.Color('#DCE6F2'),
  head:     new THREE.Color('#F4F8FF'),
  moon:     new THREE.Color('#D7E1EE'),
  meteor:   new THREE.Color('#EAF1FF'),
  // Heading is conveyed by brightness alone — bright pair leading, dim pair
  // trailing. Keeps the page to one accent, which red tail lights broke.
  tail:     new THREE.Color('#7C93B5'),
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
const OUTER_AVENUE = 13.5;
const AVENUES = [0, -OUTER_AVENUE, OUTER_AVENUE];
const STREET_EXTENT = 20;
const ROAD_Y = 0.12;

/* Buildings live strictly between the central and outer avenues. Both bounds
 * matter: only constraining the inner edge let large masses run out over the
 * outer carriageway, which put buildings on the road. */
const PAVEMENT = 0.7;
const BLOCK_INNER = STREET_HALF + PAVEMENT;
const BLOCK_OUTER = OUTER_AVENUE - STREET_HALF - PAVEMENT;

/* A vehicle is four lamps, not one point: two headlights forward, two tail
 * lights back. At this scale that is what makes a moving dot read as a car
 * with a direction rather than as a drifting spark. */
const HALF_LENGTH = 0.30;   // front axle to rear, halved
const HALF_TRACK = 0.13;    // lamp separation across the body, halved
const LAMPS = [
  { long:  1, lat: -1, tail: false },
  { long:  1, lat:  1, tail: false },
  { long: -1, lat: -1, tail: true },
  { long: -1, lat:  1, tail: true },
];

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
  // Deliberately sparse, and four lamps each — so this is ~4x the point count
  // but a small fraction of the vehicles. Pack the lanes and it stops reading
  // as traffic and starts reading as a glowing line.
  const vehicleCount = low ? 70 : 120;

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
    vehicleCount, uTick, uResolveTick, uPixelScale, uFadeNear, uFadeFar, bgColor,
  });
  group.add(traffic.object);

  const grid = buildGrid(uFadeNear, uFadeFar);
  group.add(grid);

  // Not added to `group` — the stage parents this to the camera. See buildSky.
  const sky = buildSky({ uTick, uPixelScale });

  return {
    object3D: group,
    sky: sky.group,
    placeSky: sky.place,
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
      sky.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
    },
  };
}

/* ---------- Sky ----------
 *
 * The moon and the meteors live in a group parented to the camera, so their
 * coordinates are camera-relative and they always sit in the upper part of
 * frame. That is deliberate rather than lazy: the camera looks *down* at the
 * city, so the top edge of the frame is still below the horizontal, and
 * anything placed high in world space is off-screen entirely. Anchoring to
 * the view also happens to be right for a moon, which is effectively at
 * infinity and should not parallax.
 */

const SKY_Z = -170;          // distance in front of the camera
const METEOR_COUNT = 4;
const METEOR_TRAIL = 72;   // dense enough to read as a continuous streak
/* How far the tail lags the head, as a fraction of the streak's travel. The
 * trail attribute is normalised 0..1, so this is the total span — not a
 * per-point step. */
const METEOR_TRAIL_SPAN = 0.3;
/* Fraction of each meteor's cycle that it is actually visible for. Small, so
 * they stay an occasional event rather than a weather condition. */
const METEOR_ACTIVE = 0.05;

function buildSky({ uTick, uPixelScale }) {
  const group = new THREE.Group();

  // Half-extents of the visible sky plane at SKY_Z, in world units. Set from
  // the camera's aspect and field of view on every resize.
  const uSkyW = uniform(70);
  const uSkyH = uniform(70);

  const moon = buildMoon();
  group.add(moon);

  const meteors = buildMeteors({ uTick, uPixelScale, uSkyW, uSkyH });
  group.add(meteors.object);

  return {
    group,
    /* Called on resize, and again on each camera cut so the moon shifts
     * position — a cut that left the sky identical would not read as a
     * change of vantage. */
    place({ aspect, vFov, variant = 0.5 }) {
      const halfH = Math.abs(SKY_Z) * Math.tan(vFov / 2);
      uSkyH.value = halfH;
      uSkyW.value = halfH * aspect;

      // Upper third, and never centred — a moon dead ahead looks like a bug.
      const side = variant < 0.5 ? -1 : 1;
      const t = (variant * 2) % 1;
      moon.position.set(
        side * uSkyW.value * (0.34 + t * 0.42),
        halfH * (0.46 + t * 0.26),
        SKY_Z,
      );
      const size = halfH * 0.16;
      moon.scale.set(size, size, 1);
    },
    dispose() {
      moon.material.dispose();
      meteors.dispose();
    },
  };
}

function buildMoon() {
  const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });

  // A disc plus a faint halo, drawn from the sprite's own UVs — no texture,
  // so it stays crisp at any size and adds nothing to the download.
  const d = uv().sub(0.5).length();
  const disc = d.smoothstep(0.30, 0.275);
  const halo = d.smoothstep(0.60, 0.30).mul(0.13);

  material.colorNode = vec4(vec3(...COLOR.moon.toArray()), disc.add(halo).clamp(0, 1));

  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = -1;
  return sprite;
}

function buildMeteors({ uTick, uPixelScale, uSkyW, uSkyH }) {
  const count = METEOR_COUNT * METEOR_TRAIL;

  const a = new Float32Array(count * 3);
  const b = new Float32Array(count * 3);
  const trail = new Float32Array(count);
  const speed = new Float32Array(count);
  const phase = new Float32Array(count);

  let p = 0;
  for (let m = 0; m < METEOR_COUNT; m++) {
    // Normalised sky coordinates; scaled to world units in the shader so a
    // resize does not mean rebuilding the buffers.
    const x0 = -1.15 + Math.random() * 1.5;
    const y0 = 0.55 + Math.random() * 0.5;
    const dx = 0.55 + Math.random() * 0.95;
    const dy = -(0.22 + Math.random() * 0.34);

    // One cycle every 25–70 seconds, visible for 5% of it.
    const s = 1 / (1500 + Math.random() * 2700);
    const ph = Math.random();

    for (let i = 0; i < METEOR_TRAIL; i++) {
      const o = p * 3;
      a[o] = x0; a[o + 1] = y0; a[o + 2] = SKY_Z;
      b[o] = x0 + dx; b[o + 1] = y0 + dy; b[o + 2] = SKY_Z;
      trail[p] = i / (METEOR_TRAIL - 1);
      speed[p] = s;
      phase[p] = ph;
      p++;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(a, 3));
  geometry.setAttribute('mA', new THREE.BufferAttribute(a, 3));
  geometry.setAttribute('mB', new THREE.BufferAttribute(b, 3));
  geometry.setAttribute('mTrail', new THREE.BufferAttribute(trail, 1));
  geometry.setAttribute('mSpeed', new THREE.BufferAttribute(speed, 1));
  geometry.setAttribute('mPhase', new THREE.BufferAttribute(phase, 1));

  const mTrail = attribute('mTrail', 'float');

  const cycle = uTick.mul(attribute('mSpeed', 'float')).add(attribute('mPhase', 'float')).fract();
  // Progress through the streak. Each trail point lags the head, so the tail
  // is still entering as the head is leaving.
  const prog = cycle.div(METEOR_ACTIVE).sub(mTrail.mul(METEOR_TRAIL_SPAN));
  const clamped = prog.clamp(0, 1);

  const material = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false });
  material.positionNode = mix(attribute('mA', 'vec3'), attribute('mB', 'vec3'), clamped)
    .mul(vec3(uSkyW, uSkyH, float(1)));

  const depth = positionView.z.negate().max(float(0.001));
  // Head largest, tapering back — a uniform-width streak looks like a scratch.
  material.sizeNode = uPixelScale.mul(0.62).div(depth)
    .mul(float(1).sub(mTrail.mul(0.5))).clamp(0.8, 3.6);

  // Fade in at the head, out at the end, and taper along the trail.
  const enter = prog.smoothstep(-0.03, 0.04);
  const leave = float(1).sub(prog.smoothstep(0.72, 1.0));
  const taper = float(1).sub(mTrail).pow(1.6);

  material.colorNode = vec4(
    vec3(...COLOR.meteor.toArray()),
    enter.mul(leave).mul(taper),
  );

  const object = new THREE.Points(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = -1;

  return { object, dispose() { geometry.dispose(); material.dispose(); } };
}

/* ---------- Traffic ---------- */

function buildTraffic({
  vehicleCount, uTick, uResolveTick, uPixelScale, uFadeNear, uFadeFar, bgColor,
}) {
  const lanes = buildLanes();
  const vehicles = placeVehicles(lanes, vehicleCount);
  const pointCount = vehicles.length * LAMPS.length;

  const a = new Float32Array(pointCount * 3);
  const b = new Float32Array(pointCount * 3);
  const offset = new Float32Array(pointCount * 3);
  const speed = new Float32Array(pointCount);
  const phase = new Float32Array(pointCount);
  const colour = new Float32Array(pointCount * 3);

  const c = new THREE.Color();
  let p = 0;

  for (const v of vehicles) {
    const { lane } = v;
    // Lanes are axis-aligned, so the body frame is constant per vehicle and
    // the lamp offsets can be baked into world space here. The shader then
    // only has to add a vector.
    const dx = lane.b[0] - lane.a[0];
    const dz = lane.b[2] - lane.a[2];
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;        // forward
    const lx = -fz, lz = fx;                   // left

    for (const lamp of LAMPS) {
      const o = p * 3;
      a[o] = lane.a[0]; a[o + 1] = lane.a[1]; a[o + 2] = lane.a[2];
      b[o] = lane.b[0]; b[o + 1] = lane.b[1]; b[o + 2] = lane.b[2];

      const halfLen = HALF_LENGTH * v.length;
      offset[o]     = fx * lamp.long * halfLen + lx * lamp.lat * HALF_TRACK;
      offset[o + 1] = 0;
      offset[o + 2] = fz * lamp.long * halfLen + lz * lamp.lat * HALF_TRACK;

      // Every lamp on a vehicle shares its motion, or the car pulls apart.
      speed[p] = v.speed;
      phase[p] = v.phase;

      // Well below the headlights: the brightness gap is the only cue for
      // which way the vehicle is pointing, so it has to be unambiguous.
      if (lamp.tail) c.copy(COLOR.tail).lerp(COLOR.viewport, 0.42);
      else c.copy(COLOR.head);
      colour[o] = c.r; colour[o + 1] = c.g; colour[o + 2] = c.b;
      p++;
    }
  }

  const geometry = new THREE.BufferGeometry();
  // `position` is required by three even though the shader ignores it.
  geometry.setAttribute('position', new THREE.BufferAttribute(a, 3));
  geometry.setAttribute('aA', new THREE.BufferAttribute(a, 3));
  geometry.setAttribute('aB', new THREE.BufferAttribute(b, 3));
  geometry.setAttribute('aOffset', new THREE.BufferAttribute(offset, 3));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colour, 3));

  const aA = attribute('aA', 'vec3');
  const aB = attribute('aB', 'vec3');

  // fract() gives a free respawn at the start of the lane once a vehicle
  // reaches the end.
  const t = uTick.mul(attribute('aSpeed', 'float')).add(attribute('aPhase', 'float')).fract();

  const material = new THREE.PointsNodeMaterial();
  material.positionNode = mix(aA, aB, t).add(attribute('aOffset', 'vec3'));

  const depth = positionView.z.negate().max(float(0.001));
  // Smaller than when one point was a whole vehicle — these are individual
  // lamps, and they have to stay distinguishable as four rather than merging
  // into one blob at mid distance.
  material.sizeNode = uPixelScale.mul(0.105).div(depth).clamp(1.5, 6.0);

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

/* Two opposing lanes on every avenue, in both directions. Each lane carries
 * its own traffic level, so some run busy and some run nearly empty. */
function buildLanes() {
  const lanes = [];
  const E = STREET_EXTENT;

  // Skewed low: most streets should be quiet, a couple busy. A uniform draw
  // makes every lane look about the same, which is the thing to avoid.
  const density = () => 0.12 + Math.random() ** 2.1 * 1.5;

  const add = (a, b, speed) => {
    const load = density();
    lanes.push({
      a, b, load,
      // Busier lanes run slower. Cheap, and it sells the whole thing.
      speed: speed * (1.16 - load * 0.28),
    });
  };

  // Base pace per lane, widely spread so no two streets run at the same rate.
  const pace = () => 1 / (420 + Math.random() ** 1.3 * 700);

  for (const at of AVENUES) {
    // Opposing lanes on the same avenue get independent paces too — tying
    // them together made both sides move as one block.
    add([at + LANE_OFFSET, ROAD_Y, -E], [at + LANE_OFFSET, ROAD_Y, E], pace());
    add([at - LANE_OFFSET, ROAD_Y, E], [at - LANE_OFFSET, ROAD_Y, -E], pace());

    add([-E, ROAD_Y, at - LANE_OFFSET], [E, ROAD_Y, at - LANE_OFFSET], pace());
    add([E, ROAD_Y, at + LANE_OFFSET], [-E, ROAD_Y, at + LANE_OFFSET], pace());
  }
  return lanes;
}

/* Distribute vehicles across lanes by load, and clump them within a lane.
 * Evenly spaced traffic looks like a conveyor belt; real traffic arrives in
 * platoons with gaps between, which is also what makes a low vehicle count
 * still read as a working street. */
function placeVehicles(lanes, vehicleCount) {
  const totalLoad = lanes.reduce((s, l) => s + l.load, 0);
  const vehicles = [];

  for (const lane of lanes) {
    const n = Math.round((vehicleCount * lane.load) / totalLoad);
    if (n === 0) continue;

    const platoons = 1 + Math.floor(Math.random() * 3);
    const centres = Array.from({ length: platoons }, () => Math.random());

    for (let i = 0; i < n; i++) {
      let phase;
      if (Math.random() < 0.62) {
        // In a platoon. Each platoon gets its own spread, so clumps differ in
        // size instead of all looking like the same blob.
        const centre = centres[i % platoons];
        const spread = 0.02 + Math.random() ** 1.6 * 0.14;
        // Sum of two uniforms — triangular, so vehicles bunch toward the
        // centre of their platoon rather than spreading evenly across it.
        const jitter = (Math.random() + Math.random() - 1) * spread;
        phase = centre + jitter;
      } else {
        // Free-running singles between the platoons, which is what breaks up
        // the "one convoy per street" look.
        phase = Math.random();
      }

      vehicles.push({
        lane,
        phase: ((phase % 1) + 1) % 1,
        // Wide, skewed spread rather than a tight band around the lane speed.
        // This is the change that matters: when every vehicle moves at nearly
        // the same rate the whole formation is rigid and merely slides along.
        // Spread them and they drift relative to each other, so gaps open and
        // close continuously and the pattern never repeats.
        speed: lane.speed * (0.62 + Math.random() ** 1.4 * 1.05),
        // Vehicle lengths vary — a long one reads as a van or a bus.
        length: 0.78 + Math.random() ** 1.5 * 1.15,
      });
    }
  }
  return vehicles;
}

/* ---------- Massing ---------- */

const GROUND_RADIUS = 34;

/* One block per quadrant, inset far enough to keep the carriageways clear.
 * Heights are biased low so a single tower dominates, which frames better
 * than four similar slabs. */
function generateMasses(rand) {
  const quads = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  // Widest footprint that still leaves the block usable on both sides.
  const maxSpan = BLOCK_OUTER - BLOCK_INNER;

  /* Pick a footprint, then place it somewhere it definitely fits, rather than
   * placing it and hoping. This is what guarantees no building ever sits on a
   * carriageway. */
  const axis = (sign, size) => {
    const lo = BLOCK_INNER + size / 2;
    const hi = BLOCK_OUTER - size / 2;
    return sign * (lo + (hi - lo) * rand());
  };

  return quads.map(([sx, sz]) => {
    const w = 3.4 + rand() * Math.min(3.2, maxSpan - 3.4);
    const d = 3.4 + rand() * Math.min(3.2, maxSpan - 3.4);
    const h = 4.0 + rand() ** 1.8 * 8.6;
    // Points are allocated by surface area, so big towers don't come out sparse.
    return {
      x: axis(sx, w), z: axis(sz, d), w, d, h,
      weight: 2 * (w + d) * h + w * d,
    };
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
  // No alpha floor. A constant minimum kept distant lines visible all the way
  // to the horizon, where they drew straight across the moon.
  m.colorNode = vec4(
    vec3(...COLOR.grid.toArray()),
    d.smoothstep(uFadeFar.mul(1.15), uFadeNear.mul(0.5)).mul(0.95),
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
