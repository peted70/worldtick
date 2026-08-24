/* Build the full brand asset set, for both mark families.
 *
 *   node tools/brand/build.mjs            # build brand/tick/ and brand/paren/
 *   node tools/brand/build.mjs --live=tick   # ...and install that family at
 *                                            # the site root as the live icons
 *
 * Vectors are written straight from tools/brand/marks.mjs. Rasters are shot
 * from tools/brand/render.html at an exact viewport, so what ships is what the
 * browser actually draws rather than a separate approximation of it.
 *
 * The output is committed; rerun whenever a mark or a composition changes.
 */

import { launch } from '../cdp.mjs';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY_NAMES, PALETTE, glyph } from './marks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/* Chrome refuses ES module imports over file://, and render.html imports
 * marks.mjs, so the page has to come from an origin. Serving it here keeps the
 * build a single command rather than "start a server first". */
const TYPES = {
  '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
};

function serve() {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // normalize() collapses any ../ before it can escape the project.
    const file = join(ROOT, normalize(path).replace(/^([/\\.]+)/, ''));
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

/* ---------- vectors ---------- */

/** One SVG file: an optional ground rect plus the glyph, on its own lines. */
function svgDoc(rows) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" `
    + `aria-label="Worldtick">\n  ${rows.filter(Boolean).join('\n  ')}\n</svg>\n`;
}

const groundRect = (fill, radius = 7) =>
  `<rect width="32" height="32"${radius ? ` rx="${radius}"` : ''} fill="${fill}"/>`;

/** Mark plus wordmark, side by side. Text stays as text so it inherits colour
 *  and stays selectable; IBM Plex Mono is named with a monospace fallback, so a
 *  machine without the font gets the right rhythm at slightly the wrong width.
 *  Use the PNG lockup where the exact metrics matter. */
