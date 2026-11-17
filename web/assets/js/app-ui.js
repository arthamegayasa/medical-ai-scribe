// Workspace UI layer: wires generic primitives and presentational behaviour to the app shell.
// It never calls providers, records audio, stores clinical content or generates notes.
// The wiring layer listens for the 'ui:*' events documented in web/app/UI-CONTRACT.md.
import { initUI, openDialog, selectTab, registerShortcut, toast, announce, closeMenus } from './ui.js';
import { initI18n, setLang, getLang, onLangChange, t } from './i18n.js';
import { getTheme, setTheme, toggleTheme, resolvedTheme, onThemeChange } from './theme.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const emit = (target, name, detail = {}) => target.dispatchEvent(new CustomEvent(name, { bubbles: true, cancelable: true, detail }));
const narrow = window.matchMedia('(max-width: 960px)');

/* ---------------- Theme and language controls ---------------- */

function syncThemeControls() {
  const resolved = resolvedTheme();
  $$('[data-action="toggle-theme"]').forEach((btn) => {
    btn.setAttribute('aria-label', t(resolved === 'dark' ? 'common.themeToLight' : 'common.themeToDark'));
  });
  const radio = $(`input[name="theme"][value="${getTheme()}"]`);
  if (radio) radio.checked = true;
}

function syncLangControls() {
  const radio = $(`input[name="ui-lang"][value="${getLang()}"]`);
  if (radio) radio.checked = true;
}

function initPreferences() {
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="toggle-theme"]')) toggleTheme();
  });
  document.addEventListener('change', (event) => {
    if (event.target.matches('input[name="theme"]')) setTheme(event.target.value);
    if (event.target.matches('input[name="ui-lang"]')) setLang(event.target.value);
  });
  onThemeChange(syncThemeControls);
  onLangChange(() => {
    syncThemeControls();
    syncLangControls();
  });
  syncThemeControls();
  syncLangControls();
}

/* ---------------- Settings dialog ---------------- */

/** Open Settings at a section: general | connections | models | defaults | privacy | access */
export function openSettings(section = 'general') {
  const dialog = document.getElementById('settings-dialog');
  if (!dialog) return;
  openDialog(dialog);
  const tab = $(`[data-settings-tab="${section}"]`, dialog);
  if (tab && !tab.hidden) selectTab(tab, { focus: true });
}

/** Switch the Connections panel between its list and its add/edit form. */
export function showConnectionView(view) {
  const panel = document.getElementById('set-connections');
  if (!panel) return;
  panel.dataset.view = view;
  if (view === 'edit') $('#conn-name')?.focus();
  else $('#btn-add-connection')?.focus();
}

function initSettings() {
  document.addEventListener('click', (event) => {
    const opener = event.target.closest('[data-open-settings]');
    if (opener) {
      openSettings(opener.dataset.openSettings);
      return;
    }
    if (event.target.closest('#btn-add-connection')) {
      const form = document.getElementById('connection-form');
      form?.reset();
      $('#conn-form-title').textContent = t('app.conn.addTitle');
      $('#btn-conn-remove').hidden = true;
      const result = document.getElementById('conn-test-result');
      if (result) result.dataset.state = 'idle';
      $('#conn-test-message').textContent = '';
      showConnectionView('edit');
      emit(form, 'ui:connection-new');
    }
    if (event.target.closest('#btn-conn-back, #btn-conn-cancel')) showConnectionView('list');
  });
}

/* ---------------- Panes, stepper, capture method ---------------- */

/** @param {'source'|'note'} pane */
export function showPane(pane) {
  const ws = document.getElementById('workspace');
  if (!ws) return;
  ws.dataset.pane = pane;
  $$('[data-pane-target]').forEach((btn) => {
    const selected = btn.dataset.paneTarget === pane;
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
  });
}

const STAGES = ['capture', 'transcript', 'note'];

