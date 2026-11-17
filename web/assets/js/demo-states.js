// Design-review harness. Loaded only when the URL has ?demo=<state> (see app-ui.js).
// Switches the shell between states with FICTIONAL sample content, by cloning the same
// templates the wiring layer will use. Never imported in normal use.
//
// Extra params: &pane=note (small screens), &theme=light|dark, &lang=en|id
// States: see STATES below, or open /app/?demo=list for an index.
import { cloneTemplate, openDialog, toast, confirmDialog } from './ui.js';
import { applyI18n, setLang, t, tn } from './i18n.js';
import { showPane, openSettings, showConnectionView, setOnboardingStep, setCaptureMethod, openFind } from './app-ui.js';

const $ = (sel, root = document) => root.querySelector(sel);

/* ---------- Fictional sample encounter (not a real patient) ---------- */

const TURNS = [
  ['t1', 'doctor', '00:04', 'Good morning. What brings you in today?'],
  ['t2', 'patient', '00:09', 'For about six weeks my right hand goes numb and tingly at night. Mostly the thumb and the next two fingers.'],
  ['t3', 'patient', '00:21', 'It is worse after a long day of typing. Shaking the hand helps.'],
  ['t4', 'doctor', '00:32', 'Any neck pain, or dropping things?'],
  ['t5', 'patient', '00:37', 'No neck pain. I have not dropped anything.'],
  ['t6', 'doctor', '00:45', 'Are you taking any regular medicines?'],
  ['t7', 'patient', '00:50', 'Just vitamin D, once a day.'],
  ['t8', 'doctor', '01:20', 'Tapping over the wrist brings on the tingling, and holding the wrist flexed brings it on in under a minute. Grip strength is normal, and sensation is a little reduced over the index finger.'],
  ['t9', 'doctor', '01:58', 'This looks most like carpal tunnel syndrome. Let us try a splint at night and arrange a nerve conduction study. Come back in four weeks, or sooner if the hand gets weak.'],
  ['t10', 'patient', '02:14', 'Okay, thank you.'],
];

const NOTE = {
  chief_complaint: [['cc1', 'Night-time numbness and tingling in the right hand for six weeks.', 't2']],
  subjective: [
    ['s1', 'Six weeks of nocturnal numbness and tingling in the right thumb, index and middle fingers.', 't2'],
    ['s2', 'Worse after prolonged typing; relieved by shaking the hand.', 't3'],
    ['s3', 'Denies neck pain and dropping objects.', 't5'],
    ['s4', 'Medication: vitamin D once daily.', 't7'],
    ['s5', 'No history of diabetes.', ''],
  ],
  objective: [
    ['o1', "Tinel's sign positive at the right wrist.", 't8'],
    ['o2', "Phalen's test positive within one minute.", 't8'],
    ['o3', 'Grip strength normal. Mildly reduced sensation over the right index finger.', 't8'],
  ],
  assessment: [['a1', "Clinician's impression: right carpal tunnel syndrome.", 't9']],
  plan: [
    ['p1', 'Night wrist splint.', 't9'],
    ['p2', 'Nerve conduction study to be arranged.', 't9'],
    ['p3', 'Review in four weeks; return sooner if hand weakness develops.', 't9'],
  ],
};

const FLAGS = [
  ['f1', 'Hand dominance was not discussed.', 's1'],
  ['f2', 'Vitamin D dose is not stated.', 's4'],
  ['f3', '"No history of diabetes" has no source in the transcript. Confirm it or remove it.', 's5'],
];

const CONNECTIONS = [
  ['c1', 'OpenAI', 'OpenAI, key kept for this tab', 'ok'],
  ['c2', 'Ollama on this computer', 'http://127.0.0.1:11434/v1', 'untested'],
  ['c3', 'Groq', 'Groq, key remembered on this device', 'error'],
];

const MODELS = [
  ['gpt-4.1-mini', 'text'],
  ['gpt-4.1', 'text'],
  ['gpt-4o-mini-transcribe', 'audio'],
  ['whisper-1', 'audio'],
  ['o4-mini', 'text'],
];

