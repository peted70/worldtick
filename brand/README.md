# Brand assets

Two complete sets, one per mark. Both are built from the same geometry and the
same compositions, so they are interchangeable — pick a set, use it everywhere.

| set      | mark | reads as |
| -------- | ---- | -------- |
| `tick/`  | a tick | the name, said plainly |
| `paren/` | the `()` from the wordmark | `world.tick()`, the brand idea |

Everything here is generated. Do not hand-edit it:

```
node tools/brand/build.mjs             # rebuild both sets
node tools/brand/build.mjs --live=tick # ...and install that set at the site root
```

The geometry lives in [`tools/brand/marks.mjs`](../tools/brand/marks.mjs) and the
composed graphics in [`tools/brand/render.html`](../tools/brand/render.html).

## What is in each set

**Icons** — the glyph alone. Nothing else fits at these sizes.

| file | size | use |
| ---- | ---- | --- |
| `favicon.svg` | vector | the modern favicon; every current browser prefers it |
| `favicon.ico` | 16/32/48 | packed fallback for browsers that ignore the SVG |
| `favicon-16/32/48.png` | as named | the individual frames, if something wants a PNG |
| `apple-touch-icon.png` | 180 | iOS home screen. Hard square — iOS applies its own mask |
| `icon-192.png`, `icon-512.png` | as named | PWA install icon, `purpose: any` |
| `maskable-192.png`, `maskable-512.png` | as named | `purpose: maskable`; glyph sits inside the 58% safe zone |
| `pinned-tab.svg` | vector | Safari pinned tab. One colour, no ground — Safari recolours it |
| `mark.svg` | vector | glyph on no ground, for placing on any surface |
| `mark-knockout.svg` | vector | reversed: solid accent tile, glyph knocked out. Best on a light page |

**Graphics** — big enough to carry the wordmark, so they carry it. Dark ground,
hairline grid and a single cool bloom, matching the live hero.

| file | size | use |
| ---- | ---- | --- |
| `og-1200x630.png` | 1200×630 | Open Graph / Twitter `summary_large_image` |
| `x-banner-1500x500.png` | 1500×500 | X header. Centred, clear of the avatar and the mobile crop |
| `linkedin-1128x191.png` | 1128×191 | LinkedIn page banner. Right-weighted, clear of the page logo |
| `lockup-1200x300.png` | 1200×300 | mark plus wordmark, for slides and documents |
| `lockup.svg` | vector | the same lockup. Text stays live, so it needs IBM Plex Mono to be exact — use the PNG where you cannot guarantee the font |
| `avatar-512.png` | 512 | social profile picture. Square file, safe under a circular crop |
| `sheet.png` | — | proof sheet of the whole set. For review, not for use |

## Where the mark appears on the site

Only twice, and deliberately so:

- **The footer**, as a sign-off above the legal text. Inline SVG rather than a
  file, because it is two dozen bytes of path and a request would cost more than
  the geometry. The path is copied from `tick/mark.svg` — if the mark changes,
  copy it across again.
- **`logo` in the JSON-LD**, pointing at `icon-512.png`. This is what search
  engines read for a knowledge panel, so it wants the PNG at a real URL.

It is deliberately **not** in the hero. The wordmark there is the logo, and a
mark above it says the name twice. The `()` set is not used on the page at all
for the same reason — the wordmark already ends in a live `()`.

## Colours

Straight from `css/style.css`, so the assets and the site cannot drift.

| token | hex | role |
| ----- | --- | ---- |
| `--viewport` | `#0C1116` | ground |
| `--viewport-grid` | `#1A2129` | hairline grid |
| `--signal-bright` | `#4D8BFF` | the mark. 5.83:1 on the ground |
| `--paper` | `#F2F4F3` | `world` in the wordmark |
| `--slate-dark` | `#7E878E` | `()` in the wordmark |
| `--paper-dim` | `#B8C0C6` | strapline |

## Why the marks are shaped the way they are

Both were tuned at 16px first, because a favicon is the hardest case and
anything that survives it survives every size above.

The tick's long arm runs almost into the corner. A shorter, more upright tick
loses its diagonal at 16px and reads as a smudge.

The `()` is held 7.2 units apart in a 32 box — wide for a paren. The counter
between them is the whole mark, and anything tighter closes up into a single
blob at small sizes. The bellies are cubic rather than quadratic so the curve
flattens through the middle, the way it does in type.
