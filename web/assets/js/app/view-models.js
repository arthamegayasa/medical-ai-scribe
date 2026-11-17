// Settings > Models: one picker for transcription, one for the note. Each picks a connection
// (any connection with that capability, or a server-held provider) and a model from the live
// list, with search, keyboard navigation and a manual-ID fallback.
import { t, onLangChange } from '../i18n.js';
import { cloneTemplate } from '../ui.js';
import { targetsFor, filterModels, defaultModelFor, ROLES } from './selection.js';
import { describeError } from './messages.js';
import * as core from '../../../core/index.js';

const $ = (sel, root = document) => root.querySelector(sel);

export function targetLabel(target) {
  if (target.kind === 'server') return target.provider === 'server' ? t('app.models.serverTranscription') : t('app.models.serverTarget', { name: target.name });
  return target.name;
}

export function initModels(ctx) {
  const { store, services } = ctx;
  const cache = new Map(); // `${targetId}|${role}` -> { models, listed }
  ctx.modelCache = cache;

  const pickers = Object.fromEntries(ROLES.map((role) => {
    const root = $(`#picker-${role}`);
    return [role, {
      role, root,
      conn: $(`#model-${role}-conn`), input: $(`#model-${role}-input`), list: $(`#model-${role}-list`),
      status: $(`#model-${role}-status`), error: $(`#model-${role}-error`),
      models: [], filtered: [], active: -1, loadRun: 0, controller: null, manual: false,
    }];
  }));

  function setState(picker, state) { picker.root.dataset.state = state; }

  function closeList(picker) {
    picker.list.hidden = true;
    picker.input.setAttribute('aria-expanded', 'false');
    picker.input.removeAttribute('aria-activedescendant');
    picker.active = -1;
  }

  function renderList(picker) {
    const query = picker.input.dataset.typed === 'true' ? picker.input.value : '';
    picker.filtered = filterModels(picker.models, query).slice(0, 200);
    const selected = store.getState().prefs.selection[picker.role].model;
    picker.list.replaceChildren(...picker.filtered.map((model, i) => {
      const li = cloneTemplate('tpl-model-option');
      li.id = `model-${picker.role}-opt-${i}`;
      li.dataset.modelId = model.id;
      li.setAttribute('aria-selected', String(model.id === selected));
      $('.combo__option-id', li).textContent = model.id;
      const meta = [];
      if (model.label && model.label !== model.id) meta.push(model.label);
      if (Number.isFinite(model.contextTokens)) meta.push(t('app.models.context', { n: Math.round(model.contextTokens / 1000) }));
      $('.combo__option-meta', li).textContent = meta.join(' · ');
      if (i === picker.active) li.classList.add('is-active');
      return li;
    }));
    const open = picker.filtered.length > 0 && document.activeElement === picker.input;
    picker.list.hidden = !open;
    picker.input.setAttribute('aria-expanded', String(open));
    if (open && picker.active >= 0) picker.input.setAttribute('aria-activedescendant', `model-${picker.role}-opt-${picker.active}`);
    else picker.input.removeAttribute('aria-activedescendant');
  }

  function moveActive(picker, step) {
    if (!picker.filtered.length) return;
    picker.active = picker.active === -1 ? (step > 0 ? 0 : picker.filtered.length - 1) : (picker.active + step + picker.filtered.length) % picker.filtered.length;
    renderList(picker);
    picker.list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  function commit(picker, modelId) {
    const id = String(modelId || '').trim();
    const { connectionId } = store.getState().prefs.selection[picker.role];
    picker.input.dataset.typed = 'false';
    closeList(picker);
    if (!connectionId || !id) { picker.input.value = store.getState().prefs.selection[picker.role].model; return; }
    picker.input.value = id;
    store.dispatch({ type: 'selection/set', role: picker.role, connectionId, model: id });
    const known = picker.models.some((m) => m.id === id);
    picker.status.textContent = known || !picker.models.length ? statusText(picker) : t('app.models.notInList', { id });
  }

  function statusText(picker) {
    const entry = cache.get(cacheKey(picker));
    if (!entry) return '';
    if (!entry.listed) return t('app.models.suggestedOnly');
    return t('app.models.count', { n: entry.models.length });
  }

  const cacheKey = (picker) => `${store.getState().prefs.selection[picker.role].connectionId}|${picker.role}`;

  async function load(picker, { refresh = false } = {}) {
    const { connectionId } = store.getState().prefs.selection[picker.role];
    picker.controller?.abort();
    picker.error.hidden = true;
    picker.error.textContent = '';
    if (!connectionId) {
      picker.models = [];
      setState(picker, 'idle');
      picker.status.textContent = t('app.models.noConnection');
      return;
    }
    const key = cacheKey(picker);
    if (refresh) cache.delete(key);
    if (cache.has(key)) {
      picker.models = cache.get(key).models;
      setState(picker, picker.manual ? 'manual' : 'ready');
      picker.status.textContent = picker.manual ? t('app.models.manualHint') : statusText(picker);
      return;
    }
    const run = ++picker.loadRun;
    picker.controller = new AbortController();
    const target = targetsFor(picker.role, store.getState().connections, store.getState().server).find((item) => item.id === connectionId);
    setState(picker, 'loading');
    picker.status.textContent = t('app.models.loadingFrom', { name: target ? targetLabel(target) : '' });
    try {
      const result = await services.listModels(connectionId, picker.role, { signal: picker.controller.signal });
      if (run !== picker.loadRun) return;
      cache.set(key, result);
      picker.models = result.models;
      setState(picker, picker.manual ? 'manual' : 'ready');
      picker.status.textContent = picker.manual ? t('app.models.manualHint') : statusText(picker);
      if (document.activeElement === picker.input) renderList(picker);
    } catch (error) {
      if (run !== picker.loadRun || error?.code === 'aborted') return;
      picker.models = [];
      setState(picker, 'manual');
      const record = store.getState().connections.find((c) => c.id === connectionId);
      let preset = null;
      try { preset = record ? core.getProvider(record.provider) : null; } catch { preset = null; }
      const { key: reasonKey, vars } = describeError(error, { browser: preset?.browser, providerLabel: record?.name, origin: location.origin });
      picker.error.textContent = `${t('app.models.error', { name: record?.name || '' })} ${t(reasonKey, vars)}`;
      picker.error.hidden = false;
      picker.status.textContent = t('app.models.manualHint');
      store.dispatch({ type: 'connection/status', id: connectionId, status: 'error' });
    }
  }

  function renderPicker(picker) {
    const state = store.getState();
    const targets = targetsFor(picker.role, state.connections, state.server);
    const { connectionId, model } = state.prefs.selection[picker.role];
    picker.conn.replaceChildren(...targets.map((target) => new Option(targetLabel(target), target.id, false, target.id === connectionId)));
    if (!targets.length) picker.conn.append(new Option(t('app.models.noConnection'), '', true, true));
    picker.conn.disabled = !targets.length;
    picker.input.disabled = !targets.length;
    if (document.activeElement !== picker.input) picker.input.value = model || '';
  }

  for (const picker of Object.values(pickers)) {
    picker.conn.addEventListener('change', () => {
      const state = store.getState();
      const target = targetsFor(picker.role, state.connections, state.server).find((item) => item.id === picker.conn.value);
      picker.manual = false;
      // The store subscription below loads the new connection's models.
      store.dispatch({ type: 'selection/set', role: picker.role, connectionId: picker.conn.value || null, model: defaultModelFor(target, picker.role) });
    });
    picker.input.addEventListener('focus', () => { picker.input.dataset.typed = 'false'; picker.active = -1; renderList(picker); });
    picker.input.addEventListener('input', () => { picker.input.dataset.typed = 'true'; picker.active = picker.input.value ? 0 : -1; renderList(picker); });
    picker.input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); if (picker.list.hidden) { picker.active = -1; renderList(picker); } moveActive(picker, 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(picker, -1); }
      else if (event.key === 'Home' && !picker.list.hidden) { event.preventDefault(); picker.active = 0; renderList(picker); }
      else if (event.key === 'End' && !picker.list.hidden) { event.preventDefault(); picker.active = picker.filtered.length - 1; renderList(picker); }
      else if (event.key === 'Enter') {
        event.preventDefault();
        commit(picker, !picker.list.hidden && picker.active >= 0 ? picker.filtered[picker.active]?.id : picker.input.value);
      } else if (event.key === 'Escape') {
        if (!picker.list.hidden) {
          event.preventDefault();
          event.stopPropagation(); // keep the dialog open
          closeList(picker);
          picker.input.value = store.getState().prefs.selection[picker.role].model;
          picker.input.dataset.typed = 'false';
        }
      } else if (event.key === 'Tab') {
        if (picker.input.dataset.typed === 'true') commit(picker, picker.input.value); else closeList(picker);
      }
    });
    picker.input.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement === picker.input) return;
        if (picker.input.dataset.typed === 'true') commit(picker, picker.input.value); else closeList(picker);
      }, 0);
    });
    // mousedown keeps focus in the input so the click can select.
    picker.list.addEventListener('mousedown', (event) => event.preventDefault());
    picker.list.addEventListener('click', (event) => {
      const option = event.target.closest('[data-model-id]');
      if (option) commit(picker, option.dataset.modelId);
    });
    picker.root.addEventListener('click', (event) => {
      if (event.target.closest('[data-action="refresh-models"]')) { picker.manual = false; load(picker, { refresh: true }); }
      if (event.target.closest('[data-action="manual-model"]')) {
        picker.manual = true;
        setState(picker, 'manual');
        picker.status.textContent = t('app.models.manualHint');
        closeList(picker);
        picker.input.focus();
        picker.input.select();
      }
    });
  }

  const renderAll = () => Object.values(pickers).forEach(renderPicker);

  store.subscribe((state, previous) => {
    if (state.connections !== previous.connections || state.server !== previous.server || state.prefs.selection !== previous.prefs.selection) renderAll();
    for (const picker of Object.values(pickers)) {
      const before = previous.prefs.selection[picker.role].connectionId;
      const after = state.prefs.selection[picker.role].connectionId;
      if (before !== after || state.connections !== previous.connections) {
        const dialog = document.getElementById('settings-dialog');
        if (dialog.open) load(picker);
      }
    }
  });
  document.addEventListener('ui:tabchange', (event) => {
    if (event.detail.tab.dataset.settingsTab === 'models') Object.values(pickers).forEach((picker) => load(picker));
  });
  document.getElementById('settings-dialog').addEventListener('ui:opened', () => {
    if (!document.getElementById('set-models').hidden) Object.values(pickers).forEach((picker) => load(picker));
  });
  onLangChange(() => { renderAll(); Object.values(pickers).forEach((picker) => { if (picker.root.dataset.state === 'ready') picker.status.textContent = statusText(picker); }); });
  renderAll();
  return { load: (role) => load(pickers[role]) };
}
