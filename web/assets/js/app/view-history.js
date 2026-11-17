// Session history drawer and the on-device saving controller. History is opt-in: with it off,
// nothing about the encounter is written anywhere.
import { t, getLang, onLangChange, applyI18n } from '../i18n.js';
import { cloneTemplate, confirmDialog, toast, closeDialog, announce } from '../ui.js';
import { toRecord, fromRecord, purgeExpired, newSessionId } from './history.js';
import { templateLabel, formatDuration, formatDateTime } from './format.js';

const $ = (sel, root = document) => root.querySelector(sel);

export function initHistory(ctx) {
  const { store, history } = ctx;
  const drawer = $('#history-drawer');
  let saveTimer = 0;
  let saving = Promise.resolve();
  let announcedFor = null;
  let records = [];

  const enabled = () => store.getState().prefs.history && store.getState().historyAvailable;
  const worthSaving = (session) => !session.fictional && session.turns.some((turn) => String(turn.text).trim());

  async function saveNow() {
    clearTimeout(saveTimer);
    const { session } = store.getState();
    if (!enabled() || !worthSaving(session)) return;
    const id = session.id || newSessionId();
    const record = toRecord(session, { id });
    saving = saving.then(() => history.put(record)).then(() => {
      const current = store.getState().session;
      if (!current.id && current.createdAt === session.createdAt) store.dispatch({ type: 'session/saved', id });
      if (announcedFor !== id) {
        announcedFor = id;
        toast(t('app.toast.sessionSaved'), { tone: 'success' });
      }
      ctx.refreshStorageSummary?.();
      if (drawer.open) refresh();
    }).catch(() => {
      toast(t('app.err.storage'), { tone: 'error' });
    });
    return saving;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }

  async function refresh() {
    const state = store.getState();
    if (!enabled()) {
      drawer.dataset.state = 'off';
      return;
    }
    try {
      await purgeExpired(history, state.prefs.autoDeleteDays);
      records = await history.list();
    } catch {
      records = [];
    }
    drawer.dataset.state = records.length ? 'list' : 'empty';
    render();
  }

  function render() {
    const state = store.getState();
    const list = $('#history-list');
    list.replaceChildren(...records.map((record) => {
      const li = cloneTemplate('tpl-history-item');
      li.dataset.sessionId = record.id;
      if (record.id === state.session.id) li.classList.add('is-current');
      $('.history-item__title', li).textContent = record.title || t('app.history.untitled');
      $('.history-item__meta', li).textContent = t('app.history.metaLine', {
        date: formatDateTime(record.updatedAt, getLang()),
        duration: Number.isFinite(record.durationSec) ? formatDuration(record.durationSec) : t('app.history.noAudio'),
        template: templateLabel(record.template || 'general'),
      });
      applyI18n(li);
      return li;
    }));
    const days = state.prefs.autoDeleteDays;
    $('#history-retention').textContent = days === 0 ? t('app.history.retentionNever') : days === 1 ? t('app.history.retentionDay') : t('app.history.retention', { days });
    const search = $('#history-search');
    if (search.value) search.dispatchEvent(new Event('input'));
  }

  async function openSession(id) {
    const record = records.find((item) => item.id === id) || await history.get(id);
    if (!record) return;
    const { session } = store.getState();
    if (session.id !== id && session.turns.length && !(enabled() && session.id && !session.fictional)) {
      const ok = await confirmDialog({ title: t('app.confirm.newSession.title'), message: t('app.confirm.newSession.message'), confirmLabel: t('app.history.open') });
      if (!ok) return;
    }
    ctx.cancelAll?.();
    store.dispatch({ type: 'session/load', session: fromRecord(record) });
    closeDialog(drawer);
    announce(t('app.history.opened'));
  }

  async function deleteSession(id) {
    const ok = await confirmDialog({ title: t('app.confirm.deleteSession.title'), message: t('app.confirm.deleteSession.message'), confirmLabel: t('common.delete'), tone: 'danger' });
    if (!ok) return;
    await history.delete(id);
    if (store.getState().session.id === id) store.dispatch({ type: 'session/saved', id: null });
    toast(t('app.toast.sessionDeleted'), { tone: 'success' });
    ctx.refreshStorageSummary?.();
    refresh();
  }

  async function deleteAll({ confirm = true } = {}) {
    if (confirm) {
      const ok = await confirmDialog({ title: t('app.confirm.deleteHistory.title'), message: t('app.confirm.deleteHistory.message'), confirmLabel: t('app.confirm.deleteHistory.ok'), tone: 'danger' });
      if (!ok) return false;
    }
    await history.clear().catch(() => {});
    if (store.getState().session.id) store.dispatch({ type: 'session/saved', id: null });
    ctx.refreshStorageSummary?.();
    refresh();
    return true;
  }

  $('#history-list').addEventListener('click', (event) => {
    const row = event.target.closest('[data-session-id]');
    if (!row) return;
    if (event.target.closest('[data-action="open-session"]')) openSession(row.dataset.sessionId);
    if (event.target.closest('[data-action="delete-session"]')) deleteSession(row.dataset.sessionId);
  });
  $('#btn-history-delete-all').addEventListener('click', async () => {
    if (await deleteAll()) toast(t('app.toast.historyDeleted'), { tone: 'success' });
  });
  drawer.addEventListener('ui:opened', refresh);

  // Save while history is on: after transcript, draft and edits (debounced).
  store.subscribe((state, previous, action) => {
    if (!enabled()) return;
    // Opening a saved session must not refresh its date (that would postpone auto-delete).
    if (action.type === 'session/load' || action.type === 'session/saved') return;
    if (state.session !== previous.session && worthSaving(state.session)) {
      const settled = state.noteState.state !== 'generating' && !state.noteState.regenerating;
      if (settled) scheduleSave();
    } else if (state.noteState !== previous.noteState && state.noteState.state === 'ready' && worthSaving(state.session)) scheduleSave();
  });
  onLangChange(() => { if (drawer.open) render(); });

  return { refresh, saveNow, deleteAll, count: () => history.count().catch(() => 0) };
}