function lockupSVG(family) {
  const S = 21;                 // wordmark size in the 32-tall box
  const TRACK = -0.03 * S;      // matches the site's -0.03em
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 32" width="400" height="64"
     role="img" aria-label="Worldtick">
  ${groundRect(PALETTE.ground)}
  ${glyph(family)}
  <text x="42" y="23.3" font-family="'IBM Plex Mono', ui-monospace, monospace"
        font-size="${S}" font-weight="500" letter-spacing="${TRACK.toFixed(2)}">
    <tspan fill="${PALETTE.paper}">world</tspan><tspan fill="${PALETTE.accent}">.tick</tspan><tspan fill="${PALETTE.slate}">()</tspan>
  </text>
</svg>
`;
}

const VECTORS = (family) => ({
  // The live favicon. Rounded tile, glyph at full size.
  'favicon.svg': svgDoc([groundRect(PALETTE.ground), glyph(family)]),

  // The glyph with no ground, for placing on any surface.
  'mark.svg': svgDoc([glyph(family)]),

  // Reversed: solid accent tile, glyph knocked out. Reads strongest at small
  // sizes on a light page, where the dark tile can look like a hole.
  'mark-knockout.svg': svgDoc([
    groundRect(PALETTE.accent),
    glyph(family, { color: PALETTE.ground }),
  ]),

  // Safari pinned tab / macOS touch bar: one colour, no ground. Safari
  // recolours it itself, so the black here is a placeholder, not a choice.
  'pinned-tab.svg': svgDoc([glyph(family, { color: '#000000' })]),

  'lockup.svg': lockupSVG(family),
});

/* ---------- rasters ---------- */

const RASTERS = [
  // Icons. `asset` names a composition in render.html.
  { file: 'favicon-16.png',           asset: 'favicon',  w: 16,   h: 16 },
  { file: 'favicon-32.png',           asset: 'favicon',  w: 32,   h: 32 },
  { file: 'favicon-48.png',           asset: 'favicon',  w: 48,   h: 48 },
  { file: 'apple-touch-icon.png',     asset: 'touch',    w: 180,  h: 180 },
  { file: 'icon-192.png',             asset: 'pwa',      w: 192,  h: 192 },
  { file: 'icon-512.png',             asset: 'pwa',      w: 512,  h: 512 },
  { file: 'maskable-192.png',         asset: 'maskable', w: 192,  h: 192 },
  { file: 'maskable-512.png',         asset: 'maskable', w: 512,  h: 512 },
  { file: 'avatar-512.png',           asset: 'avatar',   w: 512,  h: 512 },

  // Graphics. Big enough to carry the wordmark, so they get one.
  { file: 'og-1200x630.png',          asset: 'og',              w: 1200, h: 630 },
  { file: 'x-banner-1500x500.png',    asset: 'x-banner',        w: 1500, h: 500 },
  // 1512x256 is LinkedIn's stated minimum *and* recommended size for a Page
  // cover. The old 1128x191 was the long-standing spec and is the same 5.906:1
  // aspect, but it now falls under the minimum and the upload is rejected
  // outright — so this has to be regenerated, not rescaled on upload.
  // JPEG, not PNG, and that is LinkedIn's own instruction: "choose a
  // high-resolution JPEG instead of a PNG file". Their uploader rejected a
  // structurally clean PNG at the correct size with only a generic retry
  // message, so the format is the next variable worth removing.
  { file: 'linkedin-1512x256.jpg',    asset: 'linkedin-banner', w: 1512, h: 256,
    format: 'jpeg', quality: 92 },
  { file: 'lockup-1200x300.png',      asset: 'lockup',          w: 1200, h: 300 },

  // Proof sheet, for reviewing the set. Not for use.
  { file: 'sheet.png',                asset: 'sheet',    w: 1240, h: 420 },
];

/** Pack PNGs into a .ico. The format is a 6-byte header, one 16-byte directory
 *  entry per image, then the payloads — PNG is legal inside ICO from Vista on,
 *  which is well past anything that still asks for this file. */
function ico(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);            // reserved
  head.writeUInt16LE(1, 2);            // type: icon
  head.writeUInt16LE(pngs.length, 4);

  let offset = 6 + pngs.length * 16;
  const dir = [];
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);                // palette size: none
    e.writeUInt8(0, 3);                // reserved
    e.writeUInt16LE(1, 4);             // colour planes
    e.writeUInt16LE(32, 6);            // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    dir.push(e);
  }
  return Buffer.concat([head, ...dir, ...pngs.map((p) => p.data)]);
}

const WEBMANIFEST = JSON.stringify({
  name: 'Worldtick',
  short_name: 'Worldtick',
  description: 'Spatial computing, digital twins and 3D visualisation.',
  start_url: '/',
  display: 'standalone',
  background_color: PALETTE.ground,
  theme_color: PALETTE.ground,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2) + '\n';

/* Copied to the site root by --live. Everything else stays in brand/. */
const LIVE = [
  'favicon.svg', 'favicon.ico', 'apple-touch-icon.png',
  'icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png',
  'pinned-tab.svg',
];

const run = async () => {
  const live = (process.argv.find((a) => a.startsWith('--live=')) || '').split('=')[1];
  if (live && !FAMILY_NAMES.includes(live)) {
    throw new Error(`--live must be one of: ${FAMILY_NAMES.join(', ')}`);
  }

  const site = await serve();
  const b = await launch();
  try {
    for (const family of FAMILY_NAMES) {
      const dir = join(ROOT, 'brand', family);
      mkdirSync(dir, { recursive: true });

      for (const [name, body] of Object.entries(VECTORS(family))) {
        writeFileSync(join(dir, name), body);
      }

      const icoParts = [];
      for (const s of RASTERS) {
        await b.viewport({ width: s.w, height: s.h, dpr: 1, mobile: false });
        await b.goto(
          `${site.origin}/tools/brand/render.html?family=${family}&asset=${s.asset}`,
          { settle: 350 },
        );

        for (let i = 0; i < 40; i++) {
          if (await b.evaluate('!!window.__shotReady')) break;
          await new Promise((r) => setTimeout(r, 100));
        }

        const data = await b.screenshot({ format: s.format || 'png', quality: s.quality });
        writeFileSync(join(dir, s.file), data);
        if (/^favicon-(16|32|48)\.png$/.test(s.file)) icoParts.push({ size: s.w, data });
      }

      writeFileSync(join(dir, 'favicon.ico'), ico(icoParts));
      console.log(`brand/${family.padEnd(6)} ${RASTERS.length + 1} rasters, `
        + `${Object.keys(VECTORS(family)).length} vectors`);
    }
  } finally {
    await b.close();
    await site.close();
  }

  if (live) {
    for (const f of LIVE) {
      writeFileSync(join(ROOT, f), readFileSync(join(ROOT, 'brand', live, f)));
    }
    writeFileSync(join(ROOT, 'site.webmanifest'), WEBMANIFEST);
    console.log(`live       ${LIVE.length + 1} files at the site root, from the ${live} set`);
  }
};

run().catch((e) => { console.error(e); process.exit(1); });
