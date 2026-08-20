/* Layout and behaviour checks at real CSS viewport widths.
 *
 *   node tools/verify.mjs [baseUrl]
 *
 * Writes screenshots next to the script under tools/_shots/ and prints a pass
 * table. Offline tooling — not deployed.
 */

import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '_shots');

const VIEWPORTS = [
  { name: '360-android', width: 360, height: 780, dpr: 3, mobile: true },
  { name: '390-reference', width: 390, height: 844, dpr: 3, mobile: true },
  { name: '430-promax', width: 430, height: 932, dpr: 3, mobile: true },
  { name: '768-tablet', width: 768, height: 1024, dpr: 2, mobile: true },
  { name: '1280-desktop', width: 1280, height: 800, dpr: 1, mobile: false },
];

const PROBE = `(() => {
  const de = document.documentElement;
  const q = (s) => document.querySelector(s);
  const rect = (s) => { const el = q(s); return el ? el.getBoundingClientRect() : null; };
  // A block element's rect is always the full column width, so measure the
  // rendered glyphs with a Range instead.
  const textRect = (s) => {
    const el = q(s); if (!el) return null;
    const r = document.createRange(); r.selectNodeContents(el);
    return r.getBoundingClientRect();
  };
  const wm = textRect('.wordmark');
  const mail = rect('.mailto');
  const wrap = rect('.hero__inner');
  const overflowers = [...document.querySelectorAll('body *')]
    .filter(el => el.getBoundingClientRect().right > de.clientWidth + 1)
    .map(el => el.className || el.tagName).slice(0, 5);
  return {
    innerWidth: window.innerWidth,
    dpr: window.devicePixelRatio,
    scrollW: de.scrollWidth,
    clientW: de.clientWidth,
    hOverflow: de.scrollWidth > de.clientWidth + 1,
    overflowers,
    wordmarkFits: wm && wrap ? wm.width <= wrap.width + 1 : null,
    wordmarkW: wm ? Math.round(wm.width) : null,
    wrapW: wrap ? Math.round(wrap.width) : null,
    mailtoH: mail ? Math.round(mail.height) : null,
    mailtoW: mail ? Math.round(mail.width) : null,
    rerunH: rect('.rerun') ? Math.round(rect('.rerun').height) : null,
    rerunShown: !document.querySelector('.rerun')?.hidden,
    stageLive: !!q('.stage.is-live'),
    tick: Number(q('#tick-value')?.textContent || -1),
    fontsLoaded: document.fonts.check('500 1rem "IBM Plex Mono"') && document.fonts.check('400 1rem "IBM Plex Sans"'),
  };
})()`;

const run = async () => {
  mkdirSync(OUT, { recursive: true });
  const b = await launch();
  const rows = [];

  try {
    for (const vp of VIEWPORTS) {
      await b.viewport(vp);
      await b.media({ 'prefers-reduced-motion': 'no-preference' });
      await b.goto(`${BASE}/index.html`, { settle: 3800 });

      const r = await b.evaluate(PROBE);
      writeFileSync(join(OUT, `${vp.name}.png`), await b.screenshot());

      // Scrolled state: the document should fully cover the stage.
      await b.evaluate(`window.scrollTo(0, window.innerHeight * 1.15)`);
      await new Promise((s) => setTimeout(s, 900));
      writeFileSync(join(OUT, `${vp.name}-scrolled.png`), await b.screenshot());

      // Bottom of the page: contact and footer sit back on the stage.
      await b.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
      await new Promise((s) => setTimeout(s, 900));
      writeFileSync(join(OUT, `${vp.name}-bottom.png`), await b.screenshot());

      rows.push({ vp: vp.name, ...r });
    }

    // Reduced motion, at the reference width.
    await b.viewport(VIEWPORTS[1]);
    await b.media({ 'prefers-reduced-motion': 'reduce' });
    await b.goto(`${BASE}/index.html`, { settle: 3000 });
    const rm = await b.evaluate(PROBE);
    writeFileSync(join(OUT, 'reduced-motion.png'), await b.screenshot());
    const rmTickA = rm.tick;
    await new Promise((s) => setTimeout(s, 1200));
    const rmTickB = await b.evaluate(`Number(document.querySelector('#tick-value').textContent)`);

    // No-JS, at the reference width.
    await b.send('Emulation.setScriptExecutionDisabled', { value: true });
    await b.media({ 'prefers-reduced-motion': 'no-preference' });
    await b.goto(`${BASE}/index.html`, { settle: 1500 });
    const nojs = await b.evaluate(`1`).catch(() => null);
    writeFileSync(join(OUT, 'no-js.png'), await b.screenshot());
    await b.send('Emulation.setScriptExecutionDisabled', { value: false });

    console.log('\nviewport        inner  hOflow  wordmark        mailto      re-run   stage  tick   fonts');
    console.log('─'.repeat(94));
    for (const r of rows) {
      console.log(
        r.vp.padEnd(15),
        String(r.innerWidth).padEnd(6),
        (r.hOverflow ? 'FAIL' : 'ok').padEnd(7),
        `${r.wordmarkW}/${r.wrapW} ${r.wordmarkFits ? 'ok' : 'FAIL'}`.padEnd(15),
        `${r.mailtoW}x${r.mailtoH} ${r.mailtoH >= 44 ? 'ok' : 'FAIL'}`.padEnd(11),
        `${r.rerunH}px ${r.rerunShown && r.rerunH >= 44 ? 'ok' : 'FAIL'}`.padEnd(8),
        (r.stageLive ? 'live' : 'FAIL').padEnd(6),
        String(r.tick).padEnd(6),
        r.fontsLoaded ? 'ok' : 'FAIL',
      );
      if (r.hOverflow) console.log('    overflowing:', r.overflowers.join(', '));
    }

    console.log('\nreduced-motion: stage', rm.stageLive ? 'live' : 'FAIL',
      '| counter frozen:', rmTickA === rmTickB ? `ok (${rmTickA})` : `FAIL (${rmTickA} -> ${rmTickB})`);
    console.log('no-js: screenshot written (check the poster reads as intentional)');
    console.log(`\nshots -> ${OUT}\n`);
  } finally {
    await b.close();
  }
};

run().catch((e) => { console.error(e); process.exit(1); });