const HISTORY = [
  ['h1', 'Right hand numbness at night (fictional)', '17 Nov 2026, 14:02', '2 min 14 s', 'Neurology'],
  ['h2', 'Follow-up headache review (fictional)', '16 Nov 2026, 10:41', '6 min 05 s', 'General practice'],
  ['h3', 'Dizziness on standing (fictional)', '14 Nov 2026, 16:20', '4 min 48 s', 'Internal medicine'],
];

/* ---------- Renderers (clone the contract templates) ---------- */

function renderTranscript() {
  const list = $('#turns');
  list.replaceChildren();
  TURNS.forEach(([id, speaker, time, text], i) => {
    const li = cloneTemplate('tpl-turn');
    li.dataset.turnId = id;
    li.dataset.speaker = speaker;
    $('.turn__num', li).textContent = String(i + 1);
    $('.turn__speaker', li).value = speaker;
    const timeEl = $('.turn__time', li);
    timeEl.textContent = time;
    timeEl.hidden = false;
    $('.turn__text', li).textContent = text;
    list.append(li);
  });
  const chars = TURNS.reduce((n, turn) => n + turn[3].length, 0);
  $('#transcript-chars').textContent = tn('app.count.chars', chars);
  const duration = $('#transcript-duration');
  duration.textContent = t('app.transcript.duration', { d: '2 min 14 s' });
  duration.hidden = false;
  const count = $('#transcript-turn-count');
  count.textContent = tn('app.count.turns', TURNS.length);
  count.hidden = false;
  $('#transcript').hidden = false;
  $('#capture').hidden = true;
  $('#btn-new-session').hidden = false;
  $('#example-band').hidden = false;
  $('#workspace').dataset.stage = 'transcript';
  applyI18n(list);
}

function turnNumber(id) {
  return String(TURNS.findIndex((turn) => turn[0] === id) + 1);
}

function renderNote() {
  Object.entries(NOTE).forEach(([section, rows]) => {
    const ul = $(`[data-statements="${section}"]`);
    ul.replaceChildren();
    rows.forEach(([id, text, evidence]) => {
      const li = cloneTemplate('tpl-statement');
      li.dataset.statementId = id;
      li.dataset.evidence = evidence;
      li.dataset.grounding = evidence ? 'grounded' : 'unverified';
      $('.statement__text', li).textContent = text;
      const chip = $('button.ev-chip', li);
      chip.dataset.evidence = evidence;
      $('.ev-chip__refs', chip).textContent = evidence.split(' ').filter(Boolean).map(turnNumber).join(', ');
      chip.dataset.tooltip = evidence ? `${t('common.' + TURNS.find((x) => x[0] === evidence)[1])}, ${turnNumber(evidence)}` : '';
      ul.append(li);
    });
    applyI18n(ul);
  });
  const flags = $('#flags-list');
  flags.replaceChildren();
  FLAGS.forEach(([id, text, target]) => {
    const li = cloneTemplate('tpl-flag');
    li.dataset.flagId = id;
    li.dataset.targetStatement = target;
    $('.flag__text', li).textContent = text;
    flags.append(li);
  });
  applyI18n(flags);
  $('#flags-count').textContent = String(FLAGS.length);
  const badge = $('#pane-note-flags');
  badge.textContent = String(FLAGS.length);
  badge.hidden = false;
  const total = Object.values(NOTE).flat();
  const unverified = total.filter((row) => !row[2]).length;
  $('#note-stats').textContent = t('app.note.stats', {
    statements: tn('app.count.statements', total.length),
    linked: total.length - unverified,
    unverified,
  });
  $('#note-provenance').textContent = t('app.note.provenanceExample');
  const tpl = $('#note-template-badge');
  tpl.textContent = t('templates.neurology');
  tpl.hidden = false;
  $('#btn-export').disabled = false;
  $('#note').dataset.state = 'ready';
  $('#workspace').dataset.stage = 'note';
}

