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
js/scene-cloud.js     Point cloud geometry and shading. The swappable part.
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
| 3 | WebGL2 only | Full scene, 22k points, automatic three.js fallback |
| 4 | WebGPU | Full scene, 64k points |

`js/tick.js` is the spine. It runs a fixed 60Hz accumulator decoupled from
`requestAnimationFrame`, so a 120Hz display and a struggling phone behave
identically. The visible counter and the particle simulation both read from
it — that identity *is* the brand idea (`world.tick()`), so don't give either
one its own timer.

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

### DNS at Namecheap

Apex domain, so A records rather than a CNAME. **Verified against GitHub Docs,
"Managing a custom domain for your GitHub Pages site" — re-check before
entering these, as GitHub has changed them historically and a stale list fails
silently.**

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

Two things to get right:

- **Remove the existing URL Redirect Record on `@`.** The domain currently
  parks at `192.64.119.40`; the redirect record conflicts with the A records
  and fails quietly.
- **Do not touch the MX or email-forwarding records.** They carry
  `worldtick.co.uk` mail, including `enquiries@`, and have nothing to do with
  Pages. Adding the records above must leave them untouched.

Enable **Enforce HTTPS** in the repository's Pages settings once the
certificate provisions — up to 24 hours after DNS propagates.

---

## Licences

IBM Plex is SIL OFL 1.1 (`fonts/OFL.txt`). three.js is MIT.
