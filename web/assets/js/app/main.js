// Application entry. Loaded after app-ui.js (the presentational shell) and wires every screen to
// the engine through one store. See web/app/UI-CONTRACT.md for the DOM contract.
import * as core from '../../../core/index.js';
import { t, getLang, onLangChange } from '../i18n.js';
import { confirmDialog, toast, openDialog } from '../ui.js';
import { createStore, reducer, initialState } from './store.js';
import { safeStorage } from './storage.js';
import { createVault } from './connections.js';
import { sanitizePrefs, PREFS_KEY } from './prefs.js';
import { resolveSelection, targetsFor, ROLES } from './selection.js';
import { createIdbHistory } from './history.js';
import { createServices } from './services.js';
import { exampleData } from './example.js';
import { fromEngineNote } from './note.js';
import { buildSource } from './transcript.js';
import { initConnections } from './view-connections.js';
import { initModels, targetLabel } from './view-models.js';
import { initPreferences, ACCESS_KEY } from './view-preferences.js';
import { initHistory } from './view-history.js';
import { initCapture } from './view-capture.js';
import { initTranscript } from './view-transcript.js';
import { initNote } from './view-note.js';
import { initExport } from './view-export.js';
import { initOnboarding } from './view-onboarding.js';

const $ = (sel, root = document) => root.querySelector(sel);
const params = new URLSearchParams(location.search);

/** Features the workspace cannot run without. Recording and history degrade separately. */
function missingFeatures() {
  const missing = [];
  if (typeof HTMLDialogElement !== 'function') missing.push('<dialog>');
  if (typeof fetch !== 'function' || typeof AbortController !== 'function') missing.push('fetch');
  if (typeof ReadableStream !== 'function' || typeof TextDecoder !== 'function') missing.push('streams');
  if (typeof Blob !== 'function' || typeof FormData !== 'function') missing.push('FormData');
  return missing;
}

async function detectServer(store) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    // Static hosting has no /api: a 404 or an HTML page simply means browser-direct mode.
    const response = await fetch('/api/config', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!response.ok || !/json/.test(response.headers.get('content-type') || '')) return;
    const config = await response.json();
    const offers = config?.mode === 'server' && ((Array.isArray(config.providers) && config.providers.some((p) => p?.configured)) || config.transcription?.configured);
    if (offers) store.dispatch({ type: 'mode/server', config });
  } catch {
    /* no server API: browser-direct mode */
  } finally {
    clearTimeout(timer);
  }
}