function syncStepper() {
  const ws = document.getElementById('workspace');
  const stage = ws?.dataset.stage || 'capture';
  const index = STAGES.indexOf(stage);
  $$('[data-stage-step]').forEach((step) => {
    const i = STAGES.indexOf(step.dataset.stageStep);
    step.classList.toggle('is-done', i < index);
    if (i === index) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
}

/** Switch the capture method tab (record | upload | paste). Resets error/denied to idle. */
export function setCaptureMethod(method) {
  const capture = document.getElementById('capture');
  const tab = $(`[role="tab"][data-capture-method="${method}"]`);
  if (!capture || !tab) return;
  if (tab.getAttribute('aria-selected') !== 'true') selectTab(tab);
  capture.dataset.method = method;
  if (capture.dataset.state === 'error' || capture.dataset.state === 'denied') capture.dataset.state = 'idle';
}

function initWorkspace() {
  const ws = document.getElementById('workspace');
  if (!ws) return;
  document.addEventListener('click', (event) => {
    const paneBtn = event.target.closest('[data-pane-target]');
    if (paneBtn) showPane(paneBtn.dataset.paneTarget);
    const methodBtn = event.target.closest('[data-capture-method]:not([role="tab"])');
    if (methodBtn) {
      setCaptureMethod(methodBtn.dataset.captureMethod);
      $(`[role="tab"][data-capture-method="${methodBtn.dataset.captureMethod}"]`)?.focus();
    }
  });
  document.addEventListener('ui:tabchange', (event) => {
    const method = event.detail.tab.dataset.captureMethod;
    if (method) {
      const capture = document.getElementById('capture');
      capture.dataset.method = method;
      if (capture.dataset.state === 'error' || capture.dataset.state === 'denied') capture.dataset.state = 'idle';
      emit(capture, 'ui:capture-method', { method });
    }
  });
  new MutationObserver(syncStepper).observe(ws, { attributes: true, attributeFilter: ['data-stage'] });
  syncStepper();
}

/* ---------------- Evidence links ---------------- */

function turnsFor(ids) {
  return String(ids || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.querySelector(`.turn[data-turn-id="${CSS.escape(id)}"]`))
    .filter(Boolean);
}

function clearLinks() {
  $$('.turn.is-linked').forEach((el) => el.classList.remove('is-linked'));
  $$('.statement.is-active').forEach((el) => el.classList.remove('is-active'));
}

function linkStatement(statement) {
  clearLinks();
  if (!statement) return;
  statement.classList.add('is-active');
  turnsFor(statement.dataset.evidence).forEach((turn) => turn.classList.add('is-linked'));
}

/** Reveal a statement's source turns: switches pane on small screens, scrolls and flashes. */
export function revealEvidence(statement) {
  const turns = turnsFor(statement?.dataset.evidence);
  if (!turns.length) return;
  if (narrow.matches) {
    showPane('source');
    toast(t('app.toast.showingSource'), {
      action: {
        label: t('app.toast.backToDraft'),
        onClick: () => {
          showPane('note');
          statement.scrollIntoView({ block: 'center' });
          $('.ev-chip', statement)?.focus();
        },
      },
    });
  }
  linkStatement(statement);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  turns[0].scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  turns.forEach((turn) => {
    turn.classList.remove('is-flash');
    void turn.offsetWidth;
    turn.classList.add('is-flash');
  });
  const first = turns[0];
  const who = $('.turn__speaker', first)?.selectedOptions?.[0]?.textContent || '';
  announce(t('app.evidence.announce', { n: turns.map((el) => $('.turn__num', el)?.textContent).join(', '), who, text: $('.turn__text', first)?.textContent || '' }));
}

/** Scroll to a statement by id and highlight it (used by review flags). */
export function revealStatement(statementId) {
  const statement = document.querySelector(`.statement[data-statement-id="${CSS.escape(statementId)}"]`);
  if (!statement) return;
  if (narrow.matches) showPane('note');
  statement.scrollIntoView({ block: 'center' });
  statement.classList.add('is-target');
  setTimeout(() => statement.classList.remove('is-target'), 2000);
  $('.statement__text', statement)?.focus();
}

function initEvidence() {
  const sheet = document.getElementById('note-sheet');
  if (!sheet) return;
  sheet.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    const statement = event.target.closest('.statement');
    if (statement) linkStatement(statement);
  });
  sheet.addEventListener('pointerleave', () => {
    if (!sheet.contains(document.activeElement)) clearLinks();
  });
  sheet.addEventListener('focusin', (event) => {
    linkStatement(event.target.closest('.statement'));
  });
  sheet.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!sheet.contains(document.activeElement)) clearLinks();
    }, 0);
  });
  sheet.addEventListener('click', (event) => {
    const chip = event.target.closest('button.ev-chip');
    if (chip) revealEvidence(chip.closest('.statement'));
  });
  document.addEventListener('click', (event) => {
    const go = event.target.closest('[data-action="go-to-statement"]');
    if (go) revealStatement(go.closest('.flag')?.dataset.targetStatement);
  });
  document.addEventListener('change', (event) => {
    if (!event.target.matches('.flag__resolve')) return;
    const flag = event.target.closest('.flag');
    flag.dataset.resolved = String(event.target.checked);
    emit(flag, 'ui:flag-resolved', { id: flag.dataset.flagId, resolved: event.target.checked });
  });
}

/* ---------------- Transcript: speakers toggle, find ---------------- */

function clearFind() {
  $$('mark.find-hit').forEach((mark) => {
    const parent = mark.parentNode;
    mark.replaceWith(document.createTextNode(mark.textContent));
    parent.normalize();
  });
}