function renderConnections() {
  const list = $('#connections-list');
  list.replaceChildren();
  CONNECTIONS.forEach(([id, name, detail, status]) => {
    const li = cloneTemplate('tpl-connection');
    li.dataset.connectionId = id;
    li.dataset.status = status;
    $('.conn-item__name', li).textContent = name;
    $('.conn-item__detail', li).textContent = detail;
    $('.conn-item__status', li).textContent = t({ ok: 'app.conn.statusOk', error: 'app.conn.statusError', untested: 'app.conn.statusUntested' }[status]);
    list.append(li);
  });
  applyI18n(list);
  ['model-transcription-conn', 'model-note-conn'].forEach((sel) => {
    const select = document.getElementById(sel);
    select.replaceChildren(...CONNECTIONS.map(([id, name]) => new Option(name, id)));
  });
  $('#model-transcription-input').value = 'gpt-4o-mini-transcribe';
  $('#model-note-input').value = 'gpt-4.1-mini';
  $('#model-transcription-status').textContent = t('app.models.count', { n: 42 });
  $('#model-note-status').textContent = t('app.models.count', { n: 42 });
}

function renderModelList() {
  const picker = $('#picker-note');
  const list = $('#model-note-list');
  list.replaceChildren();
  MODELS.forEach(([id, kind], i) => {
    const li = cloneTemplate('tpl-model-option');
    li.id = `model-note-opt-${i}`;
    li.dataset.modelId = id;
    $('.combo__option-id', li).textContent = id;
    $('.combo__option-meta', li).textContent = kind;
    if (i === 0) li.setAttribute('aria-selected', 'true');
    list.append(li);
  });
  list.hidden = false;
  const input = $('#model-note-input');
  input.value = 'gpt-4';
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', 'model-note-opt-0');
  picker.dataset.state = 'ready';
}

function renderHistory() {
  const list = $('#history-list');
  list.replaceChildren();
  HISTORY.forEach(([id, title, date, duration, template], i) => {
    const li = cloneTemplate('tpl-history-item');
    li.dataset.sessionId = id;
    if (i === 0) li.classList.add('is-current');
    $('.history-item__title', li).textContent = title;
    $('.history-item__meta', li).textContent = t('app.history.metaLine', { date, duration, template });
    list.append(li);
  });
  applyI18n(list);
  $('#history-retention').textContent = t('app.history.retention', { days: 7 });
}

function setChip(state, label) {
  const chip = $('#connection-chip');
  chip.dataset.state = state;
  $('#connection-chip-label').textContent = label;
}

function setCapture(state, method = 'record') {
  setCaptureMethod(method);
  $('#capture').dataset.state = state;
}

function setMeter(values) {
  const bars = document.querySelectorAll('#rec-meter .meter__bar');
  bars.forEach((bar, i) => bar.style.setProperty('--h', String(values[i % values.length])));
}

const WAVE = [0.12, 0.2, 0.35, 0.5, 0.42, 0.66, 0.8, 0.58, 0.72, 0.9, 0.62, 0.44, 0.7, 0.85, 0.52, 0.38, 0.6, 0.76, 0.5, 0.3, 0.46, 0.68, 0.55, 0.34, 0.26, 0.4, 0.3, 0.2, 0.16, 0.12, 0.1, 0.08];

/* ---------- States ---------- */

