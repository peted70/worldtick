# worldtick.co.uk

Single-page static site for Worldtick Ltd. Plain HTML, CSS and ES modules —
**no build step, no npm, no bundler.** Edit the files and push.

---

## Before this goes live

- [x] Footer now carries the real company number and registered office. UK
      companies must state these on their website, and commercial teams do check.
- [x] Point the DNS at GitHub Pages (below). Live, with HTTPS enforced.
- [ ] Test on a real phone. Canvas performance and iOS Safari's `100dvh`
      behaviour do not emulate reliably.

---

## Structure

```
index.html            Everything the visitor reads. Complete without JavaScript.
css/style.css         Tokens, layout, motion. Mobile-first, designed at 390px.
js/main.js            Boot: counter and reveals immediately, 3D lazily.
js/tick.js            Fixed-timestep loop. The counter and the cloud share it.
js/stage.js           Renderer, camera, pointer/touch/scroll input.
js/scene-cloud.js     Massing, streets, traffic and shading. The swappable part.
js/reveal.js          IntersectionObserver scroll reveals.
vendor/               three.js r185, committed. No CDN, no third-party requests.
brand/                Generated icons and social graphics. See brand/README.md.
tools/                Offline tooling. Never deployed, never linked.
```

### How it fits together

One fixed canvas sits behind the whole page. The light document sections are
opaque and scroll *over* it, so the scene shows through at the hero and again
behind contact and the footer. Content is always real DOM — the 3D never
renders text.

The page is readable before any of the 3D arrives:

| Rung | Condition | What the visitor gets |
|---|---|---|
| 1 | No JS, or no WebGL2/WebGPU | Poster image, full content, static counter |
| 2 | `prefers-reduced-motion: reduce` | One resolved static frame, frozen counter |
| 3 | WebGL2 only | Full scene — three.js falls back automatically |
| 4 | WebGPU | Full scene |

The poster is only ever the *fallback*, never the loading screen. It is a
render of the **resolved** city, so showing it while the renderer downloads
gives away the convergence and then makes that convergence start out of a still
of its own last frame.

The decision therefore happens in the inline probe in `<head>`, not in
`js/main.js`, and that placement is the whole trick. `main.js` is a module: it
has to be fetched and its imports resolved before a line of it runs, and the
poster has painted long before that — hiding it afterwards just produces a
flash, and fading it produces a longer one, since a transition cannot start
until the element has been painted at least once. Running in `<head>` the probe
sets `will-render` on `<html>` before `<body>` is parsed, so the rule applies at
the first style resolution and the poster is never paintable at all. It is
feature detection only — `navigator.gpu`, or `WebGL2RenderingContext` existing —
with no context creation, so it costs nothing worth measuring.

The probe answers **two** questions, and conflating them causes a bug.
`will-render` means a scene is coming at all; `still` is added on top when the
visitor prefers reduced motion. Only the poster cares about the second one —
reduced motion keeps it, since the canvas there renders that same resolved
frame and there is nothing to give away.

The first question is what reserves space for the `[ re-run ]` control. The
hero column is bottom-anchored, so letting a 44px control into the flow at the
moment the scene arrives shoves the wordmark and the readout upward. Under
`will-render` it holds its slot from the first paint and only its visibility
changes, while `[hidden]` keeps it unfocusable and out of the accessibility
tree until there is something for it to act on. Note that this has to key off
`will-render` alone: reduced motion gets the control too, so gating the
reservation on motion preference reintroduces the jump for exactly the people
least likely to want it.

That makes it a bet, so it has to be reversible. `js/main.js` does the real
check and calls `revertToPoster()` if a context cannot actually be created, or
if the renderer throws once loaded. That drops `will-render`, which brings the
poster back and releases the reserved space — correct on both counts, since
with no scene the control never appears.

The wait falls through to the holding screen underneath — the masked
graph-paper pool on `.stage::before`, under the wordmark and the already
running counter. Worth knowing: the poster is still fetched on the critical
path even when it is never shown.

Point count is chosen by **viewport width, not by backend**: under 500px it
drops to 34k structure points and 70 vehicles, above it 64k and 120. Both
backends render whichever they are given.

`js/tick.js` is the spine. It runs a fixed 60Hz accumulator decoupled from
`requestAnimationFrame`, so a 120Hz display and a struggling phone behave
identically. The visible counter and the particle simulation both read from
it — that identity *is* the brand idea (`world.tick()`), so don't give either
one its own timer.

