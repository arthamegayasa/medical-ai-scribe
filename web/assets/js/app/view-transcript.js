// Transcript: editable turns, speaker roles (pasted, native diarization, or AI-suggested and
// marked as such), timestamps, copy, and the generate controls.
import { t, tn, onLangChange, applyI18n } from '../i18n.js';
import { cloneTemplate, confirmDialog, toast, announce } from '../ui.js';
import { buildSource, transcriptForCopy, clock, turnsFromLabelled, newTurnId } from './transcript.js';
import { copyText } from './io.js';
import { formatDuration } from './format.js';
import { describeError } from './messages.js';

const $ = (sel, root = document) => root.querySelector(sel);

export function initTranscript(ctx) {
  const { store, services } = ctx;
  const root = $('#transcript');
  const list = $('#turns');
  let labelController = null;

  const labels = () => ({ doctor: t('common.doctor'), patient: t('common.patient'), other: t('common.other') });

  function renderTurns() {
    const { session } = store.getState();
    list.replaceChildren(...session.turns.map((turn, index) => {
      const li = cloneTemplate('tpl-turn');
      li.dataset.turnId = turn.id;
      li.dataset.speaker = turn.speaker;
      if (turn.aiSpeaker) li.dataset.aiSpeaker = 'true';
      $('.turn__num', li).textContent = String(index + 1);
      const select = $('.turn__speaker', li);
      select.value = turn.speaker;
      const time = $('.turn__time', li);
      const parts = [];
      if (Number.isFinite(turn.start)) parts.push(clock(turn.start));
      if (turn.diarSpeaker !== undefined) parts.push(t('app.transcript.diarSpeaker', { s: turn.diarSpeaker }));
      if (parts.length) { time.textContent = parts.join(' · '); time.hidden = false; }
      $('.turn__text', li).textContent = turn.text;
      applyI18n(li);
      return li;
    }));
    renderMeta();
  }

  function renderMeta() {
    const { session } = store.getState();
    const source = buildSource(session.turns, { speakers: session.speakersOn });
    $('#transcript-chars').textContent = tn('app.count.chars', source.text.length);
    const duration = $('#transcript-duration');
    duration.hidden = !Number.isFinite(session.durationSec);
    if (!duration.hidden) duration.textContent = t('app.transcript.duration', { d: formatDuration(session.durationSec) });
    const count = $('#transcript-turn-count');
    count.textContent = tn('app.count.turns', session.turns.length);
    count.hidden = session.turns.length === 0;
  }

  function renderShell() {
    const { session, noteState } = store.getState();
    const has = session.turns.length > 0;
    root.hidden = !has;
    root.dataset.speakers = session.speakersOn ? 'on' : 'off';
    $('#toggle-speakers').checked = session.speakersOn;
    const notice = $('#speaker-source');
    const hasUnknown = session.turns.some((turn) => turn.speaker === 'unknown');
    const allUnknown = has && session.turns.every((turn) => turn.speaker === 'unknown');
    const noticeKey = session.labels === 'ai' ? 'app.transcript.labelsAi' : session.labels === 'native' && hasUnknown ? 'app.transcript.labelsNative' : null;
    notice.hidden = !noticeKey || !session.speakersOn;
    if (noticeKey) $('#speaker-source-text').textContent = t(noticeKey);
    $('#btn-suggest-speakers').hidden = !(allUnknown && session.labels !== 'native');
    $('#btn-suggest-speakers').disabled = Boolean(labelController);
    const ws = $('#workspace');
    const stage = session.note ? 'note' : has ? 'transcript' : 'capture';
    if (ws.dataset.stage !== stage) ws.dataset.stage = stage;
    $('#btn-generate').disabled = !has || noteState.state === 'generating';
    $('#btn-new-session').hidden = !has && !session.note;
    $('#example-band').hidden = !session.fictional;
  }

  // Editing a turn updates state without re-rendering the row being typed in.
  list.addEventListener('input', (event) => {
    const text = event.target.closest('.turn__text');
    if (!text) return;
    store.dispatch({ type: 'turn/edit', id: text.closest('.turn').dataset.turnId, text: text.textContent });
  });
  list.addEventListener('focusout', (event) => {
    const text = event.target.closest('.turn__text');
    if (!text) return;
    const turn = text.closest('.turn');
    if (!text.textContent.trim() && store.getState().session.turns.length > 1) store.dispatch({ type: 'turn/remove', id: turn.dataset.turnId });
  });
  list.addEventListener('change', (event) => {
    const select = event.target.closest('.turn__speaker');
    if (!select) return;
    const turn = select.closest('.turn');
    turn.dataset.speaker = select.value;
    delete turn.dataset.aiSpeaker;
    const before = store.getState().session.turns;
    const target = before.find((item) => item.id === turn.dataset.turnId);
    store.dispatch({ type: 'turn/speaker', id: turn.dataset.turnId, speaker: select.value, applyToGroup: true });
    const changed = store.getState().session.turns.filter((item, i) => item.speaker !== before[i]?.speaker).length;
    if (target?.diarSpeaker !== undefined && changed > 1) toast(t('app.toast.speakerApplied', { n: changed, s: target.diarSpeaker }));
  });
  $('#toggle-speakers').addEventListener('change', (event) => store.dispatch({ type: 'speakers/toggle', on: event.target.checked }));

  $('#btn-add-turn').addEventListener('click', () => {
    const focused = document.activeElement?.closest?.('.turn');
    const id = newTurnId();
    store.dispatch({ type: 'turn/add', afterId: focused?.dataset.turnId, id, speaker: 'unknown' });
    list.querySelector(`[data-turn-id="${id}"] .turn__text`)?.focus();
  });
  $('#btn-copy-transcript').addEventListener('click', async () => {
    const { session } = store.getState();
    const ok = await copyText(transcriptForCopy(session.turns, labels(), { speakers: session.speakersOn }));
    toast(t(ok ? 'app.toast.transcriptCopied' : 'app.toast.copyFailed'), { tone: ok ? 'success' : 'error' });
  });
  $('#btn-clear-transcript').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: t('app.confirm.clearTranscript.title'), message: t('app.confirm.clearTranscript.message'), confirmLabel: t('app.confirm.clearTranscript.ok'), tone: 'danger' });
    if (!ok) return;
    ctx.cancelAll?.();
    store.dispatch({ type: 'session/new' });
  });

  // Optional AI speaker labelling for unlabelled text (clearly marked as suggested).
  $('#btn-suggest-speakers').addEventListener('click', async () => {
    if (labelController) return;
    const { session } = store.getState();
    const source = buildSource(session.turns, { speakers: false }).text;
    labelController = new AbortController();
    renderShell();
    const pendingToast = toast(t('app.transcript.labelling'), { duration: 0, action: { label: t('common.cancel'), onClick: () => labelController?.abort() } });
    try {
      const labelled = await services.labelSpeakers({ transcript: source, signal: labelController.signal });
      store.dispatch({ type: 'transcript/set', turns: turnsFromLabelled(labelled.turns), labels: 'ai' });
      announce(t('app.transcript.labelsAi'));
    } catch (error) {
      if (error?.code !== 'aborted') {
        const { key, vars } = describeError(error, services.errorContext('note'));
        toast(`${t('app.toast.labelsFailed')} ${t(key, vars)}`, { tone: 'error' });
      }
    } finally {
      pendingToast.dismiss();
      labelController = null;
      renderShell();
    }
  });

  store.subscribe((state, previous, action) => {
    const turnsChanged = state.session.turns !== previous.session.turns;
    if (turnsChanged && action.type !== 'turn/edit') renderTurns();
    else if (turnsChanged || state.session.speakersOn !== previous.session.speakersOn || state.session.durationSec !== previous.session.durationSec) renderMeta();
    if (state.session !== previous.session || state.noteState !== previous.noteState) renderShell();
  });
  onLangChange(() => { renderTurns(); renderShell(); });
  renderTurns();
  renderShell();
  return { cancel: () => labelController?.abort() };
}
