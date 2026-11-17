// Minimal Chrome DevTools Protocol client with zero dependencies (Node 22+ global WebSocket).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export function findBrowser() {
  const candidates = [process.env.CHROME_PATH];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(base, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const dir of (process.env.PATH || '').split(delimiter)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']) candidates.push(join(dir, name));
    }
  }
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error('No Chrome, Chromium or Edge found. Set CHROME_PATH to the browser executable.');
  return found;
}

class Connection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
        else entry.resolve(message.result);
      } else {
        for (const listener of [...this.listeners]) listener(message);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify(payload));
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor(predicate, timeoutMs = 15000, what = 'event') {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`Timed out waiting for ${what}`)); }, timeoutMs);
      const off = this.on((message) => {
        if (predicate(message)) { clearTimeout(timer); off(); resolve(message); }
      });
    });
  }
}

export async function launch({ args = [], headless = true } = {}) {
  const executable = findBrowser();
  const userDataDir = mkdtempSync(join(tmpdir(), 'scribe-e2e-'));
  const flags = [
    headless ? '--headless=new' : '',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1440,900',
    ...(process.env.CI || process.platform === 'linux' ? ['--no-sandbox'] : []),
    ...args,
  ].filter(Boolean);
  const child = spawn(executable, [...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const started = Date.now();
  // Chrome writes the file while we poll; on Windows a read can briefly fail with EBUSY.
  const readPort = () => { try { return existsSync(portFile) ? readFileSync(portFile, 'utf8') : ''; } catch { return ''; } };
  let content = readPort();
  while (!/^\d+\n\S+/.test(content)) {
    if (child.exitCode !== null) throw new Error(`Browser exited early (${child.exitCode}). ${stderr}`);
    if (Date.now() - started > 30000) throw new Error(`Browser did not start. ${stderr}`);
    await sleep(50);
    content = readPort();
  }
  const [port, path] = content.trim().split('\n');
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const connection = new Connection(socket);
  const version = await connection.send('Browser.getVersion');
  return {
    connection,
    version: version.product,
    executable,
    async close() {
      try { await connection.send('Browser.close'); } catch { /* already gone */ }
      await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 5000); } });
      try { child.kill(); } catch { /* ignore */ }
      for (let i = 0; i < 10; i++) {
        try { rmSync(userDataDir, { recursive: true, force: true }); break; } catch { await sleep(200); }
      }
    },
  };
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27 }, Tab: { code: 'Tab', keyCode: 9 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowUp: { code: 'ArrowUp', keyCode: 38 }, Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' }, Backspace: { code: 'Backspace', keyCode: 8 },
};

/** A page (tab) attached with a flat session. */
export async function openPage(browser, { contextId, url = 'about:blank', width = 1440, height = 900, mobile = false } = {}) {
  const { connection } = browser;
  const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank', ...(contextId ? { browserContextId: contextId } : {}) });
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => connection.send(method, params, sessionId);
  const events = [];
  const off = connection.on((message) => { if (message.sessionId === sessionId) events.push(message); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // Record CSP violations from inside the page (not subject to the page's CSP).
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__csp=[];document.addEventListener("securitypolicyviolation",e=>window.__csp.push(e.violatedDirective+" "+e.blockedURI));' });

  const page = {
    targetId, sessionId, send, events, contextId,
    async goto(target, { waitFor = 'load' } = {}) {
      const loaded = connection.waitFor((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 30000, `load of ${target}`);
      await send('Page.navigate', { url: target });
      if (waitFor === 'load') await loaded;
    },
    async reload() {
      const loaded = connection.waitFor((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired', 30000, 'reload');
      await send('Page.reload', {});
      await loaded;
    },
    /** Evaluates a function in the page with JSON-serialisable arguments. */
    async eval(fn, ...args) {
      const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(`Page error: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      return result.result.value;
    },
    async waitFor(fn, { timeout = 15000, interval = 50, args = [], what } = {}) {
      const started = Date.now();
      let last;
      while (Date.now() - started < timeout) {
        try { last = await page.eval(fn, ...args); } catch (error) { last = error.message; }
        if (last) return last;
        await sleep(interval);
      }
      throw new Error(`Timed out waiting for ${what || fn.toString().slice(0, 160)} (last: ${JSON.stringify(last)?.slice(0, 200)})`);
    },
    async click(selector) {
      const ok = await page.eval((sel) => { const el = document.querySelector(sel); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; }, selector);
      if (!ok) throw new Error(`No element for ${selector}`);
    },
    /** A real mouse click at the element's centre (pointer events, focus). */
    async mouseClick(selector) {
      const box = await page.eval((sel) => { const el = document.querySelector(sel); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, selector);
      if (!box) throw new Error(`No element for ${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    },
    async hover(selector) {
      const box = await page.eval((sel) => { const el = document.querySelector(sel); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 }; }, selector);
      if (!box) throw new Error(`No element for ${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    },
    async focus(selector) {
      const ok = await page.eval((sel) => { const el = document.querySelector(sel); if (!el) return false; el.focus(); return document.activeElement === el; }, selector);
      if (!ok) throw new Error(`Could not focus ${selector}`);
    },
    /** Types into the focused element (or `selector` after clearing it) like a user. */
    async type(selector, text, { clear = true } = {}) {
      if (selector) {
        await page.focus(selector);
        if (clear) await page.eval((sel) => { const el = document.querySelector(sel); if ('value' in el && el.tagName !== 'LI') { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } }, selector);
      }
      await send('Input.insertText', { text });
    },
    async press(key, { modifiers = 0 } = {}) {
      const info = KEYS[key] || { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
      const base = { key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers };
      await send('Input.dispatchKeyEvent', { type: info.text && !modifiers ? 'keyDown' : 'rawKeyDown', ...base, ...(info.text && !modifiers ? { text: info.text } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async screenshot(path, { fullPage = false } = {}) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, Buffer.from(data, 'base64'));
    },
    async setFile(selector, path) {
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`No file input ${selector}`);
      await send('DOM.setFileInputFiles', { nodeId, files: [path] });
    },
    async close() {
      off();
      try { await connection.send('Target.closeTarget', { targetId }); } catch { /* ignore */ }
    },
  };
  if (url !== 'about:blank') await page.goto(url);
  return page;
}

export function hasCommand(name) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [name]).status === 0;
}
