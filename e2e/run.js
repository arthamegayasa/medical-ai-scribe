// Browser end-to-end tests: `npm run test:e2e`. Zero npm dependencies.
// Starts the app server, a static-only server, a server-mode server and a mock provider, then
// drives headless Chrome/Edge over the DevTools protocol. Optional final screenshots:
//   node e2e/run.js --shots=<dir>      (or E2E_SHOTS=<dir>)
//   node e2e/run.js --only=example,errors
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { launch, openPage } from './cdp.js';
import { startMockProvider } from './mock-provider.js';
import { writeSpeechLikeWav } from './wav.js';
import { makeServer } from '../dev-server.js';

const argv = Object.fromEntries(process.argv.slice(2).map((arg) => { const [k, v = 'true'] = arg.replace(/^--/, '').split('='); return [k, v]; }));
const SHOTS = argv.shots || process.env.E2E_SHOTS || '';
const ONLY = argv.only ? new Set(argv.only.split(',')) : null;
const TMP = mkdtempSync(join(tmpdir(), 'scribe-e2e-data-'));

const TRANSCRIPT = [
  'Doctor: Good afternoon, what brings you in today?',
  'Patient: I have had a sore throat for three days and a temperature of 38.5 degrees.',
  'Patient: Swallowing hurts more in the morning.',
  'Doctor: Your throat looks red and the tonsils are swollen.',
  'Doctor: Take paracetamol 500 mg up to four times a day and come back in five days if it is not better.',
].join('\n');

// ---------- Servers ----------
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

const mock = await startMockProvider();
// A clean environment: provider keys from the developer's shell must not switch on server mode.
const appServer = makeServer({ env: { NODE_ENV: 'test' } });
const appBase = await listen(appServer);
const serverModeServer = makeServer({ env: {
  NODE_ENV: 'test', COMPATIBLE_BASE_URL: mock.url, COMPATIBLE_API_KEY: 'mock-server-key', COMPATIBLE_MODEL: 'mock-note-mini',
  TRANSCRIPTION_BASE_URL: mock.url, TRANSCRIPTION_API_KEY: 'mock-server-key', TRANSCRIPTION_MODEL: 'whisper-mock', SCRIBE_ACCESS_TOKEN: 'e2e-access-token',
} });
const serverBase = await listen(serverModeServer);
// Static hosting: the same files, no /api at all.
const staticHandler = makeServer({ env: {} }).listeners('request')[0];
const staticServer = createServer((req, res) => {
  if (req.url.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Not found</title>'); return; }
  staticHandler(req, res);
});
const staticBase = await listen(staticServer);

const fakeAudio = writeSpeechLikeWav(join(TMP, 'fake-mic.wav'), 8, 48000);
const browser = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeAudio}`] });
console.log(`Browser: ${browser.version} (${browser.executable})`);

// ---------- Harness ----------
const results = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const eq = (actual, expected, message) => assert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

async function scenario(name, fn) {
  if (ONLY && !ONLY.has(name)) return;
  const started = Date.now();
  const pages = [];
  const contexts = [];
  const env = {
    async page(url, options = {}) {
      let contextId = options.contextId;
      if (!contextId) {
        ({ browserContextId: contextId } = await browser.connection.send('Target.createBrowserContext', { disposeOnDetach: false }));
        contexts.push(contextId);
        const origin = url.startsWith('http') ? new URL(url).origin : appBase;
        await browser.connection.send('Browser.grantPermissions', { browserContextId: contextId, origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite', 'audioCapture'] });
      }
      const page = await openPage(browser, { ...options, contextId, url });
      page.allowNetwork = options.allowNetwork || [];
      pages.push(page);
      return page;
    },
  };
  try {
    await fn(env);
    for (const page of pages) await assertClean(page);
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ok  ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error });
    console.log(`  FAIL ${name}: ${error.stack || error.message}`);
    for (const page of pages) {
      const problems = page.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
      for (const e of problems.slice(0, 8)) console.log(`       page log: ${JSON.stringify(e.params).slice(0, 300)}`);
    }
    try { if (pages.at(-1)) await pages.at(-1).screenshot(join(TMP, `fail-${name}.png`)); console.log(`       screenshot: ${join(TMP, `fail-${name}.png`)}`); } catch { /* ignore */ }
  } finally {
    for (const page of pages) await page.close();
    for (const contextId of contexts) await browser.connection.send('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => {});
  }
}

/** No uncaught errors, console errors/warnings, CSP violations or unexpected failed requests. */
async function assertClean(page) {
  const problems = [];
  for (const event of page.events) {
    if (event.method === 'Runtime.exceptionThrown') problems.push(`exception: ${event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text}`);
    if (event.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(event.params.type)) problems.push(`console.${event.params.type}: ${event.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (event.method === 'Log.entryAdded' && ['error', 'warning'].includes(event.params.entry.level)) {
      const { source, text, url = '' } = event.params.entry;
      const allowed = source === 'network' && page.allowNetwork.some((prefix) => url.startsWith(prefix));
      if (!allowed && !(source === 'other' && /Unrecognized feature/.test(text))) problems.push(`log ${source}: ${text} ${url}`);
    }
  }
  const csp = await page.eval(() => window.__csp || []).catch(() => []);
  for (const violation of csp) problems.push(`CSP violation: ${violation}`);
  assert(!problems.length, `Console or CSP problems:\n    ${problems.join('\n    ')}`);
}

const app = (page) => page.waitFor(() => document.documentElement.dataset.app === 'ready', { what: 'app ready' });
const state = (page) => page.eval(() => {
  const s = window.__scribe.store.getState();
  return { capture: s.capture.state, note: s.noteState.state, turns: s.session.turns.length, labels: s.session.labels, mode: s.mode, selection: s.prefs.selection, connections: s.connections.length };
});
const text = (page, selector) => page.eval((sel) => document.querySelector(sel)?.textContent?.trim() || '', selector);
const visible = (page, selector) => page.eval((sel) => { const el = document.querySelector(sel); return Boolean(el && el.offsetParent !== null && !el.closest('[hidden]')); }, selector);