function boot({ demoUnavailable = false } = {}) {
  // The design-review harness owns the page; if it is not there (production build), start normally.
  // app-ui.js may have found it missing before this module ran, so check the marker too.
  if (params.has('demo') && !demoUnavailable && document.documentElement.dataset.demoHarness !== 'missing') {
    document.addEventListener('ui:demo-unavailable', () => boot({ demoUnavailable: true }), { once: true });
    return;
  }
  const missing = missingFeatures();
  if (missing.length) {
    $('#unsupported').hidden = false;
    $('#unsupported-detail').textContent = t('app.unsupported.missing', { features: missing.join(', ') });
    $('.app-header').hidden = true;
    $('#workspace').hidden = true;
    return;
  }

  const local = safeStorage(() => window.localStorage);
  const session = safeStorage(() => window.sessionStorage);
  const vault = createVault({ local, session });
  const history = createIdbHistory(typeof indexedDB === 'undefined' ? null : indexedDB);
  const store = createStore(reducer, initialState({
    prefs: sanitizePrefs(local.getJSON(PREFS_KEY), getLang()),
    connections: vault.list(),
    accessToken: session.get(ACCESS_KEY) || '',
    historyAvailable: history.available,
  }));
  const ctx = { store, vault, local, session, history, params };
  ctx.services = createServices({ store, vault });
  // End-to-end test hook. Only `npm run test:e2e` serves pages with this meta tag (dev-server.js
  // `testHooks`); normal sessions and the published site never expose the store.
  if (document.querySelector('meta[name="scribe-test-hooks"]')) window.__scribe = { store };

  // Preferences persist (they never contain encounter content or keys).
  store.subscribe((state, previous) => { if (state.prefs !== previous.prefs) local.setJSON(PREFS_KEY, state.prefs); });

  // Keep the transcription and note selections valid as connections come and go.
  const resolveSelections = () => {
    const state = store.getState();
    for (const role of ROLES) {
      const next = resolveSelection(role, state.prefs.selection[role], state.connections, state.server);
      const current = state.prefs.selection[role];
      if (next.connectionId !== current.connectionId || next.model !== current.model) store.dispatch({ type: 'selection/set', role, ...next });
    }
  };
  store.subscribe((state, previous) => { if (state.connections !== previous.connections || state.server !== previous.server) resolveSelections(); });
  resolveSelections();

  // Custom and local endpoints have no suggested model IDs: once connected, start with the first
  // model the endpoint lists for each role, so the user is not left with an empty selection.
  ctx.autoPickModels = async (connectionId) => {
    for (const role of ROLES) {
      const { selection } = store.getState().prefs;
      if (selection[role].connectionId !== connectionId || selection[role].model) continue;
      try {
        const { models } = await ctx.services.listModels(connectionId, role);
        const current = store.getState().prefs.selection[role];
        if (models[0] && current.connectionId === connectionId && !current.model) store.dispatch({ type: 'selection/set', role, connectionId, model: models[0].id });
      } catch { /* the Models tab explains listing failures */ }
    }
  };

  // ---- Views ----
  ctx.historyView = initHistory(ctx);
  initModels(ctx);
  initConnections(ctx);
  initPreferences(ctx);
  const capture = initCapture(ctx);
  const transcript = initTranscript(ctx);
  const note = initNote(ctx);
  initExport(ctx);
  ctx.cancelAll = () => { capture.cancel(); transcript.cancel(); note.cancel(); };

  // ---- Fictional example (no key, no network) ----
  ctx.loadExample = async ({ confirm = true } = {}) => {
    const state = store.getState();
    if (confirm && (state.session.turns.length || state.session.note) && !state.session.fictional) {
      const ok = await confirmDialog({ title: t('app.confirm.newSession.title'), message: t('app.confirm.newSession.message'), confirmLabel: t('app.confirm.newSession.ok') });
      if (!ok) return;
    }
    ctx.cancelAll();
    const data = exampleData(getLang());
    store.dispatch({
      type: 'session/load',
      session: {
        fictional: true, source: 'example', createdAt: new Date().toISOString(), durationSec: data.durationSec, turns: data.turns, labels: 'source',
        note: fromEngineNote(data.note), meta: data.meta, template: data.meta.template, language: data.meta.language,
      },
    });
    toast(t('app.toast.exampleLoaded'), { tone: 'success' });
  };
  for (const id of ['btn-load-example', 'btn-empty-example']) $(`#${id}`).addEventListener('click', () => ctx.loadExample());

  // The example follows the interface language while it is untouched.
  onLangChange((lang) => {
    const { session: s } = store.getState();
    if (!s.fictional || s.edited || !s.meta || s.meta.language === lang) return;
    const before = exampleData(s.meta.language);
    if (core.hashText(buildSource(s.turns, { speakers: s.speakersOn }).text.trim()) !== before.meta.transcriptHash) return;
    ctx.loadExample({ confirm: false });
  });

  $('#btn-new-session').addEventListener('click', async () => {
    const state = store.getState();
    const saved = state.prefs.history && state.session.id;
    if (!state.session.fictional && !saved) {
      const ok = await confirmDialog({ title: t('app.confirm.newSession.title'), message: t('app.confirm.newSession.message'), confirmLabel: t('app.confirm.newSession.ok') });
      if (!ok) return;
    }
    ctx.cancelAll();
    store.dispatch({ type: 'session/new' });
    setTimeout(() => $('#capture [role="tab"][aria-selected="true"]')?.focus(), 0);
  });

  // ---- Connection chip ----
  const renderChip = () => {
    const state = store.getState();
    const chip = $('#connection-chip');
    const label = $('#connection-chip-label');
    const { connectionId } = state.prefs.selection.note;
    const target = targetsFor('note', state.connections, state.server).find((item) => item.id === connectionId)
      || targetsFor('transcription', state.connections, state.server).find((item) => item.id === state.prefs.selection.transcription.connectionId);
    let chipState = 'none';
    let text = t('app.conn.none');
    if (state.session.fictional && !target) { chipState = 'example'; text = t('app.conn.example'); }
    else if (target?.kind === 'server') { chipState = 'server'; text = t('app.conn.server'); }
    else if (target) {
      const status = state.connectionStatus[target.id];
      chipState = !target.usable || status === 'error' ? 'error' : 'ok';
      text = chipState === 'error' ? t(target.usable ? 'app.conn.errorNamed' : 'app.conn.needsKey', { name: targetLabel(target) }) : t('app.conn.connected', { name: targetLabel(target) });
    }
    chip.dataset.state = chipState;
    label.textContent = text;
  };
  store.subscribe((state, previous) => {
    if (state.connections !== previous.connections || state.connectionStatus !== previous.connectionStatus || state.prefs.selection !== previous.prefs.selection || state.server !== previous.server || state.session.fictional !== previous.session.fictional) renderChip();
  });
  onLangChange(renderChip);
  renderChip();

  // ---- Unsupported optional features ----
  // Auto-delete expired sessions as soon as the store opens, before any count is shown (counts
  // wait for this first purge), then periodically while the app stays open.
  if (!history.available) {
    store.dispatch({ type: 'history/available', available: false });
    ctx.historyView.skip();
  } else {
    history.open().then(() => ctx.historyView.start(), () => {
      store.dispatch({ type: 'history/available', available: false });
      ctx.historyView.skip();
    });
  }

  // ---- Start: server mode, then first run or ?example=1 ----
  const onboarding = initOnboarding(ctx);
  (async () => {
    await detectServer(store);
    const state = store.getState();
    if (params.get('example') === '1') await ctx.loadExample({ confirm: false });
    else if (!state.prefs.onboarded && !state.connections.length && state.mode !== 'server') onboarding.open();
    else if (state.mode === 'server' && state.server.access_token_required && !state.accessToken) {
      toast(t('app.access.needed'), { duration: 0, action: { label: t('app.access.enter'), onClick: () => { openDialog('settings-dialog'); document.getElementById('set-tab-access')?.click(); } } });
    }
    document.documentElement.dataset.app = 'ready';
  })();
}

boot();