const STATES = {
  capture: () => setChip('ok', 'OpenAI'),
  requesting: () => {
    setChip('ok', 'OpenAI');
    setCapture('requesting');
  },
  recording: () => {
    setChip('ok', 'OpenAI');
    setCapture('recording');
    $('#rec-timer').textContent = '04:12';
    setMeter(WAVE);
    $('#rec-segment-hint').textContent = t('app.capture.segmentHint', { min: 10 });
  },
  paused: () => {
    STATES.recording();
    setCapture('paused');
    $('#rec-status-label').textContent = t('app.capture.paused');
    $('#btn-pause').dataset.state = 'resume';
  },
  processing: () => {
    setChip('ok', 'OpenAI');
    setCapture('processing');
    $('#proc-progress-bar').style.setProperty('--value', '43');
    $('#proc-progress').setAttribute('aria-valuenow', '43');
    $('#proc-label').textContent = t('app.proc.segment', { i: 3, n: 7 });
  },
  'capture-error': () => {
    setChip('error', t('app.conn.error'));
    setCapture('error');
    $('#capture-error-message').textContent = t('app.error.auth');
  },
  denied: () => {
    setChip('ok', 'OpenAI');
    setCapture('denied');
  },
  upload: () => {
    setChip('ok', 'OpenAI');
    setCapture('idle', 'upload');
    $('#upload-file').hidden = false;
    $('#upload-file-name').textContent = 'fictional-consultation.m4a';
    $('#upload-file-info').textContent = '3.8 MB, 6 min 12 s';
  },
  'upload-drag': () => {
    setChip('ok', 'OpenAI');
    setCapture('idle', 'upload');
    $('#dropzone').dataset.drag = 'true';
  },
  paste: () => {
    setChip('ok', 'OpenAI');
    setCapture('idle', 'paste');
    const area = $('#paste-input');
    area.value = TURNS.slice(0, 5).map(([, who, , text]) => `${who === 'doctor' ? 'Doctor' : 'Patient'}: ${text}`).join('\n');
    area.dispatchEvent(new Event('input'));
  },
  'no-connection': () => setChip('none', t('app.conn.none')),
  transcript: () => {
    setChip('ok', 'OpenAI');
    renderTranscript();
  },
  find: () => {
    STATES.transcript();
    openFind();
    const input = $('#find-input');
    input.value = 'wrist';
    input.dispatchEvent(new Event('input'));
  },
  generating: () => {
    STATES.transcript();
    $('#note').dataset.state = 'generating';
    $('#gen-status-text').textContent = t('app.note.generating', { model: 'gpt-4.1-mini' });
  },
  note: () => {
    setChip('example', t('app.conn.example'));
    renderTranscript();
    renderNote();
  },
  'note-linked': () => {
    STATES.note();
    const statement = $('.statement[data-statement-id="o2"]');
    statement.classList.add('is-active');
    document.querySelectorAll('.turn[data-turn-id="t8"]').forEach((el) => el.classList.add('is-linked'));
  },
  stale: () => {
    STATES.note();
    $('#note').dataset.stale = 'true';
  },
  regenerating: () => {
    STATES.note();
    $('[data-section="objective"]').dataset.state = 'regenerating';
  },
  'note-error': () => {
    setChip('ok', 'OpenAI');
    renderTranscript();
    $('#note').dataset.state = 'error';
    $('#note-error-message').textContent = t('app.error.output');
  },
  onboarding: () => {
    setChip('none', t('app.conn.none'));
    openDialog('onboarding-dialog');
  },
  'onboarding-2': () => {
    STATES.onboarding();
    setOnboardingStep(2);
    ['ob-model-transcription', 'ob-model-note'].forEach((id, i) => {
      document.getElementById(id).replaceChildren(...MODELS.filter((m) => (i ? m[1] === 'text' : m[1] === 'audio')).map(([m]) => new Option(m, m)));
    });
  },
  'onboarding-3': () => {
    STATES['onboarding-2']();
    setOnboardingStep(3);
  },
  settings: () => {
    setChip('ok', 'OpenAI');
    renderConnections();
    openSettings('general');
  },
  'settings-connections': () => {
    STATES.settings();
    openSettings('connections');
  },
  'settings-connections-empty': () => {
    setChip('none', t('app.conn.none'));
    openSettings('connections');
  },
  'connection-edit': () => {
    STATES['settings-connections']();
    showConnectionView('edit');
    $('#conn-form-title').textContent = t('app.conn.editTitle');
    $('#conn-name').value = 'OpenAI';
    $('#conn-key').value = 'sk-fictional-demo-key-000000000000';
    $('#btn-conn-remove').hidden = false;
  },
  'connection-ok': () => {
    STATES['connection-edit']();
    $('#conn-test-result').dataset.state = 'ok';
    $('#conn-test-message').textContent = t('app.conn.testOk', { n: 42 });
  },
  'connection-testing': () => {
    STATES['connection-edit']();
    $('#conn-test-result').dataset.state = 'testing';
    $('#conn-test-message').textContent = t('app.conn.testing');
  },
  'connection-error': () => {
    STATES['connection-edit']();
    $('#conn-test-result').dataset.state = 'error';
    $('#conn-test-message').textContent = t('app.conn.testFail', { reason: '401, the key was not accepted' });
    $('#conn-key').setAttribute('aria-invalid', 'true');
  },
  'connection-local': () => {
    STATES['settings-connections']();
    showConnectionView('edit');
    $('input[name="conn-preset"][value="local"]').checked = true;
    $('#conn-name').value = 'Ollama on this computer';
    $('#conn-key-field').hidden = true;
    $('#conn-remember-field').hidden = true;
    $('#conn-base-url-field').hidden = false;
    $('#conn-base-url').value = 'http://127.0.0.1:11434/v1';
    $('#conn-privacy-text').textContent = t('app.conn.privacyLocal');
  },
  'settings-models': () => {
    STATES.settings();
    openSettings('models');
    renderModelList();
  },
  'models-error': () => {
    STATES.settings();
    openSettings('models');
    const picker = $('#picker-transcription');
    picker.dataset.state = 'manual';
    $('#model-transcription-error').hidden = false;
    $('#model-transcription-error').textContent = t('app.models.error', { name: 'Groq' });
    $('#model-transcription-status').textContent = t('app.models.manualHint');
  },
  'settings-defaults': () => {
    STATES.settings();
    openSettings('defaults');
  },
  'settings-privacy': () => {
    STATES.settings();
    $('#pref-history').checked = true;
    $('#storage-sessions').textContent = '3';
    $('#storage-keys').textContent = '1';
    openSettings('privacy');
  },
  'settings-access': () => {
    setChip('server', t('app.conn.server'));
    $('#set-tab-access').hidden = false;
    $('#server-mode-note').hidden = false;
    openSettings('access');
  },
  history: () => {
    STATES.note();
    renderHistory();
    $('#history-drawer').dataset.state = 'list';
    openDialog('history-drawer');
  },
  'history-empty': () => {
    $('#history-drawer').dataset.state = 'empty';
    $('#history-retention').textContent = t('app.history.retention', { days: 7 });
    openDialog('history-drawer');
  },
  'history-off': () => {
    $('#history-drawer').dataset.state = 'off';
    openDialog('history-drawer');
  },
  shortcuts: () => {
    STATES.note();
    openDialog('shortcuts-dialog');
  },
  confirm: () => {
    STATES.note();
    confirmDialog({
      title: t('app.confirm.deleteAll.title'),
      message: t('app.confirm.deleteAll.message'),
      confirmLabel: t('app.confirm.deleteAll.ok'),
      tone: 'danger',
    });
  },
  toast: () => {
    STATES.note();
    toast(t('app.toast.copied'), { tone: 'success', duration: 0 });
    toast(t('app.toast.sessionDeleted'), { duration: 0, action: { label: t('common.undo'), onClick: () => {} } });
    toast(t('app.error.rateLimit'), { tone: 'error' });
  },
  unsupported: () => {
    document.getElementById('unsupported').hidden = false;
    $('#unsupported-detail').textContent = t('app.unsupported.missing', { features: 'MediaRecorder, dialog element' });
    document.querySelector('.app-header').hidden = true;
    document.getElementById('workspace').hidden = true;
  },
};

function renderIndex() {
  const main = document.getElementById('workspace');
  const box = document.createElement('div');
  box.className = 'callout';
  const list = document.createElement('ul');
  list.className = 'demo-index';
  Object.keys(STATES).forEach((name) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `?demo=${name}`;
    a.textContent = name;
    li.append(a);
    list.append(li);
  });
  box.append(list);
  main.prepend(box);
}

/** Entry point called by app-ui.js. */
export function runDemo(name) {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  const lang = params.get('lang');
  if (lang === 'en' || lang === 'id') setLang(lang);
  if (name === 'list') {
    renderIndex();
    return;
  }
  const fn = STATES[name];
  if (!fn) {
    console.warn(`[demo] unknown state "${name}". Try ?demo=list`);
    return;
  }
  fn();
  if (params.get('pane') === 'note') showPane('note');
  document.documentElement.dataset.demo = name;
}