let findIndex = 0;

function runFind(query) {
  clearFind();
  const count = $('#find-count');
  const plain = document.getElementById('transcript')?.dataset.mode === 'plain';
  if (!query) {
    count.textContent = '';
    return [];
  }
  if (plain) {
    const area = document.getElementById('transcript-plain');
    const hay = area.value.toLowerCase();
    const positions = [];
    let at = hay.indexOf(query.toLowerCase());
    while (at !== -1) {
      positions.push(at);
      at = hay.indexOf(query.toLowerCase(), at + query.length);
    }
    count.textContent = positions.length ? t('app.find.count', { i: Math.min(findIndex + 1, positions.length), n: positions.length }) : t('app.find.none');
    return positions;
  }
  const needle = query.toLowerCase();
  const hits = [];
  $$('#turns .turn__text').forEach((p) => {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      let text = node.nodeValue;
      let idx = text.toLowerCase().indexOf(needle);
      let current = node;
      while (idx !== -1) {
        const match = current.splitText(idx);
        const rest = match.splitText(needle.length);
        const mark = document.createElement('mark');
        mark.className = 'find-hit';
        match.replaceWith(mark);
        mark.append(match);
        hits.push(mark);
        current = rest;
        text = rest.nodeValue;
        idx = text.toLowerCase().indexOf(needle);
      }
    });
  });
  count.textContent = hits.length ? t('app.find.count', { i: Math.min(findIndex + 1, hits.length), n: hits.length }) : t('app.find.none');
  return hits;
}

function focusHit(step) {
  const query = $('#find-input').value;
  const hits = runFind(query);
  if (!hits.length) return;
  findIndex = (findIndex + step + hits.length) % hits.length;
  const fresh = runFind(query);
  if (document.getElementById('transcript')?.dataset.mode === 'plain') {
    const area = document.getElementById('transcript-plain');
    area.focus();
    area.setSelectionRange(fresh[findIndex], fresh[findIndex] + query.length);
    $('#find-input').focus();
    return;
  }
  fresh[findIndex].classList.add('is-current');
  fresh[findIndex].scrollIntoView({ block: 'center' });
}

export function openFind() {
  const bar = document.getElementById('find-bar');
  const transcript = document.getElementById('transcript');
  if (!bar || transcript?.hidden) return false;
  bar.hidden = false;
  $('#btn-find').setAttribute('aria-expanded', 'true');
  $('#find-input').focus();
  $('#find-input').select();
  return true;
}

export function closeFind() {
  const bar = document.getElementById('find-bar');
  if (!bar) return;
  bar.hidden = true;
  $('#btn-find').setAttribute('aria-expanded', 'false');
  clearFind();
  $('#find-count').textContent = '';
  $('#btn-find').focus();
}

function initTranscript() {
  const transcript = document.getElementById('transcript');
  if (!transcript) return;
  $('#toggle-speakers')?.addEventListener('change', (event) => {
    transcript.dataset.speakers = event.target.checked ? 'on' : 'off';
    emit(transcript, 'ui:speakers', { on: event.target.checked });
  });
  $('#btn-find')?.addEventListener('click', () => {
    if (document.getElementById('find-bar').hidden) openFind();
    else closeFind();
  });
  $('#btn-find-close')?.addEventListener('click', closeFind);
  $('#btn-find-next')?.addEventListener('click', () => focusHit(1));
  $('#btn-find-prev')?.addEventListener('click', () => focusHit(-1));
  const input = $('#find-input');
  input?.addEventListener('input', () => {
    findIndex = 0;
    const hits = runFind(input.value);
    if (hits[0] instanceof Element) {
      hits[0].classList.add('is-current');
      hits[0].scrollIntoView({ block: 'nearest' });
    }
  });
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      focusHit(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeFind();
    }
  });
  // Typing in a turn invalidates marks; clear them so edits read cleanly.
  $('#turns')?.addEventListener('input', () => {
    if ($('mark.find-hit')) clearFind();
  });
}

/* ---------------- Capture helpers: drag and drop, paste count ---------------- */

function initCapture() {
  const zone = document.getElementById('dropzone');
  if (zone) {
    let depth = 0;
    zone.addEventListener('dragenter', (event) => {
      event.preventDefault();
      depth += 1;
      zone.dataset.drag = 'true';
    });
    zone.addEventListener('dragover', (event) => event.preventDefault());
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) zone.dataset.drag = 'false';
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      depth = 0;
      zone.dataset.drag = 'false';
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) emit(zone, 'ui:file-drop', { files });
    });
    // Stop a missed drop from navigating away from the workspace.
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());
  }
  const paste = document.getElementById('paste-input');
  if (paste) {
    const sync = () => {
      const n = paste.value.length;
      $('#paste-count').textContent = t(n === 1 ? 'app.count.chars.one' : 'app.count.chars.other', { n: n.toLocaleString() });
      $('#btn-use-paste').disabled = paste.value.trim().length === 0;
    };
    paste.addEventListener('input', sync);
    onLangChange(sync);
    sync();
  }
}