### The scene

Four blocks on a street grid, resolving out of noise, with traffic running the
avenues between them. All of it animates in the vertex shader off two uniforms,
so the CPU uploads geometry once and then does nothing per frame.

There are **two clocks**, and the distinction matters:

- `uTick` is monotonic. Traffic runs off this and never resets, so it keeps
  flowing through a rebuild rather than teleporting.
- `uResolveTick` resets on re-run. Only the buildings replay.

**Re-run** rebuilds the massing with a fresh seed and replays the resolve —
the `[ re-run ]` button in the hero, or a tap anywhere on the hero background.
The street grid deliberately stays put: the city changes, the ground it sits
on doesn't. The first build is seeded (`0x5EED`) so the generated poster and
OG image match what a visitor sees on load.

**The resolve is anchored to the first rendered frame, not to tick 0.** This is
easy to get wrong and the failure is invisible in development. `js/stage.js`
sets `resolveEpoch = tick` on the first frame that reaches the canvas. Keyed to
tick 0 instead, the convergence ran on the shared clock while the renderer was
still downloading — so it played out behind the poster, and how much of it the
visitor saw depended entirely on their connection speed. On a warm cache it was
over before the canvas appeared: the first load cut straight from the poster to
the finished city, and the traffic arriving a beat later was the only motion
left. A local server hides this completely, because the import is instant.

Do not try to soften the handoff by starting the resolve part-way in. It was
tried, and it trades the whole animation away for a marginally smoother
cross-fade — first load has to show the same convergence that re-run does.

One visual rule holds the scene together: **brightness means motion.** Only
vehicles are near-white. Terrain is dimmed and gets no highlights, so the eye
finds the moving points immediately instead of hunting for them in a sparkly
ground plane. Breaking that rule is the fastest way to make the traffic
illegible.

### Vehicles

A vehicle is **four lamps, not one point** — two headlights forward, two tail
lights back, offset in the lane's own frame. Because the lanes are axis
aligned, those offsets are baked into world space on the CPU, so the shader
only adds a vector. All four lamps share a vehicle's speed and phase; give
them their own and the car pulls apart.

Heading is conveyed by **brightness alone** — bright pair leading, dim pair
trailing. An earlier version used red tail lights; that was more literal but
it put the only warm colour on the site and broke the single-accent rule for
no real gain. The scene does not need to look photographic.

Two constants govern legibility, and they trade against each other:
`HALF_LENGTH`/`HALF_TRACK` set how far apart the lamps sit, and the lamp
`sizeNode` factor sets how big each one is. Push the size up and the four
merge into one blob at mid distance; push it down and vehicles disappear.

### Why the traffic looks irregular

Getting this to stop looking mechanical took four separate sources of
randomness, and removing any one of them brings the regularity back:

1. **Per-lane load.** Each lane draws its own traffic level from a low-skewed
   distribution, so most streets run quiet and one or two run busy.
2. **Per-lane pace.** Every lane, including the two opposing lanes of the same
   avenue, gets an independent base speed. Tying opposing lanes together made
   both sides move as one block.
3. **Per-vehicle speed — the one that matters most.** Speeds are spread widely
   around the lane pace rather than sitting in a tight band. When every vehicle
   moves at nearly the same rate the whole formation is rigid and merely slides
   along; spread them and they drift relative to each other, so gaps open and
   close continuously and the pattern never repeats. Vehicles do pass through
   each other as a result, which is invisible at this scale.
4. **Mixed spacing.** About 62% of vehicles sit in platoons, each with its own
   spread; the rest run free at uniform random positions. Pure platoons read as
   one convoy per street, pure random reads as static noise.

Vehicle lengths vary too, so a long one reads as a van rather than a car.

### Capability figures

The four diagrams in the document section are **inline SVG**, not images and
not icons. Each one shows the actual mechanism rather than decorating the
heading: an asset beside its dotted twin with a sync line; a camera, a volume
and what that volume projects onto a plane; ragged multi-source input resolving
into one readable series; a programme as a stack of layers with ours picked
out.

They sit on graph paper that deliberately echoes the grid in the hero, which is
what stops the light half of the page feeling like a different site.

Three things worth knowing before editing them:

