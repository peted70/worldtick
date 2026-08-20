/* Minimal Chrome DevTools Protocol driver. No dependencies — Node 22+ has
 * global fetch and WebSocket, which is all this needs.
 *
 * Exists because `chrome --headless --window-size` clamps to a 500px minimum
 * on Windows and ignores device scale factor, so it cannot screenshot a 390px
 * phone viewport. Emulation.setDeviceMetricsOverride can.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, extraArgs = [] } = {}) {
  const { existsSync } = await import('node:fs');
  const exe = CHROME_CANDIDATES.find(existsSync);
  if (!exe) throw new Error('No Chrome or Edge found.');

  const profile = mkdtempSync(join(tmpdir(), 'worldtick-shot-'));
  const proc = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    // SwiftShader keeps this working on machines with no usable GPU in a
    // headless session. Slower, but the output is identical.
    '--enable-unsafe-swiftshader',
    ...extraArgs,
    'about:blank',
  ], { stdio: 'ignore' });

  // Wait for the debugging endpoint to come up.
  let target = null;
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* not listening yet */ }
  }
  if (!target) { proc.kill(); throw new Error('Chrome did not expose a debug target'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function on(method, fn) {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method).delete(fn);
  }

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    send,
    on,

    /** Set an exact CSS viewport and pixel ratio, bypassing the window floor. */
    async viewport({ width, height, dpr = 2, mobile = true }) {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: dpr, mobile,
        screenWidth: width, screenHeight: height,
      });
      // maxTouchPoints must be 1..16, so it is only valid to send when enabling.
      await send('Emulation.setTouchEmulationEnabled',
        mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    },

    /** Emulate a media feature, e.g. prefers-reduced-motion. */
    async media(features) {
      await send('Emulation.setEmulatedMedia', {
        features: Object.entries(features).map(([name, value]) => ({ name, value })),
      });
    },

    async goto(url, { settle = 2500 } = {}) {
      const loaded = new Promise((resolve) => {
        const off = on('Page.loadEventFired', () => { off(); resolve(); });
      });
      await send('Page.navigate', { url });
      await Promise.race([loaded, sleep(20000)]);
      await sleep(settle);
    },

    async evaluate(expression) {
      const r = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
      }
      return r.result.value;
    },

    async screenshot({ format = 'png', quality } = {}) {
      const r = await send('Page.captureScreenshot', {
        format, ...(quality ? { quality } : {}), captureBeyondViewport: false,
      });
      return Buffer.from(r.data, 'base64');
    },

    async close() {
      try { ws.close(); } catch {}
      proc.kill();
      await sleep(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
}

export { sleep };