/* ---------------- Onboarding navigation ---------------- */

/** Set the onboarding step (1 to 3). Emits a cancelable 'ui:onboarding-step' first. */
export function setOnboardingStep(step) {
  const dialog = document.getElementById('onboarding-dialog');
  if (!dialog) return;
  const from = Number(dialog.dataset.step || 1);
  const to = Math.max(1, Math.min(3, step));
  if (from === to) return;
  if (!emit(dialog, 'ui:onboarding-step', { from, to })) return;
  dialog.dataset.step = String(to);
  $$('[data-ob-dot]', dialog).forEach((dot) => {
    if (Number(dot.dataset.obDot) === to) dot.setAttribute('aria-current', 'step');
    else dot.removeAttribute('aria-current');
  });
  const title = $(`#ob-title [data-ob-step="${to}"]`, dialog);
  announce(title?.textContent || '');
  $(`.ob-step[data-ob-step="${to}"] input, .ob-step[data-ob-step="${to}"] select, .ob-step[data-ob-step="${to}"] button`, dialog)?.focus();
}

function initOnboarding() {
  const dialog = document.getElementById('onboarding-dialog');
  if (!dialog) return;
  dialog.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-ob-nav]');
    if (!nav) return;
    const step = Number(dialog.dataset.step || 1);
    setOnboardingStep(nav.dataset.obNav === 'next' ? step + 1 : step - 1);
  });
}

/* ---------------- History search (filters rendered rows) ---------------- */

function initHistorySearch() {
  const input = document.getElementById('history-search');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    $$('#history-list .history-item').forEach((item) => {
      const match = !q || item.textContent.toLowerCase().includes(q);
      item.hidden = !match;
      if (match) shown += 1;
    });
    document.getElementById('history-nomatch').hidden = shown > 0 || !q;
  });
}

/* ---------------- Shortcuts ---------------- */

function clickIfUsable(selector) {
  const el = document.querySelector(selector);
  if (!el || el.disabled || el.closest('[hidden]') || el.offsetParent === null) return false;
  el.click();
  return true;
}

function initShortcutsMap() {
  registerShortcut('?', () => openDialog('shortcuts-dialog'));
  registerShortcut('h', () => openDialog('history-drawer'));
  registerShortcut(',', () => openSettings('general'));
  registerShortcut('alt+1', () => showPane('source'), { allowInInputs: true });
  registerShortcut('alt+2', () => showPane('note'), { allowInInputs: true });
  // Only intercept the browser's own find when a transcript is on screen.
  registerShortcut('mod+f', () => openFind(), { when: () => !document.getElementById('transcript')?.hidden });
  registerShortcut('r', () => {
    const state = document.getElementById('capture')?.dataset.state;
    if (state === 'recording' || state === 'paused') clickIfUsable('#btn-stop');
    else clickIfUsable('#btn-record');
  });
  registerShortcut('space', () => clickIfUsable('#btn-pause'), {
    when: () => ['recording', 'paused'].includes(document.getElementById('capture')?.dataset.state),
  });
  registerShortcut('mod+enter', () => clickIfUsable('#btn-generate'));
  registerShortcut('mod+shift+c', () => clickIfUsable('[data-export="copy"]') || document.querySelector('[data-export="copy"]')?.click(), {
    when: () => document.getElementById('note')?.dataset.state === 'ready',
  });
}

/* ---------------- Boot ---------------- */

// Forms in the workspace never navigate: a default GET submit would put keys or tokens
// in the URL. Wiring listens for the normal 'submit' event (it still fires).
function guardForms() {
  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target;
      if (form.getAttribute('method') === 'dialog') return;
      event.preventDefault();
    },
    true,
  );
}

function boot() {
  guardForms();
  initUI();
  initI18n();
  initPreferences();
  initSettings();
  initWorkspace();
  initEvidence();
  initTranscript();
  initCapture();
  initOnboarding();
  initHistorySearch();
  initShortcutsMap();
  narrow.addEventListener('change', () => closeMenus());

  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    // The design-review harness exists only in local development (lib/publish.js keeps it out of
    // the production build). Without it, hand the page back to the normal workspace.
    import('./demo-states.js')
      .then((mod) => mod.runDemo(params.get('demo') || 'note'))
      .catch(() => {
        document.documentElement.dataset.demoHarness = 'missing';
        document.dispatchEvent(new CustomEvent('ui:demo-unavailable'));
      });
  }
  document.dispatchEvent(new CustomEvent('ui:ready'));
}

boot();
