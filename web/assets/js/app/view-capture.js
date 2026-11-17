// Capture: microphone recording, file upload / drag-and-drop, and pasted text. Audio goes through
// the engine's upload strategy (direct, or decoded into segments), with progress, cancel, and
// retry of a failed segment that keeps the segments already transcribed.
import { t, tn, getLang, onLangChange } from '../i18n.js';
import { confirmDialog, toast, announce } from '../ui.js';
import { setCaptureMethod } from '../app-ui.js';
import { isRecordingSupported, startRecording, micError } from './recorder.js';
import { describeError, AppError } from './messages.js';
import { parsePasted, turnsFromTranscript, turnsFromLabelled, clock } from './transcript.js';
import { vocabularyList } from './prefs.js';
import { formatBytes, formatDuration } from './format.js';

const $ = (sel, root = document) => root.querySelector(sel);
const AUDIO_EXT = /\.(m4a|mp3|mp4|wav|webm|ogg|oga|opus|flac|aac|mpga|mpeg)$/i;

export function initCapture(ctx) {
  const { store, services } = ctx;
  const capture = $('#capture');
  let recording = null;
  let timer = 0;
  let selectedFile = null;
  let selectedDuration = null;
  let pending = null; // { blob, durationSec, source, segments, job, merge }
  let controller = null;
  let busy = false;

  const recordSupported = isRecordingSupported();
  if (!recordSupported) {
    $('#btn-record').disabled = true;
    $('#record-hint').textContent = t('app.err.recorderUnsupported');
    store.dispatch({ type: 'capture/method', method: 'upload' });
    setCaptureMethod('upload');
  }

  function setCapture(state, extra = {}) {
    store.dispatch({ type: 'capture/state', state, ...extra });
  }

  function render(state) {
    const c = state.capture;
    capture.dataset.state = c.state;
    if (capture.dataset.method !== c.method) capture.dataset.method = c.method;
    const hasTranscript = state.session.turns.length > 0;
    capture.hidden = hasTranscript;
    if (c.state === 'error' && c.error) {
      $('#capture-error-title').textContent = t(c.error.titleKey || 'app.captureError.title');
      $('#capture-error-message').textContent = c.error.text;
    }
    if (c.state === 'processing' && c.progress) renderProgress(c.progress);
    $('#rec-status-label').textContent = t(c.state === 'paused' ? 'app.capture.paused' : 'app.capture.recording');
    $('#btn-pause').dataset.state = c.state === 'paused' ? 'resume' : 'pause';
  }

  function renderProgress(progress) {
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
    $('#proc-progress-bar').style.setProperty('--value', String(percent));
    $('#proc-progress').setAttribute('aria-valuenow', String(percent));
    const label = progress.phase === 'segments' ? t('app.proc.segment', { i: Math.min(progress.completed + 1, progress.total), n: progress.total })
      : progress.phase === 'labelling' ? t('app.proc.labelling')
        : progress.phase === 'finishing' ? t('app.proc.finishing')
          : progress.phase === 'resuming' ? t('app.proc.resuming', { done: progress.completed, n: progress.total })
            : t('app.proc.preparing');
    $('#proc-label').textContent = label;
  }

  function showError(error, { titleKey = 'app.captureError.title', role = 'transcription', failed } = {}) {
    const { key, vars } = describeError(error, services.errorContext(role));
    let text = t(key, vars);
    if (failed) text = `${text} ${t('app.proc.failedSegment', { i: failed.index + 1, n: failed.total, done: failed.completed })}`;
    setCapture('error', { error: { titleKey, text } });
    announce(text, { assertive: true });
  }

  // ---------- Recording ----------
  function tickTimer() {
    if (!recording) return;
    $('#rec-timer').textContent = clock(recording.elapsedMs() / 1000);
  }

  const bars = [...document.querySelectorAll('#rec-meter .meter__bar')];
  function onLevel(levels) {
    bars.forEach((bar, i) => bar.style.setProperty('--h', levels[i].toFixed(3)));
  }

  async function startRecord() {
    if (busy || recording || !recordSupported) return;
    // Explain the actual gap (no connection, no key or no model) before asking for the microphone.
    try { services.target('transcription'); } catch (error) { showError(error); return; }
    busy = true;
    setCapture('requesting');
    try {
      recording = await startRecording({ onLevel, bars: bars.length });
      $('#rec-timer').textContent = '00:00';
      timer = setInterval(tickTimer, 250);
      const hint = segmentHint();
      $('#rec-segment-hint').textContent = hint;
      setCapture('recording');
      announce(t('app.capture.recording'));
    } catch (error) {
      recording = null;
      const mapped = micError(error);
      if (mapped === 'denied') setCapture('denied');
      else showError(mapped, { titleKey: 'app.captureError.micTitle' });
    } finally {
      busy = false;
    }
  }

  function segmentHint() {
    try {
      const target = services.target('transcription');
      const max = target.kind === 'server' ? store.getState().server.limits.audio_bytes : target.preset.maxUploadBytes;
      // Opus speech is roughly 16 kB/s; past the limit the recording is decoded into 10-minute WAV segments.
      return max < 20e6 ? t('app.capture.segmentHint', { min: Math.max(1, Math.floor(max / 32000 / 60)) || 1 }) : t('app.capture.segmentHint', { min: 10 });
    } catch { return ''; }
  }

  function stopTimer() { clearInterval(timer); timer = 0; bars.forEach((bar) => bar.style.setProperty('--h', '0')); }

  async function stopRecord() {
    if (!recording) return;
    const active = recording;
    recording = null;
    stopTimer();
    const { blob, seconds } = await active.stop();
    if (!blob.size) { showError(new AppError('emptyAudio')); return; }
    await transcribeAudio({ blob, durationSec: seconds, source: 'record' });
  }

  async function discardRecord() {
    if (!recording) return;
    const ok = await confirmDialog({ title: t('app.confirm.discard.title'), message: t('app.confirm.discard.message'), confirmLabel: t('app.confirm.discard.ok'), tone: 'danger' });
    if (!ok || !recording) return;
    recording.discard();
    recording = null;
    stopTimer();
    setCapture('idle');
  }

  function togglePause() {
    if (!recording) return;
    if (recording.state === 'recording') { recording.pause(); setCapture('paused'); announce(t('app.capture.paused')); }
    else if (recording.state === 'paused') { recording.resume(); setCapture('recording'); announce(t('app.capture.recording')); }
  }

  // ---------- Transcription pipeline ----------
  async function transcribeAudio({ blob, durationSec, source }) {
    if (controller) return;
    pending = { blob, durationSec, source, segments: null, job: null, merge: null };
    await runPending();
  }

  async function runPending() {
    if (!pending || controller) return;
    controller = new AbortController();
    const { signal } = controller;
    const resuming = Boolean(pending.job && pending.job.completed > 0);
    setCapture('processing', { progress: resuming ? { phase: 'resuming', completed: pending.job.completed, total: pending.job.total, percent: (pending.job.completed / pending.job.total) * 90 } : { phase: 'preparing', percent: 2 } });
    try {
      if (!pending.segments) {
        pending.segments = await services.prepareAudio(pending.blob);
        if (signal.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
      }
      if (!pending.job) {
        const { prefs } = store.getState();
        const language = $('#audio-language').value;
        const built = services.transcriptionJob(pending.segments, {
          language: language === 'auto' ? undefined : language,
          vocabulary: vocabularyList(prefs.vocabulary),
          diarize: prefs.speakers,
          onProgress: ({ completed, total }) => store.dispatch({ type: 'capture/progress', progress: { phase: 'segments', completed, total, percent: 5 + (completed / total) * 85 } }),
        });
        pending.job = built.job;
        pending.merge = built.merge;
      }
      store.dispatch({ type: 'capture/progress', progress: { phase: 'segments', completed: pending.job.completed, total: pending.job.total, percent: 5 + (pending.job.completed / pending.job.total) * 85 } });
      const results = await pending.job.start(signal);
      store.dispatch({ type: 'capture/progress', progress: { phase: 'finishing', percent: 92 } });
      const merged = pending.merge(results);
      let { turns, diarized } = turnsFromTranscript(merged);
      let labels = diarized ? 'native' : 'none';
      if (!turns.length) throw new AppError('emptyAudio');
      if (!diarized && store.getState().prefs.speakers && services.hasTarget('note')) {
        store.dispatch({ type: 'capture/progress', progress: { phase: 'labelling', percent: 95 } });
        try {
          const labelled = await services.labelSpeakers({ transcript: merged.text, signal });
          turns = turnsFromLabelled(labelled.turns);
          labels = 'ai';
        } catch (error) {
          if (error?.code === 'aborted') throw error;
          toast(t('app.toast.labelsFailed'), { tone: 'warning' });
        }
      }
      const lastEnd = pending.segments.at(-1)?.end;
      const durationSec = Number.isFinite(pending.durationSec) && pending.durationSec > 0 ? pending.durationSec : (Number.isFinite(lastEnd) ? lastEnd : null);
      store.dispatch({ type: 'transcript/set', turns, labels, source: pending.source, durationSec, at: new Date().toISOString() });
      pending = null;
      selectedFile = null;
      renderFile();
      announce(t('app.toast.transcribed'));
    } catch (error) {
      if (error?.code === 'aborted' || signal.aborted) {
        setCapture('idle');
        toast(t('app.toast.cancelled'));
        if (pending && !pending.job?.completed) pending = null;
      } else {
        const failed = pending?.job && pending.job.failedIndex !== null ? { index: pending.job.failedIndex, total: pending.job.total, completed: pending.job.completed } : null;
        showError(error, { failed });
      }
    } finally {
      controller = null;
    }
  }

  function cancelProcessing() {
    controller?.abort();
  }

  async function retry() {
    const state = store.getState().capture;
    if (state.state !== 'error') return;
    if (pending) { await runPending(); return; }
    setCapture('idle');
  }

  // ---------- Upload ----------
  function acceptFile(file) {
    if (!file) return;
    const isAudio = (file.type && /^(audio|video)\//.test(file.type)) || AUDIO_EXT.test(file.name);
    if (!isAudio) {
      toast(t('app.err.decode'), { tone: 'error' });
      return;
    }
    selectedFile = file;
    selectedDuration = null;
    renderFile();
    // Read the duration from metadata where the browser can (it is display only).
    const url = URL.createObjectURL(file);
    const probe = new Audio();
    probe.preload = 'metadata';
    probe.addEventListener('loadedmetadata', () => {
      if (selectedFile === file && Number.isFinite(probe.duration)) { selectedDuration = probe.duration; renderFile(); }
      URL.revokeObjectURL(url);
    }, { once: true });
    probe.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
    probe.src = url;
  }

  function renderFile() {
    $('#upload-file').hidden = !selectedFile;
    if (!selectedFile) { $('#file-input').value = ''; return; }
    $('#upload-file-name').textContent = selectedFile.name;
    const parts = [formatBytes(selectedFile.size, getLang())];
    if (selectedDuration) parts.push(formatDuration(selectedDuration));
    $('#upload-file-info').textContent = parts.join(', ');
  }

  async function transcribeFile() {
    if (!selectedFile || controller) return;
    try { services.target('transcription'); } catch (error) { showError(error); return; }
    await transcribeAudio({ blob: selectedFile, durationSec: selectedDuration, source: 'upload' });
  }

  // ---------- Paste ----------
  function usePaste() {
    const text = $('#paste-input').value;
    if (!text.trim()) return;
    const { turns, labelled } = parsePasted(text);
    if (!turns.length) return;
    store.dispatch({ type: 'transcript/set', turns, labels: labelled ? 'source' : 'none', source: 'paste', durationSec: null, at: new Date().toISOString() });
    $('#paste-input').value = '';
    $('#paste-input').dispatchEvent(new Event('input'));
  }

  // ---------- Wiring ----------
  $('#btn-record').addEventListener('click', startRecord);
  $('#btn-stop').addEventListener('click', stopRecord);
  $('#btn-pause').addEventListener('click', togglePause);
  $('#btn-discard').addEventListener('click', discardRecord);
  $('#btn-denied-retry').addEventListener('click', () => { setCapture('idle'); startRecord(); });
  $('#btn-cancel-processing').addEventListener('click', cancelProcessing);
  $('#btn-capture-retry').addEventListener('click', retry);
  $('#file-input').addEventListener('change', (event) => acceptFile(event.target.files?.[0]));
  $('#dropzone').addEventListener('ui:file-drop', (event) => acceptFile(event.detail.files[0]));
  $('#btn-remove-file').addEventListener('click', () => { selectedFile = null; renderFile(); });
  $('#btn-transcribe-file').addEventListener('click', transcribeFile);
  $('#btn-use-paste').addEventListener('click', usePaste);
  capture.addEventListener('ui:capture-method', (event) => {
    store.dispatch({ type: 'capture/method', method: event.detail.method });
    if (store.getState().capture.state === 'error' && !controller) pending = null;
  });

  // Leaving mid-recording or mid-transcription loses the audio: ask first.
  window.addEventListener('beforeunload', (event) => {
    const state = store.getState().capture.state;
    if (recording || ['recording', 'paused', 'processing', 'requesting'].includes(state)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  store.subscribe((state, previous) => {
    if (state.capture !== previous.capture || state.session.turns !== previous.session.turns) render(state);
  });
  onLangChange(() => { render(store.getState()); renderFile(); if (!recordSupported) $('#record-hint').textContent = t('app.err.recorderUnsupported'); });
  render(store.getState());

  return {
    cancel() {
      controller?.abort();
      if (recording) { recording.discard(); recording = null; stopTimer(); }
      pending = null;
      selectedFile = null;
      renderFile();
    },
    get active() { return Boolean(recording || controller); },
  };
}