async function closeDialogs(page) {
  await page.eval(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
}

async function skipOnboarding(page) {
  await page.waitFor(() => document.getElementById('onboarding-dialog').open, { what: 'onboarding' });
  await page.click('#ob-skip');
}

async function openSettings(page, section) {
  await page.eval((s) => { if (!document.getElementById('settings-dialog').open) document.getElementById('btn-settings').click(); document.querySelector(`[data-settings-tab="${s}"]`).click(); }, section);
  await page.waitFor((s) => !document.getElementById(`set-${s}`).hidden, { args: [section], what: `settings ${section}` });
}

async function addCustomConnection(page, { baseUrl = mock.url, key = 'mock-key-e2e', name = 'Mock provider', remember = 'session', expectOk = true } = {}) {
  await openSettings(page, 'connections');
  await page.click('#btn-add-connection');
  await page.click('input[name="conn-preset"][value="custom"]');
  await page.type('#conn-base-url', baseUrl);
  await page.type('#conn-name', name);
  if (key) await page.type('#conn-key', key);
  await page.click(`input[name="conn-remember"][value="${remember}"]`);
  await page.click('#btn-test-connection');
  await page.waitFor(() => ['ok', 'error', 'idle'].includes(document.getElementById('conn-test-result').dataset.state) && document.getElementById('conn-test-result').dataset.state !== 'testing' && document.getElementById('conn-test-message').textContent, { what: 'connection test' });
  const result = await page.eval(() => ({ state: document.getElementById('conn-test-result').dataset.state, message: document.getElementById('conn-test-message').textContent }));
  if (!expectOk) return result;
  eq(result.state, 'ok', `connection test (${result.message})`);
  await page.click('#btn-conn-save');
  await page.waitFor(() => document.getElementById('set-connections').dataset.view === 'list', { what: 'saved connection' });
  return result;
}

async function pickModel(page, role, query, expected) {
  await openSettings(page, 'models');
  await page.waitFor((r) => ['ready', 'manual'].includes(document.getElementById(`picker-${r}`).dataset.state), { args: [role], what: `${role} models loaded` });
  await page.type(`#model-${role}-input`, query);
  await page.waitFor((r) => !document.getElementById(`model-${r}-list`).hidden, { args: [role], what: `${role} listbox open` });
  await page.press('ArrowDown');
  const active = await page.eval((r) => document.getElementById(`model-${r}-input`).getAttribute('aria-activedescendant'), role);
  assert(active, 'combobox sets aria-activedescendant on arrow keys');
  await page.press('Enter');
  await page.waitFor((r, e) => window.__scribe.store.getState().prefs.selection[r].model === e, { args: [role, expected], what: `${role} model ${expected}` });
}

async function pasteTranscript(page, transcript = TRANSCRIPT) {
  await page.click('#capture-tab-paste');
  await page.waitFor(() => !document.querySelector('dialog[open]') && document.getElementById('paste-input').offsetParent !== null, { what: 'paste box ready' });
  await page.type('#paste-input', transcript);
  await page.click('#btn-use-paste');
  await page.waitFor(() => !document.getElementById('transcript').hidden, { what: 'transcript shown' });
}

async function generate(page, { expect = 'ready' } = {}) {
  await page.click('#btn-generate');
  await page.waitFor((e) => window.__scribe.store.getState().noteState.state === e, { args: [expect], what: `note ${expect}`, timeout: 30000 });
}

const downloads = [];
browser.connection.on((message) => {
  if (message.method === 'Browser.downloadWillBegin') downloads.push({ guid: message.params.guid, name: message.params.suggestedFilename, done: false });
  if (message.method === 'Browser.downloadProgress' && message.params.state === 'completed') {
    const entry = downloads.find((d) => d.guid === message.params.guid);
    if (entry) entry.done = true;
  }
});

async function captureDownload(page, dir, trigger) {
  const before = downloads.length;
  await trigger();
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const entry = downloads.slice(before).find((d) => d.done);
    if (entry) return { name: entry.name, data: readFileSync(join(dir, entry.guid)) };
    await sleep(50);
  }
  throw new Error('Download did not complete');
}

async function exportFile(page, dir, kind) {
  return captureDownload(page, dir, async () => {
    await page.click('#btn-export');
    await page.click(`[data-export="${kind}"]`);
  });
}

function readStoredZip(bytes) {
  const files = {};
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extra;
    const raw = bytes.subarray(start, start + size);
    files[name] = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    offset = start + size;
  }
  return files;
}

async function useDownloads(contextId) {
  const dir = mkdtempSync(join(TMP, 'dl-'));
  await browser.connection.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, browserContextId: contextId, eventsEnabled: true });
  return dir;
}

const mockStats = async () => (await fetch(`${mock.origin}/__stats`)).json();
const resetMock = () => fetch(`${mock.origin}/__reset`);

// ---------- Scenarios ----------
console.log(`App ${appBase}  static ${staticBase}  server-mode ${serverBase}  mock ${mock.url}`);

await scenario('landing', async (env) => {
  const page = await env.page(`${appBase}/`);
  const meta = await page.eval(() => ({
    canonical: document.querySelector('link[rel="canonical"]')?.href,
    ogUrl: document.querySelector('meta[property="og:url"]')?.content,
    ogImage: document.querySelector('meta[property="og:image"]')?.content,
  }));
  eq(meta.canonical, 'https://medicalaiscribe.vercel.app/', 'landing canonical');
  eq(meta.ogImage, 'https://medicalaiscribe.vercel.app/assets/img/og-image.png', 'absolute og:image');
  const appPage = await env.page(`${appBase}/app/`, { contextId: page.contextId });
  await app(appPage);
  const appMeta = await appPage.eval(() => ({ canonical: document.querySelector('link[rel="canonical"]')?.href, ogImage: document.querySelector('meta[property="og:image"]')?.content }));
  eq(appMeta.canonical, 'https://medicalaiscribe.vercel.app/app/', 'app canonical');
  eq(appMeta.ogImage, 'https://medicalaiscribe.vercel.app/assets/img/og-image.png', 'app og:image');
  // The ?demo= design-review harness still renders (the real app stays out of its way).
  const demo = await env.page(`${appBase}/app/?demo=note`, { contextId: page.contextId });
  await demo.waitFor(() => document.documentElement.dataset.demo === 'note', { what: 'demo state' });
  eq(await demo.eval(() => document.documentElement.dataset.app), undefined, 'app wiring is idle in demo mode');
});