- Every animated path carries `pathLength="1"`, so a single
  `stroke-dasharray: 1` draws any path in regardless of its real geometry. No
  per-path length constants to keep in sync.
- The dash is only applied under `.js`. With JavaScript off the figures are
  simply already drawn, rather than invisible.
- The fills come from two shared `<pattern>` definitions near the top of
  `index.html`. That keeps the markup small enough to hand-edit — the dotted
  twin is two rectangles, not two hundred circles.

Motion is CSS, one moving element per figure, each on its own period so they
never fall into step. This is the one place that does not run off the tick
loop; nothing here displays time, so a second clock costs nothing.

### Camera cuts

Every 17–43 seconds the camera hard-cuts to another vantage — a switch of feed
on a bank of monitors, not a fly-through. A smooth traversal would pull focus
from the page for several seconds; a cut is over instantly.

Cuts are suppressed while the document has scrolled over the hero, and during
the resolve, since cutting mid-convergence throws away the one moment worth
watching. Each cut also moves the moon, because a cut that left the sky
identical would not read as a change of vantage.

### The sky

The moon and the meteors are parented to the **camera**, not the world. That
is deliberate. The camera looks *down* at the city, so the top edge of frame is
still below the horizontal and anything placed high in world space is off
screen entirely. Anchoring to the view also happens to be correct for a moon,
which is effectively at infinity and should not parallax.

The moon is a sprite with no texture — a disc and a faint halo computed from
the sprite's own UVs, so it stays crisp at any size and costs nothing to
download.

The one rule that keeps it looking like a moon: **the halo has to reach zero
before the edge of the sprite's quad.** In UV space the quad's inscribed circle
has radius 0.5, so `MOON_HALO_EDGE` must stay under that. It used to end at
0.60, which meant that along each edge of the quad the halo was still at about
3% alpha when the geometry simply stopped — and a faint hard boundary that is
present along the edges but absent at the corners reads as a rounded square
floating in the sky. The radii are kept in proportion to `MOON_SIZE`, so
changing one without the other reintroduces the tile.

Meteors are four streaks, each a 72-point trail on the same `fract()` cycle as
the traffic, visible for only 5% of a 25–70 second cycle. `METEOR_TRAIL_SPAN`
is the **total** lag of the tail behind the head as a fraction of travel, not a
per-point step — getting that wrong makes the streak a speck.

Note that the ground grid has **no alpha floor**. It used to, which kept
distant lines visible right up to the horizon, where they drew straight across
the moon.

Under `prefers-reduced-motion`, re-run still works — it generates a new block
and jumps straight to the resolved frame with no animation. There are no
camera cuts and no motion of any kind.

### Resizing

`resize()` ends by drawing a frame **synchronously**, and that is not
belt-and-braces — without it a drag flickers.

Setting a canvas's backing-store size clears its drawing buffer, and a
`ResizeObserver` callback is delivered *after* the same rendering update's
animation-frame callbacks. So the order per frame is: render at the old size,
resize and wipe the buffer, paint — and the paint lands on an empty buffer,
once per step of the drag. Waiting for the next `requestAnimationFrame` is
always one frame too late. Drawing inside the observer callback refills the
buffer before the paint that follows it.

Measured with `Page.startScreencast`, which reports frames as they are actually
painted rather than forcing one: dragging 1280px down to 860px produced ten
frames at roughly a fifth the byte size of their neighbours — a flat fill is
cheap to compress — and none at all once the redraw was added.

The redraw is skipped until the stage is live, because before that the canvas
is still at `opacity: 0` and drawing early would set the resolve epoch that the
first real frame owns.

---

## Working on it

```bash
python -m http.server 8765          # any static server; there is nothing to build
node tools/verify.mjs               # layout + fallback checks at every breakpoint
node tools/shoot.mjs                # regenerate the poster and OG image
node tools/brand/build.mjs --live=tick   # regenerate the icons and brand graphics
```

`tools/verify.mjs` drives headless Chrome over the DevTools Protocol and
checks horizontal overflow, wordmark fit, tap-target size, font loading and
the reduced-motion and no-JS paths at 360/390/430/768/1280. Screenshots land
in `tools/_shots/` (gitignored). Run it after any CSS or scene change.

`tools/cdp.mjs` exists because `chrome --headless --window-size` clamps to a
500px minimum on Windows, so it cannot screenshot a 390px phone viewport.

