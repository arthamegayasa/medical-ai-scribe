// Settings > Note defaults, Privacy and storage, Workspace access.
import { t, onLangChange, setLang } from '../i18n.js';
import { setTheme } from '../theme.js';
import { confirmDialog, toast } from '../ui.js';
import { TEMPLATE_KEYS, noteLanguageOptions } from './format.js';
import { describeError } from './messages.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const ACCESS_KEY = 'scribe.accessToken';

export function initPreferences(ctx) {
  const { store, local, session, vault } = ctx;

  // ---- Note defaults (kept in sync with the quick selects next to "Write SOAP draft") ----
  function renderTemplateOptions() {
    for (const select of $$('select[data-template-select]')) {
      const value = store.getState().prefs.template;
      select.replaceChildren(...Object.entries(TEMPLATE_KEYS).map(([id, key]) => {
        const option = new Option(t(key), id, false, id === value);
        option.dataset.i18n = key;
        return option;
      }));
      select.value = value;
    }
  }
  // Every engine note language (prefs.js NOTE_LANGUAGES); the markup carries no second list.
  function renderNoteLanguageOptions() {
    for (const select of $$('select[data-note-language-select]')) {
      const value = store.getState().prefs.noteLanguage;
      select.replaceChildren(...noteLanguageOptions().map(({ value: code, key }) => {
        const option = new Option(t(key), code, false, code === value);
        option.dataset.i18n = key;
        return option;
      }));
      select.value = value;
    }
  }
  function syncDefaults() {
    const { prefs } = store.getState();
    $$('select[data-template-select]').forEach((select) => { if (select.value !== prefs.template) select.value = prefs.template; });
    $$('select[data-note-language-select]').forEach((select) => { if (select.value !== prefs.noteLanguage) select.value = prefs.noteLanguage; });
    $('#pref-speakers').checked = prefs.speakers;
    if (document.activeElement !== $('#pref-vocab')) $('#pref-vocab').value = prefs.vocabulary;
  }
  document.addEventListener('change', (event) => {
    if (event.target.matches('select[data-template-select]')) store.dispatch({ type: 'prefs/set', patch: { template: event.target.value } });
    if (event.target.matches('select[data-note-language-select]')) store.dispatch({ type: 'prefs/set', patch: { noteLanguage: event.target.value } });
  });
  $('#pref-speakers').addEventListener('change', (event) => store.dispatch({ type: 'prefs/set', patch: { speakers: event.target.checked } }));
  $('#pref-vocab').addEventListener('input', (event) => store.dispatch({ type: 'prefs/set', patch: { vocabulary: event.target.value } }));

  // ---- Privacy and storage ----
  const historyToggle = $('#pref-history');
  async function refreshStorageSummary() {
    const count = store.getState().historyAvailable ? await ctx.historyView.count() : 0;
    $('#storage-sessions').textContent = String(count);
    $('#storage-keys').textContent = String(vault.rememberedCount());
  }
  ctx.refreshStorageSummary = refreshStorageSummary;

  function syncPrivacy() {
    const { prefs, historyAvailable } = store.getState();
    historyToggle.checked = prefs.history && historyAvailable;
    historyToggle.disabled = !historyAvailable;
    $('#pref-history-unavailable').hidden = historyAvailable;
    $('#pref-autodelete').value = String(prefs.autoDeleteDays);
    $('#pref-autodelete').disabled = !prefs.history;
    $('#pref-autodelete-field').setAttribute('aria-disabled', String(!prefs.history));
    $('#storage-blocked').hidden = local.persistent;
  }

  historyToggle.addEventListener('change', async () => {
    if (historyToggle.checked) {
      store.dispatch({ type: 'prefs/set', patch: { history: true } });
      await ctx.historyView.saveNow();
      refreshStorageSummary();
      return;
    }
    const count = await ctx.historyView.count();
    if (count > 0) {
      const ok = await confirmDialog({ title: t('app.confirm.historyOff.title'), message: t('app.confirm.historyOff.message', { n: count }), confirmLabel: t('app.confirm.historyOff.ok'), tone: 'danger' });
      if (!ok) { historyToggle.checked = true; return; }
      await ctx.historyView.deleteAll({ confirm: false });
    }
    store.dispatch({ type: 'prefs/set', patch: { history: false } });
    refreshStorageSummary();
  });
  $('#pref-autodelete').addEventListener('change', async (event) => {
    store.dispatch({ type: 'prefs/set', patch: { autoDeleteDays: Number(event.target.value) } });
    await ctx.historyView.refresh();
    refreshStorageSummary();
  });

  $('#btn-delete-all').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: t('app.confirm.deleteAll.title'), message: t('app.confirm.deleteAll.message'), confirmLabel: t('app.confirm.deleteAll.ok'), tone: 'danger' });
    if (!ok) return;
    ctx.cancelAll?.();
    // A scheduled or running save must not recreate the database after it is destroyed.
    await ctx.historyView.settle().catch(() => {});
    try { await ctx.history.destroy?.(); } catch { /* nothing stored */ }
    vault.clearAll();
    for (const store_ of [local, session]) for (const key of store_.keys('scribe.')) store_.remove(key);
    ctx.modelCache?.clear();
    store.dispatch({ type: 'reset/all' });
    store.dispatch({ type: 'connections/set', connections: vault.list() });
    setTheme('system');
    const nav = (navigator.languages || [navigator.language || 'en']).map((l) => String(l).toLowerCase());
    setLang(nav.some((l) => l === 'id' || l.startsWith('id-')) ? 'id' : 'en');
    for (const key of local.keys('scribe.')) local.remove(key); // setLang/setTheme may have written again
    refreshStorageSummary();
    toast(t('app.toast.deletedAll'), { tone: 'success' });
  });

  // ---- Workspace access (server mode with an access token) ----
  async function checkToken() {
    const input = $('#access-token');
    const result = $('#access-test-result');
    const message = $('#access-test-message');
    const token = input.value.trim();
    result.dataset.state = 'testing';
    message.textContent = t('app.access.checking');
    try {
      // A request that passes the token check but stops before any provider call.
      const response = await fetch('/api/label-speakers', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
      if (response.status === 401) throw Object.assign(new Error('denied'), { code: 'access_denied' });
      if (response.status === 503) throw Object.assign(new Error('config'), { code: 'server_not_configured' });
      session.set(ACCESS_KEY, token);
      store.dispatch({ type: 'access/token', token });
      result.dataset.state = 'ok';
      message.textContent = t('app.access.ok');
    } catch (error) {
      result.dataset.state = 'error';
      const { key, vars } = describeError(error?.code ? error : { code: 'network' }, { origin: location.origin });
      message.textContent = t(key, vars);
    }
    input.value = '';
  }
  $('#btn-access-save').addEventListener('click', checkToken);
  $('#set-access').addEventListener('submit', (event) => { event.preventDefault(); checkToken(); });

  function syncAccess() {
    const { server } = store.getState();
    const needed = Boolean(server?.access_token_required);
    $('#set-tab-access').hidden = !needed;
  }

  store.subscribe((state, previous) => {
    if (state.prefs !== previous.prefs) { syncDefaults(); syncPrivacy(); }
    if (state.historyAvailable !== previous.historyAvailable) syncPrivacy();
    if (state.server !== previous.server) syncAccess();
    if (state.connections !== previous.connections) refreshStorageSummary();
  });
  document.getElementById('settings-dialog').addEventListener('ui:opened', refreshStorageSummary);
  onLangChange(() => { renderTemplateOptions(); renderNoteLanguageOptions(); syncDefaults(); });
  renderTemplateOptions();
  renderNoteLanguageOptions();
  syncDefaults();
  syncPrivacy();
  syncAccess();
}
