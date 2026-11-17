// Settings > Connections: list, add, edit, test and remove provider connections.
import * as core from '../../../core/index.js';
import { t } from '../i18n.js';
import { cloneTemplate, confirmDialog, toast } from '../ui.js';
import { showConnectionView } from '../app-ui.js';
import { applyI18n, onLangChange } from '../i18n.js';
import { describeRecord, newConnectionId } from './connections.js';
import { describeError } from './messages.js';

const $ = (sel, root = document) => root.querySelector(sel);

/** True when a base URL points at this machine (privacy note says "local"). */
export function isLoopback(url) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
}

/** Human message for a failed test, with CORS guidance for local/custom endpoints. */
export function testFailMessage(error, preset) {
  const { key, vars } = describeError(error, { browser: preset?.browser, providerLabel: preset?.label, origin: location.origin, operation: 'test' });
  return t(key, vars);
}

export function initConnections(ctx) {
  const { store, vault } = ctx;
  const form = $('#connection-form');
  const keyInput = $('#conn-key');
  const nameInput = $('#conn-name');
  const baseInput = $('#conn-base-url');
  const testResult = $('#conn-test-result');
  const testMessage = $('#conn-test-message');
  let editingId = null;
  let nameTouched = false;
  let testRun = 0;
  let testController = null;
  let lastTest = null; // { ok: boolean } for the form's current values

  const presetValue = () => form.querySelector('input[name="conn-preset"]:checked')?.value || 'openai';
  const rememberValue = () => form.querySelector('input[name="conn-remember"]:checked')?.value || 'session';

  function setTest(state, message = '') {
    testResult.dataset.state = state;
    testMessage.textContent = message;
  }

  function clearKeyError() {
    $('#conn-key-error').hidden = true;
    $('#conn-key-error').textContent = '';
    keyInput.removeAttribute('aria-invalid');
    baseInput.removeAttribute('aria-invalid');
  }

  function showFieldError(input, message) {
    const error = $('#conn-key-error');
    if (input === keyInput) {
      error.textContent = message;
      error.hidden = false;
    } else {
      setTest('error', message);
    }
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }

  function syncPreset() {
    const preset = core.getProvider(presetValue());
    const editing = editingId ? store.getState().connections.find((c) => c.id === editingId) : null;
    const showKey = preset.keyRequired || preset.id === 'custom';
    $('#conn-key-field').hidden = !showKey;
    $('#conn-remember-field').hidden = !showKey;
    $('#conn-base-url-field').hidden = !preset.customBaseUrl;
    baseInput.placeholder = preset.baseUrl || 'https://llm.example.org/v1';
    const link = $('#conn-key-link');
    link.hidden = !preset.keyUrl;
    if (preset.keyUrl) link.href = preset.keyUrl;
    nameInput.placeholder = preset.label;
    if (!nameTouched && !editing) nameInput.value = '';
    const local = preset.id === 'local' || (preset.id === 'custom' && isLoopback(baseInput.value));
    $('#conn-privacy-text').textContent = t(local ? 'app.conn.privacyLocal' : 'app.conn.privacyCloud');
    keyInput.placeholder = editing?.hasKey && editing.provider === preset.id ? t('app.conn.keyKeep') : (preset.keyRequired ? '' : t('app.conn.keyOptional'));
    $('#conn-test-hint').textContent = preset.capabilities.modelListing || preset.family === 'elevenlabs' ? '' : t('app.conn.testUnavailable', { provider: preset.label });
  }

  function formConnection() {
    const preset = core.getProvider(presetValue());
    const connection = { provider: preset.id };
    const typed = keyInput.value.trim();
    if (typed) connection.apiKey = typed;
    else if (editingId) {
      const saved = vault.connection(editingId);
      if (saved?.provider === preset.id && saved.apiKey) connection.apiKey = saved.apiKey;
    }
    if (preset.customBaseUrl) connection.baseUrl = baseInput.value.trim();
    return { preset, connection };
  }

  async function runTest() {
    const { preset, connection } = formConnection();
    clearKeyError();
    testController?.abort();
    testController = new AbortController();
    const run = ++testRun;
    if (preset.customBaseUrl) {
      try { core.validateBaseUrl(connection.baseUrl || ''); } catch { showFieldError(baseInput, t('app.conn.urlInvalid')); return; }
    }
    if (preset.keyRequired && !connection.apiKey) { showFieldError(keyInput, t('app.conn.keyRequired')); return; }
    setTest('testing', t('app.conn.testing'));
    try {
      const { models } = await core.testConnection(connection, { purpose: null, signal: testController.signal });
      if (run !== testRun) return;
      lastTest = { ok: true };
      ctx.modelCache?.clear();
      setTest('ok', models.length ? t('app.conn.testOk', { n: models.length }) : t('app.conn.testOkNoList'));
    } catch (error) {
      if (run !== testRun || error?.code === 'aborted') return;
      if (error?.code === 'unsupported') {
        lastTest = null;
        setTest('idle', t('app.conn.testUnavailable', { provider: preset.label }));
        return;
      }
      lastTest = { ok: false };
      setTest('error', t('app.conn.testFail', { reason: testFailMessage(error, preset) }));
      if (error?.code === 'auth') keyInput.setAttribute('aria-invalid', 'true');
    }
  }

  function resetForm() {
    testController?.abort();
    testRun += 1;
    form.reset();
    editingId = null;
    nameTouched = false;
    lastTest = null;
    keyInput.value = '';
    baseInput.value = '';
    clearKeyError();
    setTest('idle');
    $('#conn-form-title').textContent = t('app.conn.addTitle');
    $('#btn-conn-remove').hidden = true;
    syncPreset();
  }

  function editConnection(id) {
    const record = store.getState().connections.find((c) => c.id === id);
    if (!record) return;
    resetForm();
    editingId = id;
    nameTouched = true;
    form.querySelector(`input[name="conn-preset"][value="${record.provider}"]`).checked = true;
    nameInput.value = record.name;
    baseInput.value = record.baseUrl || '';
    form.querySelector(`input[name="conn-remember"][value="${record.remember}"]`).checked = true;
    $('#conn-form-title').textContent = t('app.conn.editTitle');
    $('#btn-conn-remove').hidden = false;
    syncPreset();
    showConnectionView('edit');
  }

  async function removeConnection(id) {
    const record = store.getState().connections.find((c) => c.id === id);
    if (!record) return;
    const ok = await confirmDialog({
      title: t('app.confirm.removeConnection.title', { name: record.name }),
      message: t('app.confirm.removeConnection.message'),
      confirmLabel: t('app.confirm.removeConnection.ok'),
      tone: 'danger',
    });
    if (!ok) return;
    vault.remove(id);
    ctx.modelCache?.clear();
    store.dispatch({ type: 'connections/set', connections: vault.list() });
    if (editingId === id) { resetForm(); showConnectionView('list'); }
    toast(t('app.toast.connRemoved'), { tone: 'success' });
  }

  function save() {
    const { preset, connection } = formConnection();
    clearKeyError();
    let baseUrl = '';
    if (preset.customBaseUrl) {
      try { baseUrl = core.validateBaseUrl(baseInput.value); } catch { showFieldError(baseInput, t('app.conn.urlInvalid')); return; }
    }
    if (preset.keyRequired && !connection.apiKey) { showFieldError(keyInput, t('app.conn.keyRequired')); return; }
    if (connection.apiKey && (connection.apiKey.length > 1024 || /\s/.test(connection.apiKey))) { showFieldError(keyInput, t('app.conn.keyInvalid')); return; }
    const id = editingId || newConnectionId();
    const typed = keyInput.value.trim();
    const previous = editingId ? store.getState().connections.find((c) => c.id === editingId) : null;
    const providerChanged = previous && previous.provider !== preset.id;
    const record = { id, provider: preset.id, name: nameInput.value.trim() || preset.label, baseUrl, remember: rememberValue() };
    vault.save(record, typed ? typed : (providerChanged || !(preset.keyRequired || preset.id === 'custom') ? '' : undefined));
    keyInput.value = '';
    ctx.modelCache?.clear();
    store.dispatch({ type: 'connections/set', connections: vault.list() });
    store.dispatch({ type: 'connection/status', id, status: lastTest ? (lastTest.ok ? 'ok' : 'error') : 'untested' });
    if (lastTest?.ok) ctx.autoPickModels?.(id);
    toast(t('app.toast.connSaved'), { tone: 'success' });
    resetForm();
    showConnectionView('list');
  }

  function renderList() {
    const { connections, connectionStatus } = store.getState();
    const list = $('#connections-list');
    list.replaceChildren(...connections.map((record) => {
      const li = cloneTemplate('tpl-connection');
      const status = connectionStatus[record.id] || 'untested';
      li.dataset.connectionId = record.id;
      li.dataset.status = status;
      $('.conn-item__name', li).textContent = record.name;
      $('.conn-item__detail', li).textContent = describeRecord(record, t);
      $('.conn-item__status', li).textContent = t({ ok: 'app.conn.statusOk', error: 'app.conn.statusError', untested: 'app.conn.statusUntested' }[status]);
      applyI18n(li);
      return li;
    }));
    $('#connections-empty').hidden = connections.length > 0;
  }

  form.addEventListener('change', (event) => {
    if (event.target.name === 'conn-preset') {
      // Prefill the preset's default endpoint once, when the provider is chosen (never while typing).
      if (!editingId) baseInput.value = core.getProvider(presetValue()).baseUrl || '';
      lastTest = null;
      setTest('idle');
      clearKeyError();
      syncPreset();
    }
  });
  form.addEventListener('input', (event) => {
    if (event.target === nameInput) nameTouched = true;
    if (event.target === keyInput || event.target === baseInput) {
      lastTest = null;
      if (testResult.dataset.state !== 'testing') setTest('idle');
      clearKeyError();
      if (event.target === baseInput) syncPreset();
    }
  });
  form.addEventListener('submit', (event) => { event.preventDefault(); save(); });
  form.addEventListener('ui:connection-new', resetForm);
  $('#btn-test-connection').addEventListener('click', runTest);
  $('#btn-conn-remove').addEventListener('click', () => editingId && removeConnection(editingId));
  $('#btn-conn-cancel').addEventListener('click', resetForm);
  $('#btn-conn-back').addEventListener('click', resetForm);
  $('#connections-list').addEventListener('click', (event) => {
    const row = event.target.closest('[data-connection-id]');
    if (!row) return;
    if (event.target.closest('[data-action="edit-connection"]')) editConnection(row.dataset.connectionId);
    if (event.target.closest('[data-action="remove-connection"]')) removeConnection(row.dataset.connectionId);
  });
  // Typed keys never linger in the DOM after the dialog closes.
  document.getElementById('settings-dialog').addEventListener('close', () => { keyInput.value = ''; resetForm(); showConnectionView('list'); });

  store.subscribe((state, previous) => {
    if (state.connections !== previous.connections || state.connectionStatus !== previous.connectionStatus) renderList();
    if (state.server !== previous.server) $('#server-mode-note').hidden = !state.server;
  });
  onLangChange(() => { renderList(); syncPreset(); });
  renderList();
  syncPreset();

  return { editConnection, resetForm };
}