Regenerate the imagery with `tools/shoot.mjs` whenever the scene changes — the
poster and OG image are rendered from the real scene, not drawn separately, so
they stay in step automatically.

`tools/brand/build.mjs` is the other half: the flat assets, which are drawn
rather than rendered. It writes both mark sets into `brand/`, and `--live=<set>`
copies that set's icons to the site root. It serves the project over a throwaway
local HTTP server while it works, because Chrome refuses ES module imports over
`file://` and the render page imports the mark geometry. See
[`brand/README.md`](brand/README.md) for what each file is for.

---

## Deviations from the spec

`specs/worldtick-site-spec.md` (local only — not in this repo) is the brief.
Three things were overruled deliberately:

**three.js is used, despite the spec saying not to.** That rule was written for
a three-kilobyte hand-rolled hero. Once the hero became a real GPU particle
system, hand-rolling it stopped being quick and started capping how good it
could look. `WebGPURenderer` picks WebGPU or WebGL2 at runtime and TSL compiles
one shader source to both WGSL and GLSL, so the fallback path is the same code.

**The weight budget is met where it matters.** Over the wire: **~212KB on the
critical path** (HTML, CSS, JS, two preloaded fonts, poster) — inside the
spec's 500KB. The 3D adds ~293KB but loads lazily via dynamic `import()`, so
nothing the visitor reads waits on it.

**Two colours changed, both for contrast:**

| Token | Spec | Here | Why |
|---|---|---|---|
| `--slate` | `#697077` | `#5A6167` | 4.58:1 on `--paper` was a marginal AA pass; now 5.65:1 |

Three tokens were added, because the spec's palette assumes a light document
but the hero and contact sections put the same roles on `--viewport`:
`--paper-dim` (10.3:1), `--slate-dark` (5.19:1), `--signal-bright` (5.83:1).

The wordmark is real text rather than inline SVG. The spec asked for SVG so it
scales and inherits colour; real text in IBM Plex Mono does both, and is also
selectable, searchable and readable by a screen reader. The favicon is still
SVG, drawn as paths so it needs no font at 16×16.

The mark itself is drawn twice, and both sets ship: a tick, for the name, and
the wordmark's `()` glyph. The original `()` favicon had its two arcs crossing —
the `(` was drawn on the right of the box and the `)` on the left — so it closed
into an X at 16px. The rebuilt one holds the pair well apart, which is what the
counter between them needs at that size.

Per-capability imagery and the video loops were dropped. With a live scene
behind the whole page they were redundant, and the spec's own instruction was
to avoid shipping filler.

---

## Deployment

GitHub Pages serves `main` from the repository root. `CNAME` holds the custom
domain and `.nojekyll` stops Jekyll from touching anything.

### DNS at Namecheap — done, recorded for reference

These records are **already in place** and the domain resolves to GitHub. Kept
here so the setup is reproducible and so a future change can be checked against
what was intended.

Apex domain, so A records rather than a CNAME. **Verified against GitHub Docs,
"Managing a custom domain for your GitHub Pages site" — re-check before
re-entering these, as GitHub has changed them historically and a stale list
fails silently.**

| Type | Host | Value |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| AAAA | `@` | `2606:50c0:8000::153` |
| AAAA | `@` | `2606:50c0:8001::153` |
| AAAA | `@` | `2606:50c0:8002::153` |
| AAAA | `@` | `2606:50c0:8003::153` |
| CNAME | `www` | `peted70.github.io` |

Two things that mattered, and still would if this is ever redone:

- **No URL Redirect Record on `@`.** The domain used to park at
  `192.64.119.40` via one; it conflicts with the A records and fails quietly.
  It was removed.
- **Do not touch the MX or email-forwarding records.** They carry
  `worldtick.co.uk` mail, including `enquiries@`, and have nothing to do with
  Pages.

**HTTPS is enforced.** GitHub issued the certificate for both `worldtick.co.uk`
and `www.` (renews 18 Nov 2026) and `http://` now 301s to `https://`. Nothing
to do unless the domain changes, which revokes the certificate and starts the
wait again. Check with `curl -sI https://worldtick.co.uk | head -1`.

---

## Licences

IBM Plex is SIL OFL 1.1 (`fonts/OFL.txt`). three.js is MIT.