await scenario('degraded', async (env) => {
  // Storage blocked (private mode), no IndexedDB and no MediaRecorder: the rest must still work.
  const page = await env.page('about:blank', { allowNetwork: [mock.origin] });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, { get() { throw new DOMException('blocked', 'SecurityError'); } });
    Object.defineProperty(window, 'indexedDB', { value: undefined });
    delete window.MediaRecorder; window.MediaRecorder = undefined;` });
  await page.goto(`${appBase}/app/`);
  await app(page);
  await skipOnboarding(page);
  eq(await page.eval(() => document.getElementById('btn-record').disabled), true, 'record disabled without MediaRecorder');
  assert((await text(page, '#record-hint')).includes('cannot record'), 'unsupported recording message');
  eq(await page.eval(() => document.getElementById('capture').dataset.method), 'upload', 'falls back to upload');
  // Drag and drop an audio file onto the drop zone.
  await page.eval(() => {
    const bytes = new Uint8Array(44 + 3200);
    new TextEncoder().encodeInto('RIFF', bytes); new TextEncoder().encodeInto('WAVE', bytes.subarray(8));
    const file = new File([bytes], 'dropped-consultation.wav', { type: 'audio/wav' });
    const data = new DataTransfer();
    data.items.add(file);
    const zone = document.getElementById('dropzone');
    zone.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  eq(await text(page, '#upload-file-name'), 'dropped-consultation.wav', 'dropped file selected');
  await page.click('#btn-remove-file');
  await addCustomConnection(page);
  await openSettings(page, 'privacy');
  assert(await visible(page, '#storage-blocked'), 'storage-blocked notice');
  assert(await visible(page, '#pref-history-unavailable'), 'history unavailable notice');
  eq(await page.eval(() => document.getElementById('pref-history').disabled), true, 'history toggle disabled');
  await pickModel(page, 'note', 'mini', 'mock-note-mini');
  await closeDialogs(page);
  await pasteTranscript(page);
  await generate(page);
});

await scenario('example', async (env) => {
  const page = await env.page(`${appBase}/app/?example=1`);
  await app(page);
  await page.waitFor(() => window.__scribe.store.getState().noteState.state === 'ready', { what: 'example draft' });
  const view = await page.eval(() => ({
    band: !document.getElementById('example-band').hidden,
    chip: document.getElementById('connection-chip').dataset.state,
    statements: document.querySelectorAll('#note-sheet .statement').length,
    unverified: document.querySelectorAll('#note-sheet .statement[data-grounding="unverified"]').length,
    grounded: document.querySelectorAll('#note-sheet .statement[data-grounding="grounded"]').length,
    provenance: document.getElementById('note-provenance').textContent,
    draftBand: getComputedStyle(document.querySelector('.draft-band')).display !== 'none',
  }));
  assert(view.band, 'fictional band is visible');
  eq(view.chip, 'example', 'chip shows the example');
  eq(view.statements, 14, 'example statements');
  eq(view.unverified, 1, 'one deliberately unverified statement');
  eq(view.grounded, 13, 'the rest are grounded by the real verifier');
  assert(view.draftBand, 'draft band visible');
  assert(/No AI request/.test(view.provenance), 'example provenance');
  // No request ever leaves the app origin.
  const foreign = page.events.filter((e) => e.method === 'Network.requestWillBeSent' && !e.params.request.url.startsWith(appBase) && !e.params.request.url.startsWith('data:') && !e.params.request.url.startsWith('blob:'));
  eq(foreign.length, 0, 'requests outside the app origin');
  const posts = page.events.filter((e) => e.method === 'Network.requestWillBeSent' && e.params.request.method !== 'GET');
  eq(posts.length, 0, 'non-GET requests during the example');
  // Generating again reuses the prepared draft without any request.
  await page.click('#btn-generate');
  await page.waitFor(() => window.__scribe.store.getState().noteState.state === 'ready');
  // Indonesian follows the interface language.
  await page.click('[data-set-lang="id"]');
  await page.waitFor(() => document.querySelector('.turn[data-turn-id="t1"] .turn__text')?.textContent.startsWith('Selamat pagi'), { what: 'Indonesian example' });
  const idView = await page.eval(() => ({ unverified: document.querySelectorAll('#note-sheet .statement[data-grounding="unverified"]').length, cc: document.querySelector('[data-statements="chief_complaint"] .statement__text').textContent, band: document.querySelector('#example-band .callout__title').textContent }));
  eq(idView.unverified, 1, 'Indonesian example unverified count');
  assert(idView.cc.startsWith('Baal'), 'Indonesian chief complaint');
  eq(idView.band, 'Contoh fiktif', 'Indonesian band title');
  const dir = await useDownloads(page.contextId);
  const md = await exportFile(page, dir, 'markdown');
  const content = md.data.toString('utf8');
  assert(md.name.includes('fictional'), 'fictional file name');
  assert(content.includes('CONTOH FIKTIF') && content.includes('DRAF'), 'Indonesian export carries the fictional and draft labels');
  assert(content.includes('[TIDAK TERVERIFIKASI]'), 'unverified marker in export');
  await page.click('[data-set-lang="en"]');
});

await scenario('byok-flow', async (env) => {
  await resetMock();
  const page = await env.page(`${appBase}/app/`, { allowNetwork: [mock.origin] });
  await app(page);
  await skipOnboarding(page);
  const dir = await useDownloads(page.contextId);
  await addCustomConnection(page);
  const listed = await page.eval(() => document.querySelector('#connections-list .conn-item__status').textContent);
  eq(listed, 'Working', 'connection status after a successful test');
  await pickModel(page, 'note', 'mini', 'mock-note-mini');
  await pickModel(page, 'transcription', 'whisper-m', 'whisper-mock');
  // Escape closes an open listbox without closing the dialog.
  await page.type('#model-note-input', 'mock');
  await page.waitFor(() => !document.getElementById('model-note-list').hidden, { what: 'listbox open before Escape' });
  await page.press('Escape');
  assert(await page.eval(() => document.getElementById('settings-dialog').open && document.getElementById('model-note-list').hidden), 'Escape closes only the listbox');
  await closeDialogs(page);
  eq(await page.eval(() => document.getElementById('connection-chip').dataset.state), 'ok', 'chip after connecting');

  await pasteTranscript(page);
  const turns = await page.eval(() => [...document.querySelectorAll('#turns .turn')].map((t) => t.dataset.speaker));
  eq(turns.join(','), 'doctor,patient,patient,doctor,doctor', 'pasted labels become turns');

  // Streaming: sections appear before the draft is complete.
  await page.click('#btn-generate');
  let streamed = 0;
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const s = await page.eval(() => ({ state: window.__scribe.store.getState().noteState.state, live: document.querySelectorAll('#note-stream .statement').length }));
    if (s.state === 'generating') streamed = Math.max(streamed, s.live);
    if (s.state === 'ready') break;
    await sleep(15);
  }
  assert(streamed > 0, 'statements were shown while the draft streamed');
  const chat = (await mockStats()).chat.at(-1);
  assert(chat.stream && chat.kind === 'soap_note' && chat.model === 'mock-note-mini', `streamed json_schema request (${JSON.stringify(chat)})`);
  const view = await page.eval(() => ({
    grounded: document.querySelectorAll('#note-sheet .statement[data-grounding="grounded"]').length,
    unverified: document.querySelectorAll('#note-sheet .statement[data-grounding="unverified"]').length,
    flags: document.getElementById('flags-count').textContent,
    provenance: document.getElementById('note-provenance').textContent,
  }));
  assert(view.grounded >= 4, `grounded statements (${view.grounded})`);
  eq(view.unverified, 1, 'the fabricated statement is unverified');
  eq(view.flags, '1', 'one review flag');
  assert(view.provenance.includes('mock-note-mini'), 'provenance names the model');

  // Evidence: statement -> transcript span, and turn -> statements.
  await page.focus('#note-sheet .statement[data-grounding="grounded"] .statement__text');
  const linked = await page.eval(() => ({ turns: document.querySelectorAll('.turn.is-linked').length, spans: CSS.highlights?.get('scribe-evidence')?.size ?? -1 }));
  assert(linked.turns >= 1, 'linked turns highlighted');
  assert(linked.spans >= 1, `exact span highlighted (${linked.spans})`);
  await page.hover('#turns .turn:nth-child(4) .turn__text');
  await page.waitFor(() => document.querySelectorAll('.statement.is-cited').length > 0, { what: 'turn highlights the statements citing it' });
  await page.click('[data-statements="objective"] button.ev-chip');
  await page.waitFor(() => document.querySelector('.turn.is-flash'), { what: 'chip click flashes the source turn' });

  // Edit a statement: the verifier re-runs and flags the new number.
  await page.focus('[data-statements="plan"] .statement__text');
  await page.eval(() => { const el = document.querySelector('[data-statements="plan"] .statement__text'); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await page.type(null, ' Ibuprofen 900 mg if needed.', { clear: false });
  await page.waitFor(() => document.querySelector('[data-statements="plan"] .ev-chip--number'), { what: 'check-number chip after editing' });
  // Add and remove a line.
  await page.click('[data-section="assessment"] [data-action="add-statement"]');
  await page.type(null, 'Clinician note added by hand.', { clear: false });
  await page.waitFor(() => document.querySelectorAll('[data-statements="assessment"] .statement').length === 1);
  await page.click('[data-statements="assessment"] [data-action="remove-statement"]');
  await page.waitFor(() => document.querySelectorAll('[data-statements="assessment"] .statement').length === 0);

  // Review flag check-off.
  await page.click('#flags-list .flag__resolve');
  eq(await text(page, '#flags-count'), '0', 'open flags after check-off');

  // Rewrite one section.
  await page.eval(() => document.querySelector('[data-section="plan"] [data-action="regenerate-section"]').click());
  await page.waitFor(() => window.__scribe.store.getState().noteState.regenerating === null && document.querySelector('[data-statements="plan"] .statement[data-statement-id] .statement__text')?.textContent.startsWith('Rewritten:'), { what: 'section rewritten', timeout: 20000 });
  const sectionRequest = (await mockStats()).chat.at(-1);
  eq(sectionRequest.kind, 'soap_section', 'section request schema');

  // Exports.
  const md = (await exportFile(page, dir, 'markdown')).data.toString('utf8');
  assert(md.includes('DRAFT - requires clinician review'), 'markdown draft label');
  assert(md.includes('[UNVERIFIED]'), 'markdown unverified marker');
  assert(md.includes('Rewritten:'), 'markdown has the rewritten plan');
  assert(md.includes('mock-note-mini'), 'markdown provenance');
  assert(!md.includes('WARNING: the transcript was edited'), 'no stale warning yet');
  const txt = (await exportFile(page, dir, 'text')).data.toString('utf8');
  assert(txt.startsWith('SOAP NOTE (DRAFT)'), 'plain text title');
  const docx = await exportFile(page, dir, 'docx');
  assert(docx.name.endsWith('.docx'), 'docx name');
  const zip = readStoredZip(docx.data);
  assert(zip['word/document.xml']?.includes('DRAFT - requires clinician review'), 'docx carries the draft label');
  assert(zip['[Content_Types].xml'], 'docx content types');

  // Edit the transcript: stale banner, and exports now carry the warning.
  await page.focus('#turns .turn:last-child .turn__text');
  await page.eval(() => { const el = document.querySelector('#turns .turn:last-child .turn__text'); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await page.type(null, ' Drink plenty of water.', { clear: false });
  await page.waitFor(() => document.getElementById('note').dataset.stale === 'true', { what: 'stale banner' });
  assert(await visible(page, '#stale-banner'), 'stale banner visible');
  const staleMd = (await exportFile(page, dir, 'markdown')).data.toString('utf8');
  assert(staleMd.includes('WARNING: the transcript was edited'), 'stale export warning');
  await page.click('#btn-stale-dismiss');
  await page.waitFor(() => document.getElementById('note').dataset.stale === 'false', { what: 'stale banner dismissed' });
  assert((await exportFile(page, dir, 'text')).data.toString('utf8').includes('WARNING: the transcript was edited'), 'exports keep the warning after "Keep this draft"');

  // Copy whole note and one section.
  await page.click('#btn-export');
  await page.click('[data-export="copy"]');
  await page.waitFor(async () => (await navigator.clipboard.readText()).startsWith('SOAP NOTE (DRAFT)'), { what: 'clipboard has the note' });
  await page.eval(() => document.querySelector('[data-section="objective"] [data-action="copy-section"]').click());
  await page.waitFor(async () => { const c = await navigator.clipboard.readText(); return c.includes('OBJECTIVE:') && c.startsWith('DRAFT'); }, { what: 'clipboard has the section with the draft label' });

  // Print: a blob: document in an iframe under the CSP, with the linked print stylesheet.
  await page.click('#btn-export');
  await page.click('[data-export="print"]');
  await page.waitFor(() => { const f = document.querySelector('iframe.print-frame'); return f?.contentDocument?.body?.textContent.includes('DRAFT - requires clinician review'); }, { what: 'print document' });
  const printCss = await page.eval(() => { const doc = document.querySelector('iframe.print-frame').contentDocument; return doc.querySelector('link[rel="stylesheet"]')?.href; });
  eq(printCss, `${appBase}/core/export/print.css`, 'print stylesheet');
  await page.waitFor(() => { const doc = document.querySelector('iframe.print-frame').contentDocument; return doc.styleSheets.length === 1 && doc.styleSheets[0].cssRules.length > 0; }, { what: 'print stylesheet applied' });

  // Keyboard shortcut sheet.
  await page.eval(() => document.activeElement?.blur());
  await page.press('?');
  await page.waitFor(() => document.getElementById('shortcuts-dialog').open, { what: 'shortcut sheet' });
  await page.press('Escape');
});

await scenario('onboarding', async (env) => {
  const page = await env.page(`${appBase}/app/`, { allowNetwork: [mock.origin] });
  await app(page);
  await page.waitFor(() => document.getElementById('onboarding-dialog').open);
  await page.click('input[name="ob-preset"][value="custom"]');
  assert(await visible(page, '#ob-base-url-field'), 'base URL field for a custom endpoint');
  // Continue is blocked until the connection is tested.
  await page.click('#ob-next');
  eq(await page.eval(() => document.getElementById('onboarding-dialog').dataset.step), '1', 'cannot continue untested');
  await page.type('#ob-base-url', mock.url);
  await page.type('#ob-key', 'mock-key-onboarding');
  await page.click('#ob-btn-test');
  await page.waitFor(() => document.getElementById('ob-test-result').dataset.state === 'ok', { what: 'onboarding test' });
  await page.click('#ob-next');
  await page.waitFor(() => document.getElementById('onboarding-dialog').dataset.step === '2');
  await page.waitFor(() => [...document.getElementById('ob-model-note').options].some((o) => o.value === 'mock-note-pro'), { what: 'onboarding note models' });
  await page.eval(() => { const s = document.getElementById('ob-model-note'); s.value = 'mock-note-pro'; const t = document.getElementById('ob-model-transcription'); t.value = 'whisper-mock'; });
  eq(await page.eval(() => [...document.getElementById('ob-model-transcription').options].every((o) => /whisper/.test(o.value))), true, 'transcription list shows transcription models only');
  await page.click('#ob-next');
  await page.click('#ob-choose-capture');
  const s = await state(page);
  eq(s.selection.note.model, 'mock-note-pro', 'note model chosen in onboarding');
  eq(s.selection.transcription.model, 'whisper-mock', 'transcription model chosen in onboarding');
  eq(await page.eval(() => document.getElementById('ob-key').value), '', 'key cleared from the onboarding form');
  await page.reload();
  await app(page);
  assert(!(await page.eval(() => document.getElementById('onboarding-dialog').open)), 'onboarding does not reappear');
});

await scenario('record', async (env) => {
  await resetMock();
  const page = await env.page(`${appBase}/app/`, { allowNetwork: [mock.origin] });
  await app(page);
  await skipOnboarding(page);
  await addCustomConnection(page);
  await pickModel(page, 'note', 'mini', 'mock-note-mini');
  await pickModel(page, 'transcription', 'whisper-m', 'whisper-mock');
  await closeDialogs(page);
  await page.eval(() => document.activeElement?.blur());
  await page.press('r'); // keyboard shortcut: start recording
  await page.waitFor(() => window.__scribe.store.getState().capture.state === 'recording', { what: 'recording' });
  await page.waitFor(() => [...document.querySelectorAll('#rec-meter .meter__bar')].some((b) => Number(b.style.getPropertyValue('--h')) > 0.01), { what: 'live level meter' });
  // Leaving mid-recording asks first.
  const dialog = browser.connection.waitFor((m) => m.sessionId === page.sessionId && m.method === 'Page.javascriptDialogOpening', 8000, 'beforeunload prompt');
  page.send('Page.reload', {}).catch(() => {});
  const prompt = await dialog;
  eq(prompt.params.type, 'beforeunload', 'leave-page warning while recording');
  await page.send('Page.handleJavaScriptDialog', { accept: false });
  await sleep(1000);
  await page.eval(() => document.activeElement?.blur());
  await page.press(' '); // shortcut: pause
  await page.waitFor(() => window.__scribe.store.getState().capture.state === 'paused' && document.getElementById('btn-pause').dataset.state === 'resume', { what: 'paused' });
  const pausedAt = await text(page, '#rec-timer');
  await sleep(1100);
  eq(await text(page, '#rec-timer'), pausedAt, 'timer stops while paused');
  await page.press(' '); // shortcut: resume
  await page.waitFor(() => window.__scribe.store.getState().capture.state === 'recording');
  await sleep(1200);
  await page.press('r'); // shortcut: stop and transcribe
  await page.waitFor(() => !document.getElementById('transcript').hidden, { what: 'transcript from recording', timeout: 30000 });
  const stats = await mockStats();
  eq(stats.transcriptions.length, 1, 'one direct upload for a short recording');
  assert(stats.transcriptions[0].bytes > 1000, 'recorded audio uploaded');
  const s = await state(page);
  eq(s.labels, 'ai', 'speaker labels suggested by AI');
  assert(await visible(page, '#speaker-source'), 'AI-suggested labels are marked');
  assert(await page.eval(() => document.querySelectorAll('.turn[data-ai-speaker="true"]').length > 1), 'turns marked as AI-suggested');
  await page.eval(() => document.activeElement?.blur());
  await page.press('Enter', { modifiers: process.platform === 'darwin' ? 4 : 2 }); // Ctrl/Cmd+Enter writes the draft
  await page.waitFor(() => window.__scribe.store.getState().noteState.state === 'ready', { what: 'draft via shortcut', timeout: 30000 });
  assert(await page.eval(() => document.querySelectorAll('#note-sheet .statement').length > 2), 'draft from the recording');
});

await scenario('microphone-problems', async (env) => {
  // Permission denied: recovery steps, then a way out to upload. (The fake-media flags
  // auto-accept prompts, so the browser's refusal is simulated at the getUserMedia boundary.)
  const page = await env.page('about:blank', { allowNetwork: [mock.origin] });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"));' });
  await page.goto(`${appBase}/app/`);
  await app(page);
  await skipOnboarding(page);
  await addCustomConnection(page);
  await closeDialogs(page);
  await page.click('#btn-record');
  await page.waitFor(() => window.__scribe.store.getState().capture.state === 'denied', { what: 'denied state' });
  assert(await visible(page, '#btn-denied-retry'), 'denied recovery shown');
  await page.click('.capture-stage--denied [data-capture-method="upload"]');
  await page.waitFor(() => document.getElementById('capture').dataset.method === 'upload' && window.__scribe.store.getState().capture.state === 'idle', { what: 'switched to upload' });
  // No microphone at all.
  const other = await env.page('about:blank', { allowNetwork: [mock.origin] });
  await other.send('Page.addScriptToEvaluateOnNewDocument', { source: 'navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("none", "NotFoundError"));' });
  await other.goto(`${appBase}/app/`);
  await app(other);
  await skipOnboarding(other);
  await addCustomConnection(other);
  await closeDialogs(other);
  await other.click('#btn-record');
  await other.waitFor(() => window.__scribe.store.getState().capture.state === 'error', { what: 'no-device error' });
  assert((await text(other, '#capture-error-message')).includes('No microphone was found'), 'no-device message');
  eq(await text(other, '#capture-error-title'), 'The microphone could not start', 'no-device title');
});

await scenario('long-upload', async (env) => {
  await resetMock();
  const wav = writeSpeechLikeWav(join(TMP, 'long-consultation.wav'), 21 * 60, 16000);
  const page = await env.page(`${appBase}/app/`, { allowNetwork: [mock.origin] });
  await app(page);
  await skipOnboarding(page);
  await addCustomConnection(page);
  await pickModel(page, 'note', 'mini', 'mock-note-mini');
  await pickModel(page, 'transcription', 'whisper-m', 'whisper-mock');
  await openSettings(page, 'defaults');
  await page.click('#pref-speakers'); // plain transcript, no labelling pass
  await page.type('#pref-vocab', 'levetiracetam, Tinel');
  await closeDialogs(page);
  await page.click('#capture-tab-upload');
  await page.setFile('#file-input', wav);
  await page.waitFor(() => !document.getElementById('upload-file').hidden, { what: 'file row' });
  await page.click('#btn-transcribe-file');
  const labels = new Set();
  const started = Date.now();
  while (Date.now() - started < 90000) {
    const s = await page.eval(() => ({ label: document.getElementById('proc-label').textContent, value: document.getElementById('proc-progress').getAttribute('aria-valuenow'), done: !document.getElementById('transcript').hidden, state: window.__scribe.store.getState().capture.state }));
    if (s.state === 'processing') labels.add(s.label);
    if (s.done) break;
    if (s.state === 'error') throw new Error('transcription failed');
    await sleep(40);
  }
  assert([...labels].some((l) => /Segment \d of 3/.test(l)), `segment progress shown (${[...labels].join(' | ')})`);
  const stats = await mockStats();
  eq(stats.transcriptions.length, 3, 'three segments uploaded');
  assert(stats.transcriptions.every((t) => t.bytes <= 25e6 && t.seconds <= 600.01), 'segments fit the upload limit');
  assert(stats.transcriptions.every((t) => t.prompt.includes('levetiracetam')), 'vocabulary hints sent to transcription');
  const transcriptText = await page.eval(() => [...document.querySelectorAll('#turns .turn__text')].map((t) => t.textContent).join(' '));
  assert((transcriptText.match(/lasted/g) || []).length === 3, 'all three parts in the transcript');
  assert(await page.eval(() => [...document.querySelectorAll('.turn__time')].some((t) => !t.hidden && /^(1[0-9]|2[0-1]):/.test(t.textContent))), 'timestamps shifted onto the full recording');

  // A failed segment can be retried without repeating the finished ones.
  await page.click('#btn-new-session');
  await page.waitFor(() => document.getElementById('confirm-dialog').open);
  await page.click('#confirm-ok');
  await pickModel(page, 'transcription', 'whisper-f', 'whisper-flaky');
  await closeDialogs(page);
  await page.click('#capture-tab-upload');
  await page.setFile('#file-input', wav);
  await page.waitFor(() => !document.getElementById('upload-file').hidden);
  await resetMock();
  await page.click('#btn-transcribe-file');
  await page.waitFor(() => window.__scribe.store.getState().capture.state === 'error', { what: 'segment failure', timeout: 90000 });
  const message = await text(page, '#capture-error-message');
  const done = Number(/The (\d+) finished segments are kept/.exec(message)?.[1]);
  assert(Number.isFinite(done), `failed-segment message (${message})`);
  const before = (await mockStats()).transcriptions.length;
  await page.click('#btn-capture-retry');
  await page.waitFor(() => !document.getElementById('transcript').hidden, { what: 'transcript after retry', timeout: 90000 });
  const after = (await mockStats()).transcriptions.length;
  eq(after - before, 3 - done, 'retry sends only the unfinished segments');
});

await scenario('history', async (env) => {
  const page = await env.page(`${appBase}/app/`, { allowNetwork: [mock.origin] });
  await app(page);
  await skipOnboarding(page);
  await page.click('#btn-history');
  await page.waitFor(() => document.getElementById('history-drawer').dataset.state === 'off', { what: 'history off by default' });
  await closeDialogs(page);
  await addCustomConnection(page, { remember: 'device' });
  await pickModel(page, 'note', 'mini', 'mock-note-mini');
  // Nothing is stored while history is off.
  await closeDialogs(page);
  await pasteTranscript(page);
  await generate(page);
  await sleep(900);
  eq(await page.eval(() => new Promise((r) => { const q = indexedDB.open('scribe-history'); q.onsuccess = () => { const db = q.result; if (!db.objectStoreNames.contains('sessions')) { r(0); return; } const c = db.transaction('sessions').objectStore('sessions').count(); c.onsuccess = () => r(c.result); }; q.onerror = () => r(-1); })), 0, 'no sessions saved while history is off');
  await openSettings(page, 'privacy');
  await page.click('#pref-history');
  await page.waitFor(() => document.getElementById('storage-sessions').textContent === '1', { what: 'session saved after opt-in' });
  await page.eval(() => { const s = document.getElementById('pref-autodelete'); s.value = '30'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await closeDialogs(page);
  await page.reload();
  await app(page);
  await page.press('h');
  await page.waitFor(() => document.getElementById('history-drawer').dataset.state === 'list', { what: 'history list after reload' });
  const rows = await page.eval(() => [...document.querySelectorAll('#history-list .history-item')].map((li) => li.querySelector('.history-item__title').textContent));
  eq(rows.length, 1, 'one saved session');
  assert(rows[0].startsWith('Reports:'), `title from the chief complaint (${rows[0]})`);
  assert((await text(page, '#history-retention')).includes('30 days'), 'retention text follows the setting');
  await page.type('#history-search', 'zzz-no-match');
  assert(await visible(page, '#history-nomatch'), 'search filters sessions');
  await page.type('#history-search', 'sore');
  await page.click('#history-list [data-action="open-session"]');
  await page.waitFor(() => window.__scribe.store.getState().noteState.state === 'ready' && document.querySelectorAll('#turns .turn').length === 5, { what: 'session reopened' });
  const record = await page.eval(() => new Promise((r) => { const q = indexedDB.open('scribe-history'); q.onsuccess = () => { const g = q.result.transaction('sessions').objectStore('sessions').getAll(); g.onsuccess = () => r(JSON.stringify(g.result)); }; }));
  assert(!record.includes('mock-key'), 'history never stores keys');
  await page.click('#btn-history');
  await page.waitFor(() => document.getElementById('history-drawer').open);
  await page.click('#btn-history-delete-all');
  await page.waitFor(() => document.getElementById('confirm-dialog').open);
  await page.click('#confirm-ok');
  await page.waitFor(() => document.getElementById('history-drawer').dataset.state === 'empty', { what: 'history emptied' });
  // Turning history off deletes nothing further and stops saving.
  await closeDialogs(page);
  await openSettings(page, 'privacy');
  await page.click('#pref-history');
  await page.waitFor(() => window.__scribe.store.getState().prefs.history === false);
  eq(await text(page, '#storage-sessions'), '0', 'no saved sessions');
  // Delete everything on this device.
  await page.click('#btn-delete-all');
  await page.waitFor(() => document.getElementById('confirm-dialog').open);
  await page.click('#confirm-ok');
  await page.waitFor(() => window.__scribe.store.getState().connections.length === 0, { what: 'everything deleted' });
  eq(await page.eval(() => Object.keys(localStorage).filter((k) => k.startsWith('scribe.')).length + Object.keys(sessionStorage).filter((k) => k.startsWith('scribe.')).length), 0, 'no scribe.* storage left');
});

await scenario('keys', async (env) => {
  const page = await env.page(`${appBase}/app/`, { allowNetwork: [mock.origin] });
  await app(page);
  await skipOnboarding(page);
  await addCustomConnection(page, { key: 'mock-key-TABONLY', name: 'Tab only', remember: 'session' });
  await addCustomConnection(page, { key: 'mock-key-REMEMBERED', name: 'Remembered', remember: 'device' });
  const storage = await page.eval(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), html: document.documentElement.outerHTML, url: location.href, keyInput: document.getElementById('conn-key').value }));
  assert(!storage.local.includes('TABONLY'), 'session key is not in localStorage');
  assert(storage.session.includes('TABONLY'), 'session key is in sessionStorage');
  assert(storage.local.includes('REMEMBERED'), 'remembered key is in localStorage');
  assert(!/mock-key-/.test(storage.html), 'keys never in the DOM');
  assert(!/mock-key-/.test(storage.url), 'keys never in the URL');
  eq(storage.keyInput, '', 'key field cleared after saving');
  const list = await page.eval(() => localStorage.getItem('scribe.connections'));
  assert(!/mock-key-/.test(list), 'connection list holds no keys');
  // Reload in the same tab: both keys still there.
  await page.reload();
  await app(page);
  eq(await page.eval(() => window.__scribe.store.getState().connections.map((c) => c.hasKey).join(',')), 'true,true', 'keys after reload in the same tab');
  // A new tab: the tab-only key is gone, the remembered one stays.
  const second = await env.page(`${appBase}/app/`, { contextId: page.contextId });
  await app(second);
  eq(await second.eval(() => window.__scribe.store.getState().connections.map((c) => `${c.name}:${c.hasKey}`).join(',')), 'Tab only:false,Remembered:true', 'new tab keeps only the remembered key');
  await openSettings(second, 'connections');
  assert((await second.eval(() => document.querySelector('#connections-list .conn-item__detail').textContent)).includes('key needed'), 'list says the tab-only key is needed');
  eq(await second.eval(() => document.querySelector('#connections-list').textContent.includes('mock-key')), false, 'list never shows keys');
});

await scenario('errors', async (env) => {
  await resetMock();
  const page = await env.page(`${appBase}/app/`, { allowNetwork: [mock.origin, 'http://127.0.0.1:9/'] });
  await app(page);
  await skipOnboarding(page);
  // 401 on test: a specific message, never the provider's body.
  const bad = await addCustomConnection(page, { key: 'wrong-key', expectOk: false });
  eq(bad.state, 'error', '401 test state');
  assert(bad.message.includes('rejected the API key'), `auth message (${bad.message})`);
  assert(!bad.message.includes('secret-should-never-be-shown'), 'provider error body is never shown');
  // A base URL without /v1: the model list is not found there.
  await page.type('#conn-base-url', mock.origin);
  await page.type('#conn-key', 'mock-key-x');
  await page.click('#btn-test-connection');
  await page.waitFor(() => document.getElementById('conn-test-result').dataset.state === 'error');
  assert((await text(page, '#conn-test-message')).includes('/v1'), 'wrong base URL guidance');
  // Network failure on a custom endpoint: CORS guidance with this origin.
  await page.type('#conn-base-url', 'http://127.0.0.1:9/v1');
  await page.type('#conn-key', 'mock-key-x');
  await page.click('#btn-test-connection');
  await page.waitFor(() => document.getElementById('conn-test-result').dataset.state === 'error', { what: 'network failure' });
  const net = await text(page, '#conn-test-message');
  assert(net.includes('CORS') && net.includes(appBase), `CORS guidance for custom endpoints (${net})`);
  // Local preset: Ollama / LM Studio instructions.
  await page.click('input[name="conn-preset"][value="local"]');
  await page.type('#conn-base-url', 'http://127.0.0.1:9/v1');
  await page.click('#btn-test-connection');
  await page.waitFor(() => document.getElementById('conn-test-result').dataset.state === 'error');
  const local = await text(page, '#conn-test-message');
  assert(local.includes(`OLLAMA_ORIGINS=${appBase}`) && local.includes('LM Studio'), `local CORS guidance (${local})`);
  // Deepgram keys cannot be checked from the browser: say so instead of failing.
  await page.click('input[name="conn-preset"][value="deepgram"]');
  await page.type('#conn-key', 'dg-key');
  await page.click('#btn-test-connection');
  await page.waitFor(() => document.getElementById('conn-test-message').textContent.includes('checked on the first transcription'), { what: 'Deepgram notice' });
  eq(await page.eval(() => document.getElementById('conn-test-result').dataset.state), 'idle', 'Deepgram test is neither ok nor failed');
  await page.click('#btn-conn-cancel');
  await addCustomConnection(page);
  await closeDialogs(page);
  await pasteTranscript(page);

  // 429 with Retry-After.
  await pickModel(page, 'note', 'ratelimit', 'mock-ratelimit');
  await closeDialogs(page);
  await generate(page, { expect: 'error' });
  const limited = await text(page, '#note-error-message');
  assert(limited.includes('about 7 seconds'), `rate limit message (${limited})`);
  // Malformed model output is never shown as a note.
  await pickModel(page, 'note', 'malformed', 'mock-malformed');
  await closeDialogs(page);
  await page.click('#btn-generate-retry');
  await page.waitFor(() => window.__scribe.store.getState().noteState.state === 'error' && document.getElementById('note-error-message').textContent.includes('not a complete, valid note'), { what: 'invalid output message', timeout: 20000 });
  eq(await page.eval(() => document.querySelectorAll('#note-sheet .statement').length), 0, 'no statements from malformed output');
  // Cancel mid-stream.
  await pickModel(page, 'note', 'slow', 'mock-slow');
  await closeDialogs(page);
  await page.click('#btn-generate-retry');
  await page.waitFor(() => document.querySelectorAll('#note-stream .statement').length > 0, { what: 'slow stream started', timeout: 20000 });
  // Double-clicking Generate while it runs does not start a second request.
  await page.eval(() => { document.getElementById('btn-generate').click(); document.getElementById('btn-generate').click(); });
  await page.click('#btn-cancel-generate');
  await page.waitFor(() => window.__scribe.store.getState().noteState.state === 'empty', { what: 'cancelled back to empty' });
  await page.waitFor(() => [...document.querySelectorAll('.toast__message')].some((t) => t.textContent === 'Cancelled.'), { what: 'cancel toast' });
  const stats = await mockStats();
  eq(stats.chat.filter((c) => c.model === 'mock-slow').length, 1, 'one slow request despite double clicks');
  await sleep(300);
  assert((await mockStats()).aborted >= 1, 'the provider saw the stream aborted');
  // A good model still works after the errors.
  await pickModel(page, 'note', 'mini', 'mock-note-mini');
  await closeDialogs(page);
  await generate(page);
});

await scenario('static-host', async (env) => {
  const page = await env.page(`${staticBase}/app/`, { allowNetwork: [`${staticBase}/api/config`] });
  await app(page);
  await page.waitFor(() => document.getElementById('onboarding-dialog').open, { what: 'BYOK onboarding without an API' });
  eq((await state(page)).mode, 'byok', 'browser-direct mode without /api');
  await page.click('#ob-skip');
  eq(await page.eval(() => document.querySelectorAll('.toast[data-tone="error"]').length), 0, 'no error about the missing API');
  await page.click('#btn-empty-example');
  await page.waitFor(() => window.__scribe.store.getState().noteState.state === 'ready');
});

await scenario('server-mode', async (env) => {
  await resetMock();
  const page = await env.page(`${serverBase}/app/`, { allowNetwork: [`${serverBase}/api/label-speakers`] });
  await app(page);
  eq((await state(page)).mode, 'server', 'server mode detected');
  eq(await page.eval(() => document.getElementById('onboarding-dialog').open), false, 'no BYOK onboarding in server mode');
  eq(await page.eval(() => document.getElementById('connection-chip').dataset.state), 'server', 'server chip');
  await page.waitFor(() => [...document.querySelectorAll('.toast__message')].some((t) => t.textContent.includes('access token')), { what: 'access token prompt' });
  await openSettings(page, 'access');
  await page.type('#access-token', 'wrong-token');
  await page.click('#btn-access-save');
  await page.waitFor(() => document.getElementById('access-test-result').dataset.state === 'error');
  await page.type('#access-token', 'e2e-access-token');
  await page.click('#btn-access-save');
  await page.waitFor(() => document.getElementById('access-test-result').dataset.state === 'ok');
  eq(await page.eval(() => document.getElementById('access-token').value), '', 'token field cleared');
  await closeDialogs(page);
  await pasteTranscript(page);
  await generate(page);
  const provenance = await text(page, '#note-provenance');
  assert(provenance.includes('mock-note-mini'), `server default model used (${provenance})`);
  eq((await mockStats()).chat.at(-1).stream, false, 'server mode does not stream');
});

await scenario('phone', async (env) => {
  const page = await env.page(`${appBase}/app/?example=1`, { width: 390, height: 844, mobile: true });
  await app(page);
  await page.waitFor(() => window.__scribe.store.getState().noteState.state === 'ready');
  const overflow = await page.eval(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, `no horizontal scroll on a phone (${overflow}px)`);
  eq(await page.eval(() => document.getElementById('workspace').dataset.pane), 'source', 'source pane first');
  await page.click('#pane-tab-note');
  await page.waitFor(() => document.getElementById('workspace').dataset.pane === 'note');
  assert(await visible(page, '#note-sheet'), 'draft visible on the note pane');
  await page.click('[data-statements="objective"] button.ev-chip');
  await page.waitFor(() => document.getElementById('workspace').dataset.pane === 'source', { what: 'chip switches to the transcript on phones' });
  await page.waitFor(() => document.querySelector('.toast__action'), { what: 'back-to-draft toast' });
  await page.click('.toast__action');
  await page.waitFor(() => document.getElementById('workspace').dataset.pane === 'note');
  await page.click('#btn-settings');
  const dialog = await page.eval(() => { const r = document.getElementById('settings-dialog').getBoundingClientRect(); return { left: r.left, right: r.right }; });
  assert(dialog.left >= 0 && dialog.right <= 390, `settings fit the phone (${JSON.stringify(dialog)})`);
  eq(await page.eval(() => document.documentElement.scrollWidth - window.innerWidth <= 0), true, 'still no horizontal scroll with settings open');
  await closeDialogs(page);
  await page.click('[data-set-lang="id"]').catch(async () => page.eval(() => document.querySelector('input[name="ui-lang"][value="id"]').click()));
  await page.waitFor(() => document.documentElement.lang === 'id', { what: 'Indonesian interface' });
  for (const pane of ['note', 'source']) {
    await page.eval((p) => document.querySelector(`[data-pane-target="${p}"]`).click(), pane);
    eq(await page.eval(() => document.documentElement.scrollWidth - window.innerWidth <= 0), true, `no horizontal scroll in Indonesian (${pane})`);
  }
});

// ---------- Screenshots (optional) ----------
if (SHOTS) await scenario('screenshots', async (env) => {
  mkdirSync(SHOTS, { recursive: true });
  for (const [label, width, height, mobile] of [['desktop', 1440, 900, false], ['phone', 390, 844, true]]) {
    for (const scheme of ['light', 'dark']) {
      const shot = async (page, name) => page.screenshot(join(SHOTS, `${name}-${label}-${scheme}.png`));
      const prep = async (page) => page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      const landing = await env.page('about:blank', { width, height, mobile, allowNetwork: [mock.origin] });
      await prep(landing);
      await landing.goto(`${appBase}/`);
      await sleep(400);
      await shot(landing, '1-landing');
      await landing.goto(`${appBase}/app/`);
      await app(landing);
      await landing.waitFor(() => document.getElementById('onboarding-dialog').open);
      await sleep(300);
      await shot(landing, '2-onboarding');
      await landing.click('#ob-skip');
      await addCustomConnection(landing);
      await pickModel(landing, 'note', 'mini', 'mock-note-mini');
      await pickModel(landing, 'transcription', 'whisper-m', 'whisper-mock');
      await openSettings(landing, 'connections');
      await sleep(250);
      await shot(landing, '3-settings-connections');
      await openSettings(landing, 'privacy');
      await landing.click('#pref-history');
      await closeDialogs(landing);
      await landing.click('#btn-record');
      await landing.waitFor(() => window.__scribe.store.getState().capture.state === 'recording');
      await sleep(1600);
      await shot(landing, '4-recording');
      await landing.click('#btn-discard');
      await landing.waitFor(() => document.getElementById('confirm-dialog').open);
      await landing.click('#confirm-ok');
      await pasteTranscript(landing);
      await generate(landing);
      await sleep(900);
      if (mobile) {
        await landing.click('#pane-tab-note');
        await landing.focus('[data-statements="subjective"] .statement:first-child .statement__text');
        await sleep(200);
        await shot(landing, '5-note-evidence');
        await landing.click('[data-statements="subjective"] .statement:first-child button.ev-chip');
        await sleep(500);
        await shot(landing, '5b-transcript-evidence');
        await landing.click('#pane-tab-note');
      } else {
        await landing.focus('[data-statements="subjective"] .statement:first-child .statement__text');
        await sleep(200);
        await shot(landing, '5-note-evidence');
      }
      await landing.eval(() => document.activeElement?.blur());
      await landing.click('#btn-export');
      await sleep(200);
      await shot(landing, '6-export-menu');
      await landing.eval(() => document.body.click());
      await landing.press('Escape');
      await landing.click('#btn-history');
      await landing.waitFor(() => document.getElementById('history-drawer').dataset.state === 'list', { timeout: 10000 });
      await sleep(400);
      await shot(landing, '7-history');
      await landing.close();
    }
  }
});

// ---------- Report ----------
await browser.close();
await Promise.all([appServer, serverModeServer, staticServer].map((server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); })));
await mock.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} scenarios passed.`);
if (!failed.length) rmSync(TMP, { recursive: true, force: true });
else console.log(`Artifacts kept in ${TMP}`);
process.exit(failed.length ? 1 : 0);
