/* Generate the site's image assets from the real scene.
 *
 *   node tools/shoot.mjs [baseUrl]
 *
 * Writes img/hero-poster.jpg and img/og.jpg. Run whenever the scene changes;
 * the output is committed. Icons and the flat brand graphics come from
 * tools/brand/build.mjs instead — they are drawn, not rendered.
 */

import { launch } from './cdp.mjs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SHOTS = [
  {
    // Square, because it is displayed with object-fit:cover behind a hero
    // whose aspect ranges from tall phone to wide desktop. A landscape poster
    // would be cropped savagely on a phone.
    out: 'img/hero-poster.jpg',
    url: 'tools/shoot.html?mode=poster',
    width: 900, height: 900, format: 'jpeg', quality: 74,
  },
  {
    out: 'img/og.jpg',
    url: 'tools/shoot.html?mode=og',
    width: 1200, height: 630, format: 'jpeg', quality: 86,
  },
];

const run = async () => {
  const b = await launch();
  try {
    for (const s of SHOTS) {
      await b.viewport({ width: s.width, height: s.height, dpr: 1, mobile: false });
      await b.goto(`${BASE}/${s.url}`, { settle: 1200 });

      // The scene signals when its second render has landed.
      for (let i = 0; i < 60; i++) {
        if (await b.evaluate('!!window.__shotReady')) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      const buf = await b.screenshot({ format: s.format, quality: s.quality });
      writeFileSync(join(ROOT, s.out), buf);
      console.log(`${s.out.padEnd(24)} ${s.width}x${s.height}  ${(buf.length / 1024).toFixed(0)} KB`);
    }
  } finally {
    await b.close();
  }
};

run().catch((e) => { console.error(e); process.exit(1); });
