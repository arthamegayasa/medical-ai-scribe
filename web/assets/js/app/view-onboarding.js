// First-run guide: connect a provider (with a real key test), choose the two models, start.
import * as core from '../../../core/index.js';
import { t, onLangChange } from '../i18n.js';
import { openDialog, closeDialog } from '../ui.js';
import { setOnboardingStep, setCaptureMethod } from '../app-ui.js';
import { newConnectionId } from './connections.js';
import { purposeFor } from './selection.js';
import { testFailMessage, isLoopback } from './view-connections.js';

const $ = (sel, root = document) => root.querySelector(sel);

export function initOnboarding(ctx) {
  const { store, vault } = ctx;
  const dialog = $('#onboarding-dialog');
  const key = $('#ob-key');
  const base = $('#ob-base-url');
  let tested = null;      // { provider, ok, models }
  let savedId = null;
  let controller = null;
  let run = 0;

  const preset = () => core.getProvider(dialog.querySelector('input[name="ob-preset"]:checked')?.value || 'openai');

  function setTest(state, message = '') {
    $('#ob-test-result').dataset.state = state;
    $('#ob-test-message').textContent = message;
  }

  function syncPreset() {
    const p = preset();
    const showKey = p.keyRequired || p.id === 'custom';
    $('#ob-key-field').hidden = !showKey;
    $('#ob-base-url-field').hidden = !p.customBaseUrl;
    const link = $('#ob-key-link');
    link.hidden = !p.keyUrl;
    if (p.keyUrl) link.href = p.keyUrl;
    $('#ob-key-hint').hidden = !p.keyUrl;
    $('#ob-privacy').textContent = t(p.id === 'local' || (p.id === 'custom' && isLoopback(base.value)) ? 'app.conn.privacyLocal' : 'app.conn.privacyCloud');
  }

  function connection() {
    const p = preset();
    const value = { provider: p.id };
    if (key.value.trim()) value.apiKey = key.value.trim();
    if (p.customBaseUrl) value.baseUrl = base.value.trim();
    return value;
  }

  async function test() {
    const p = preset();
    const conn = connection();
    if (p.customBaseUrl) {
      try { core.validateBaseUrl(conn.baseUrl || ''); } catch { setTest('error', t('app.conn.urlInvalid')); base.focus(); return; }
    }
    if (p.keyRequired && !conn.apiKey) { setTest('error', t('app.conn.keyRequired')); key.focus(); return; }
    controller?.abort();
    controller = new AbortController();
    const mine = ++run;
    setTest('testing', t('app.conn.testing'));
    try {
      const { models } = await core.testConnection(conn, { purpose: null, signal: controller.signal });
      if (mine !== run) return;
      tested = { provider: p.id, ok: true, models };
      setTest('ok', models.length ? t('app.conn.testOk', { n: models.length }) : t('app.conn.testOkNoList'));
    } catch (error) {
      if (mine !== run || error?.code === 'aborted') return;
      if (error?.code === 'unsupported') {
        tested = { provider: p.id, ok: true, models: [] };
        setTest('ok', t('app.conn.testUnavailable', { provider: p.label }));
        return;
      }
      tested = { provider: p.id, ok: false };
      setTest('error', t('app.conn.testFail', { reason: testFailMessage(error, p) }));
    }
  }

  function saveConnection() {
    const p = preset();
    const conn = connection();
    const id = savedId || newConnectionId();
    vault.save({ id, provider: p.id, name: p.label, baseUrl: conn.baseUrl ? core.validateBaseUrl(conn.baseUrl) : '', remember: 'session' }, conn.apiKey || '');
    savedId = id;
    key.value = '';
    store.dispatch({ type: 'connections/set', connections: vault.list() });
    store.dispatch({ type: 'connection/status', id, status: tested?.ok && tested.models.length ? 'ok' : 'untested' });
    ctx.modelCache?.clear();
    return id;
  }

  async function fillModels(id) {
    const p = preset();
    for (const role of ['transcription', 'note']) {
      const select = $(role === 'note' ? '#ob-model-note' : '#ob-model-transcription');
      const capable = role === 'note' ? p.capabilities.chat : p.capabilities.transcription;
      if (!capable) {
        select.replaceChildren(new Option(t(role === 'note' ? 'app.ob.noNoteModel' : 'app.ob.noTranscription'), ''));
        select.disabled = true;
        continue;
      }
      select.disabled = false;
      select.replaceChildren(new Option(t('app.models.loading'), ''));
      let models = [];
      try { models = (await ctx.services.listModels(id, role)).models; } catch { models = []; }
      if (!models.length) models = core.suggestedModels(p.id, purposeFor(role)).map((m) => ({ id: m, label: m }));
      const preferred = role === 'note' ? (p.defaultChatModel && models.some((m) => m.id === p.defaultChatModel) ? p.defaultChatModel : models[0]?.id) : models[0]?.id;
      select.replaceChildren(...models.map((m) => new Option(m.id, m.id, false, m.id === preferred)));
      if (!models.length) select.append(new Option(t('app.ob.typeLater'), ''));
    }
  }

  dialog.addEventListener('change', (event) => {
    if (event.target.name === 'ob-preset') { tested = null; base.value = preset().baseUrl || ''; setTest('idle'); syncPreset(); }
  });
  dialog.addEventListener('input', (event) => {
    if (event.target === key || event.target === base) { tested = null; setTest('idle'); if (event.target === base) syncPreset(); }
  });
  $('#ob-btn-test').addEventListener('click', test);
  $('#ob-connect-form').addEventListener('submit', (event) => { event.preventDefault(); test(); });

  dialog.addEventListener('ui:onboarding-step', (event) => {
    const { from, to } = event.detail;
    if (from === 1 && to === 2) {
      if (!tested?.ok || tested.provider !== preset().id) {
        event.preventDefault();
        setTest(tested?.ok === false ? 'error' : 'idle', tested?.ok === false ? $('#ob-test-message').textContent : t('app.ob.testFirst'));
        $('#ob-btn-test').focus();
        return;
      }
      const id = saveConnection();
      fillModels(id);
    }
    if (from === 2 && to === 3 && savedId) {
      const transcription = $('#ob-model-transcription').value;
      const note = $('#ob-model-note').value;
      const p = preset();
      if (p.capabilities.transcription) store.dispatch({ type: 'selection/set', role: 'transcription', connectionId: savedId, model: transcription });
      if (p.capabilities.chat) store.dispatch({ type: 'selection/set', role: 'note', connectionId: savedId, model: note });
    }
  });

  $('#ob-choose-example').addEventListener('click', () => ctx.loadExample());
  $('#ob-choose-capture').addEventListener('click', () => {
    setCaptureMethod(store.getState().capture.method);
    setTimeout(() => $('#capture [role="tab"][aria-selected="true"]')?.focus(), 0);
  });
  dialog.addEventListener('close', () => {
    controller?.abort();
    key.value = '';
    if (!store.getState().prefs.onboarded) store.dispatch({ type: 'prefs/set', patch: { onboarded: true } });
  });
  dialog.addEventListener('ui:opened', () => {
    tested = null;
    savedId = null;
    setOnboardingStep(1);
    setTest('idle');
    syncPreset();
  });
  onLangChange(syncPreset);
  syncPreset();

  return { open: () => openDialog(dialog), close: () => closeDialog(dialog) };
}
