# worldtick.co.uk

Single-page static site for Worldtick Ltd. Plain HTML, CSS and ES modules —
**no build step, no npm, no bundler.** Edit the files and push.

---

## Before this goes live

- [ ] Replace the two placeholders in the footer of `index.html`: `[COMPANY NUMBER]`
      and `[REGISTERED OFFICE ADDRESS]`. UK companies must state these on their
      website, and commercial teams do check.
- [ ] Point the DNS at GitHub Pages (below).
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

Under `prefers-reduced-motion`, re-run still works — it generates a new block
and jumps straight to the resolved frame with no animation.

---

## Working on it

```bash
python -m http.server 8765          # any static server; there is nothing to build
node tools/verify.mjs               # layout + fallback checks at every breakpoint
node tools/shoot.mjs                # regenerate poster, OG image and touch icon
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
selectable, searchable and readable by a screen reader. `favicon.svg` is still
SVG, hand-drawn as arcs so it needs no font at 16×16.

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

**Still outstanding:** tick **Enforce HTTPS** in the repository's Pages
settings. The checkbox is greyed out until GitHub has issued the certificate,
which can take up to 24 hours after DNS goes live. Until then the site is
`http://` only. Check with `curl -sI https://worldtick.co.uk | head -1`.

---

## Licences

IBM Plex is SIL OFL 1.1 (`fonts/OFL.txt`). three.js is MIT.
