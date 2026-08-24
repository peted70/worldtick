/* The brand marks, as data. Imported by both Node (tools/brand/build.mjs, to
 * write the SVG files) and the browser (tools/brand/render.html, to compose the
 * raster assets), so the geometry has exactly one definition.
 *
 * Everything is drawn in a 32x32 box. That is the size the shapes were tuned
 * for — a favicon is the hardest case, and a mark that survives 16px survives
 * everything above it. Larger assets scale this box rather than redrawing.
 */

export const PALETTE = {
  ground: '#0C1116',  // --viewport
  grid:   '#1A2129',  // --viewport-grid
  accent: '#4D8BFF',  // --signal-bright, 5.83:1 on ground
  paper:  '#F2F4F3',  // --paper
  dim:    '#B8C0C6',  // --paper-dim, 10.3:1 on ground
  slate:  '#7E878E',  // --slate-dark, 5.19:1 on ground
};

export const FAMILIES = {
  /* The name, literally. The long arm runs almost to the corner: a shorter,
   * more upright tick loses its diagonal at 16px and reads as a smudge. */
  tick: {
    label: 'tick',
    strokeWidth: 3.6,
    paths: ['M6.8 16.2 L12.6 22 L25.4 7.2'],
  },

  /* The wordmark's () glyph. Bellies are cubic rather than quadratic so the
   * curve flattens through the middle the way it does in type, and the pair is
   * held 7.2 units apart — wide for a paren, but the counter has to stay open
   * at 16px, where anything tighter closes up into a single blob. */
  paren: {
    label: 'paren',
    strokeWidth: 3.4,
    paths: [
      'M12.4 7 C7.6 11.2 7.6 20.8 12.4 25',
      'M19.6 7 C24.4 11.2 24.4 20.8 19.6 25',
    ],
  },
};

export const FAMILY_NAMES = Object.keys(FAMILIES);

/** The glyph alone, as an SVG fragment in the 32x32 box.
 *  `scale` shrinks it about the centre; stroke weight scales with it. */
export function glyph(family, { color = PALETTE.accent, scale = 1 } = {}) {
  const f = FAMILIES[family];
  if (!f) throw new Error(`Unknown mark family: ${family}`);
  const o = 16 - 16 * scale;
  const t = scale === 1 ? '' : ` transform="translate(${r(o)} ${r(o)}) scale(${r(scale)})"`;
  return `<g${t} fill="none" stroke="${color}" stroke-width="${f.strokeWidth}" `
    + `stroke-linecap="round" stroke-linejoin="round">`
    + f.paths.map((d) => `<path d="${d}"/>`).join('')
    + `</g>`;
}

/** A square icon: glyph on a ground, optionally rounded. */
export function tile(family, {
  color = PALETTE.accent,
  ground = PALETTE.ground,
  radius = 7,        // in 32-box units; 0 for a hard square
  scale = 1,
  size = null,       // omit for a fluid SVG that fills its box
  title = null,
} = {}) {
  const dim = size ? ` width="${size}" height="${size}"` : '';
  const role = title ? ` role="img" aria-label="${title}"` : ' aria-hidden="true"';
  const bg = ground
    ? `<rect width="32" height="32"${radius ? ` rx="${radius}"` : ''} fill="${ground}"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"${dim}${role}>`
    + bg + glyph(family, { color, scale }) + `</svg>`;
}

/* Named treatments, so build.mjs and render.html cannot drift apart on the
 * numbers. Each is a scale (and ground shape) for one job:
 *
 *   favicon   rounded tile, glyph full size — it is only ever 16-48px
 *   touch     iOS applies its own mask and a large radius, so ship a hard
 *             square and keep the glyph clear of the corners
 *   pwa       Android/desktop install icon, purpose "any"
 *   maskable  purpose "maskable": everything outside the central 80% circle
 *             can be cropped, so the glyph sits inside ~58%
 *   avatar    social profile picture, cropped to a circle by every platform
 */
export const TREATMENTS = {
  favicon:  { radius: 7, scale: 1.00 },
  touch:    { radius: 0, scale: 0.78 },
  pwa:      { radius: 7, scale: 0.84 },
  maskable: { radius: 0, scale: 0.58 },
  avatar:   { radius: 0, scale: 0.60 },
};

const r = (n) => Number(n.toFixed(3));
