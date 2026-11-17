// SOAP draft: streamed generation, evidence chips linked to transcript spans (and back),
// grounded / close-match / edited / clinician-entered / unverified and check-number markers from
// the engine verifier plus statement provenance (re-run on every edit),
// review flags, editing, per-section rewrite, stale detection and provenance.
import * as core from '../../../core/index.js';
import { SECTIONS } from '../../../core/soap/schema.js';
import { LANGUAGES } from '../../../core/soap/prompt.js';
import { t, tn, getLang, onLangChange, applyI18n } from '../i18n.js';
import { cloneTemplate, confirmDialog, toast, announce } from '../ui.js';
import { showPane } from '../app-ui.js';
import { buildSource } from './transcript.js';
import { fromEngineNote, itemsFromEngine, toEngineNote, annotate, applyProvenance, openFlagCount, newStatementId } from './note.js';
import { describeError, AppError } from './messages.js';
import { exampleData } from './example.js';
import { templateLabel, languageLabel, providerLabel, formatDateTime } from './format.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const SECTION_KEYS = { chief_complaint: 'soap.chiefComplaint', subjective: 'soap.subjective', objective: 'soap.objective', assessment: 'soap.assessment', plan: 'soap.plan' };
const narrow = window.matchMedia('(max-width: 960px)');
const highlightSupported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof window.Highlight === 'function';

export function initNote(ctx) {
  const { store, services } = ctx;
  const noteEl = $('#note');
  const sheet = $('#note-sheet');
  const stream = $('#note-stream');
  let generateController = null;
  let sectionController = null;
  let view = null;       // { statements, flags, summary } from annotate()
  let verification = null;
  let engineNote = null; // last valid engine note for export
  let verifyTimer = 0;

  // ---------- Derived data ----------
  function source() {
    const { session } = store.getState();
    return buildSource(session.turns, { speakers: session.speakersOn });
  }

  function isStale(state = store.getState()) {
    const { session } = state;
    if (!session.note || !session.meta) return false;
    return core.hashText(source().text.trim()) !== session.meta.transcriptHash;
  }

  function verify() {
    const { session } = store.getState();
    if (!session.note) { view = null; verification = null; engineNote = null; return; }
    const language = session.meta?.language || 'en';
    const { note, positions } = toEngineNote(session.note, language);
    const { text, ranges } = source();
    engineNote = note;
    verification = applyProvenance(session.note, core.verifyNote(note, text), positions);
    view = annotate(session.note, verification, positions, ranges);
  }

  ctx.exportInput = () => {
    verify();
    const { session } = store.getState();
    if (!engineNote || !session.meta) return null;
    return { note: engineNote, meta: session.meta, verification, transcriptChanged: isStale(), fictional: session.fictional };
  };

  // ---------- Rendering ----------
  function turnInfo() {
    const { session } = store.getState();
    return new Map(session.turns.map((turn, i) => [turn.id, { n: i + 1, speaker: turn.speaker }]));
  }

  function statementRow(section, item) {
    const li = cloneTemplate('tpl-statement');
    li.dataset.statementId = item.id;
    li.dataset.section = section;
    $('.statement__text', li).textContent = item.text;
    applyI18n(li);
    return li;
  }

  function renderSection(section) {
    const { session } = store.getState();
    const ul = $(`[data-statements="${section}"]`);
    ul.replaceChildren(...(session.note?.sections[section] || []).map((item) => statementRow(section, item)));
    // An empty section reads exactly as it will be exported: "not documented" in the note language.
    ul.dataset.empty = (LANGUAGES[session.meta?.language] || LANGUAGES.en).notDocumented;
  }

  // Short label, long label and icon of the review chip for each status that is not plainly grounded.
  const STATUS_CHIP = {
    unverified: ['note.unverified', 'note.unverifiedLong', 'i-unverified'],
    approximate: ['note.approximate', 'note.approximateLong', 'i-alert'],
    edited: ['note.edited', 'note.editedLong', 'i-edit'],
    clinician: ['note.clinician', 'note.clinicianLong', 'i-user'],
  };

  function renderMarks() {
    const info = turnInfo();
    for (const li of $$('.statement', sheet)) {
      const result = view?.statements.get(li.dataset.statementId) || { status: 'none', turnIds: [], numberIssues: [] };
      li.dataset.grounding = result.status;
      const [short, long, icon] = STATUS_CHIP[result.status] || STATUS_CHIP.unverified;
      const review = $('.ev-chip--unverified', li);
      $('use', review)?.setAttribute('href', `/assets/icons/sprite.svg#${icon}`);
      const label = $('[data-i18n]', review);
      // Keep the i18n hooks in step so a language switch re-renders the right words.
      label.dataset.i18n = short;
      label.textContent = t(short);
      review.dataset.i18nAttr = `aria-label:${long}`;
      review.setAttribute('aria-label', t(long)); // the tooltip falls back to the aria-label
      li.dataset.evidence = result.turnIds.join(' ');
      const chip = $('button.ev-chip', li);
      chip.dataset.evidence = li.dataset.evidence;
      const refs = result.turnIds.map((id) => info.get(id)).filter(Boolean);
      $('.ev-chip__refs', chip).textContent = refs.map((r) => r.n).join(', ');
      chip.dataset.tooltip = refs.map((r) => `${t(r.speaker === 'unknown' ? 'common.unlabelled' : `common.${r.speaker}`)}, ${r.n}`).join('; ');
      let numbers = $('.ev-chip--number', li);
      if (result.numberIssues.length) {
        if (!numbers) {
          numbers = document.createElement('span');
          numbers.className = 'ev-chip ev-chip--number';
          numbers.tabIndex = 0;
          numbers.setAttribute('role', 'note');
          $('.statement__marks', li).prepend(numbers);
        }
        numbers.textContent = t('note.checkNumber');
        const label = t('note.checkNumberLong', { numbers: result.numberIssues.join(', ') });
        numbers.setAttribute('aria-label', label);
        numbers.dataset.tooltip = label;
      } else numbers?.remove();
    }
    renderFlags();
    renderFooter();
  }

  function renderFlags() {
    const { session } = store.getState();
    const flags = session.note?.flags || [];
    const list = $('#flags-list');
    list.replaceChildren(...flags.map((flag) => {
      const li = cloneTemplate('tpl-flag');
      li.dataset.flagId = flag.id;
      li.dataset.targetStatement = view?.flags.get(flag.id)?.target || '';
      li.dataset.resolved = String(flag.resolved);
      li.dataset.flagType = flag.type;
      $('.flag__resolve', li).checked = flag.resolved;
      $('.flag__text', li).textContent = flag.text;
      const go = $('.flag__go', li);
      const turns = view?.flags.get(flag.id)?.turnIds || [];
      go.hidden = !li.dataset.targetStatement && !turns.length;
      if (!li.dataset.targetStatement) go.dataset.action = 'go-to-turn';
      go.dataset.turns = turns.join(' ');
      applyI18n(li);
      return li;
    }));
    const open = openFlagCount(session.note);
    $('#flags-count').textContent = String(open);
    $('#flags-none').hidden = open > 0;
    const badge = $('#pane-note-flags');
    badge.textContent = String(open);
    badge.hidden = !session.note || open === 0;
  }

  function renderFooter() {
    const { session } = store.getState();
    if (!session.note) return;
    const summary = view?.summary || { statements: 0, grounded: 0, approximate: 0, unverified: 0, edited: 0 };
    // "To check": every AI line that is not grounded (unverified, close match or edited).
    const toCheck = summary.unverified + summary.approximate + summary.edited;
    $('#note-stats').textContent = t('app.note.stats', { statements: tn('app.count.statements', summary.statements), linked: summary.grounded, unverified: toCheck });
    const meta = session.meta;
    if (meta?.provider === 'example') $('#note-provenance').textContent = t('app.note.provenanceExample');
    else if (meta) {
      $('#note-provenance').textContent = t('app.note.provenance', {
        time: formatDateTime(meta.generatedAt, getLang()), model: meta.model, provider: providerLabel(meta.provider),
        template: templateLabel(meta.template), language: languageLabel(meta.language),
      });
    }
    const badge = $('#note-template-badge');
    badge.hidden = !meta;
    if (meta) badge.textContent = templateLabel(meta.template);
  }

  function renderAll() {
    SECTIONS.forEach(renderSection);
    verify();
    renderMarks();
    renderState();
  }

  function renderState() {
    const state = store.getState();
    const { noteState, session } = state;
    noteEl.dataset.state = noteState.state;
    noteEl.dataset.stale = String(isStale(state) && !session.staleDismissed);
    $('#btn-export').disabled = noteState.state !== 'ready' || !session.note;
    for (const section of SECTIONS) {
      const el = $(`.note-section[data-section="${section}"]`);
      const regenerating = noteState.regenerating === section;
      el.dataset.state = regenerating ? 'regenerating' : 'idle';
      const button = $('[data-action="regenerate-section"]', el);
      if (button) {
        button.disabled = Boolean(noteState.regenerating && !regenerating);
        const label = t(regenerating ? 'app.section.cancelRewrite' : `app.section.regen${{ subjective: 'S', objective: 'O', assessment: 'A', plan: 'P' }[section]}`);
        button.setAttribute('aria-label', label);
        button.dataset.regenerating = String(regenerating);
      }
    }
    if (noteState.state === 'error' && noteState.error) {
      $('#note-error-message').textContent = noteState.error.text;
    }
  }

  // ---------- Streaming preview ----------
  function renderStream(partial) {
    if (!partial || typeof partial !== 'object') return;
    const nodes = [];
    for (const section of SECTIONS) {
      const items = Array.isArray(partial[section]) ? partial[section].filter((item) => item && typeof item.text === 'string' && item.text.trim()) : [];
      if (!items.length) continue;
      const block = document.createElement('section');
      block.className = 'note-section';
      const head = document.createElement('h3');
      head.className = 'note-section__title';
      head.textContent = t(SECTION_KEYS[section]);
      const ul = document.createElement('ul');
      ul.className = 'statements';
      for (const item of items) {
        const li = document.createElement('li');
        li.className = 'statement statement--streaming';
        const p = document.createElement('p');
        p.className = 'statement__text';
        p.textContent = item.text;
        li.append(p);
        ul.append(li);
      }
      block.append(head, ul);
      nodes.push(block);
    }
    if (!nodes.length) return;
    stream.replaceChildren(...nodes);
    stream.hidden = false;
    $('.skeleton-sheet').hidden = true;
  }

  function resetStream() {
    stream.replaceChildren();
    stream.hidden = true;
    $('.skeleton-sheet').hidden = false;
  }

  // ---------- Generation ----------
  function errorFor(error, role = 'note') {
    const { key, vars } = describeError(error, services.errorContext(role));
    return { text: t(key, vars), code: error?.code || error?.appCode || 'unexpected' };
  }

  async function generate({ confirmEdits = true } = {}) {
    if (generateController) return;
    const state = store.getState();
    const { session, prefs } = state;
    const { text } = source();
    if (text.trim().length < core.TRANSCRIPT_LIMITS.minChars) {
      store.dispatch({ type: 'note/error', error: errorFor(new AppError('shortTranscript')) });
      return;
    }
    // The fictional example never calls a model while its transcript is unchanged.
    if (session.fictional) {
      const example = exampleData(session.meta?.language || getLang());
      if (core.hashText(text.trim()) === example.meta.transcriptHash && (!services.hasTarget('note') || !session.edited)) {
        store.dispatch({ type: 'note/ready', note: fromEngineNote(example.note), meta: example.meta, fictional: true });
        return;
      }
    }
    if (confirmEdits && session.note && session.edited) {
      const ok = await confirmDialog({ title: t('app.confirm.regenerate.title'), message: t('app.confirm.regenerate.message'), confirmLabel: t('app.confirm.regenerate.ok') });
      if (!ok) return;
    }
    let modelName = '';
    try { modelName = services.target('note').model || ''; } catch (error) {
      store.dispatch({ type: 'note/error', error: errorFor(error) });
      if (narrow.matches) showPane('note');
      return;
    }
    generateController = new AbortController();
    const { signal } = generateController;
    resetStream();
    $('#gen-status-text').textContent = t('app.note.generating', { model: modelName || t('app.conn.server') });
    store.dispatch({ type: 'note/generating', template: prefs.template, language: prefs.noteLanguage });
    if (narrow.matches) showPane('note');
    announce(t('app.note.generating', { model: modelName }));
    try {
      const result = await services.generateNote({
        transcript: text, language: prefs.noteLanguage, template: prefs.template, signal,
        onPartial: ({ partial }) => { if (!signal.aborted) renderStream(partial); },
      });
      if (signal.aborted) throw new core.ScribeError('aborted');
      store.dispatch({ type: 'note/ready', note: fromEngineNote(result.note), meta: result.meta, fictional: store.getState().session.fictional });
      announce(t('app.note.ready'));
    } catch (error) {
      if (error?.code === 'aborted') {
        store.dispatch({ type: 'note/cancelled' });
        toast(t('app.toast.cancelled'));
      } else {
        store.dispatch({ type: 'note/error', error: errorFor(error) });
        announce(errorFor(error).text, { assertive: true });
      }
    } finally {
      generateController = null;
      resetStream();
      renderState();
    }
  }

  async function regenerate(section) {
    const state = store.getState();
    if (state.noteState.regenerating === section) { sectionController?.abort(); return; }
    if (sectionController || generateController || !state.session.note) return;
    const { text } = source();
    const language = state.session.meta?.language || state.prefs.noteLanguage;
    const template = state.session.meta?.template || state.prefs.template;
    try { services.target('note'); } catch (error) { toast(errorFor(error).text, { tone: 'error' }); return; }
    sectionController = new AbortController();
    const { signal } = sectionController;
    const ul = $(`[data-statements="${section}"]`);
    store.dispatch({ type: 'section/regenerating', section });
    announce(t('app.section.regenerating', { section: t(SECTION_KEYS[section]) }));
    try {
      const { note } = toEngineNote(state.session.note, language);
      const result = await services.regenerateSection({
        transcript: text, note, section, language, template, signal,
        onPartial: ({ partial }) => {
          const items = Array.isArray(partial?.items) ? partial.items.filter((item) => item && typeof item.text === 'string' && item.text.trim()) : [];
          if (!items.length || signal.aborted) return;
          ul.replaceChildren(...items.map((item) => {
            const li = document.createElement('li');
            li.className = 'statement statement--streaming';
            const p = document.createElement('p');
            p.className = 'statement__text';
            p.textContent = item.text;
            li.append(p);
            return li;
          }));
        },
      });
      if (signal.aborted) throw new core.ScribeError('aborted');
      store.dispatch({ type: 'section/replace', section, items: itemsFromEngine(result.items) });
      announce(t('app.section.done', { section: t(SECTION_KEYS[section]) }));
    } catch (error) {
      store.dispatch({ type: 'section/done' });
      renderSection(section);
      renderMarks();
      if (error?.code === 'aborted') toast(t('app.toast.cancelled'));
      else toast(`${t('app.section.failed', { section: t(SECTION_KEYS[section]) })} ${errorFor(error).text}`, { tone: 'error' });
    } finally {
      sectionController = null;
      renderState();
    }
  }

  // ---------- Evidence highlighting (statement -> transcript span, and back) ----------
  function textRange(turnEl, start, end) {
    const host = $('.turn__text', turnEl);
    if (!host) return null;
    const full = host.textContent;
    const lead = full.length - full.trimStart().length;
    let from = start + lead;
    let to = end + lead;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0;
    let started = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const length = node.nodeValue.length;
      if (!started && from <= offset + length) { range.setStart(node, Math.max(0, from - offset)); started = true; }
      if (started && to <= offset + length) { range.setEnd(node, Math.max(0, to - offset)); return range; }
      offset += length;
    }
    return started ? (range.setEnd(host, host.childNodes.length), range) : null;
  }

  function highlightPieces(pieces) {
    if (!highlightSupported) return;
    if (!pieces.length) { CSS.highlights.delete('scribe-evidence'); return; }
    const ranges = [];
    for (const piece of pieces) {
      const turn = document.querySelector(`.turn[data-turn-id="${CSS.escape(piece.id)}"]`);
      const range = turn && textRange(turn, piece.start, piece.end);
      if (range) ranges.push(range);
    }
    CSS.highlights.set('scribe-evidence', new Highlight(...ranges));
  }

  function linkFromStatement(statement) {
    const result = statement && view?.statements.get(statement.dataset.statementId);
    highlightPieces(result?.pieces || []);
  }

  function linkFromTurn(turnEl) {
    $$('.statement.is-cited').forEach((el) => el.classList.remove('is-cited'));
    if (!turnEl || !view) { highlightPieces([]); return; }
    const id = turnEl.dataset.turnId;
    const pieces = [];
    for (const li of $$('.statement', sheet)) {
      const result = view.statements.get(li.dataset.statementId);
      if (result?.turnIds.includes(id)) {
        li.classList.add('is-cited');
        pieces.push(...result.pieces.filter((piece) => piece.id === id));
      }
    }
    highlightPieces(pieces);
  }

  sheet.addEventListener('pointerover', (event) => { if (event.pointerType !== 'touch') linkFromStatement(event.target.closest('.statement')); });
  sheet.addEventListener('focusin', (event) => linkFromStatement(event.target.closest('.statement')));
  sheet.addEventListener('pointerleave', () => { if (!sheet.contains(document.activeElement)) highlightPieces([]); });
  sheet.addEventListener('focusout', () => setTimeout(() => { if (!sheet.contains(document.activeElement) && !sheet.matches(':hover')) highlightPieces([]); }, 0));
  sheet.addEventListener('click', (event) => { if (event.target.closest('button.ev-chip')) linkFromStatement(event.target.closest('.statement')); });
  const turns = $('#turns');
  turns.addEventListener('pointerover', (event) => { if (event.pointerType !== 'touch') linkFromTurn(event.target.closest('.turn')); });
  turns.addEventListener('pointerleave', () => linkFromTurn(null));
  turns.addEventListener('focusin', (event) => linkFromTurn(event.target.closest('.turn')));
  turns.addEventListener('focusout', () => setTimeout(() => { if (!turns.contains(document.activeElement)) linkFromTurn(null); }, 0));

  // ---------- Editing ----------
  function scheduleVerify() {
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => { verify(); renderMarks(); renderState(); }, 250);
  }

  sheet.addEventListener('input', (event) => {
    const text = event.target.closest('.statement__text');
    const li = text?.closest('.statement');
    if (!li || !li.dataset.section) return;
    store.dispatch({ type: 'statement/edit', section: li.dataset.section, id: li.dataset.statementId, text: text.textContent });
  });
  sheet.addEventListener('click', (event) => {
    const add = event.target.closest('[data-action="add-statement"]');
    if (add) {
      const section = add.closest('.note-section').dataset.section;
      const id = newStatementId('s');
      store.dispatch({ type: 'statement/add', section, id });
      $(`.statement[data-statement-id="${id}"] .statement__text`, sheet)?.focus();
      return;
    }
    const remove = event.target.closest('[data-action="remove-statement"]');
    if (remove) {
      const li = remove.closest('.statement');
      const section = li.closest('.note-section').dataset.section;
      const next = li.nextElementSibling || li.previousElementSibling;
      store.dispatch({ type: 'statement/remove', section, id: li.dataset.statementId });
      ($('.statement__text', next || sheet) || $(`.note-section[data-section="${section}"] .add-line`, sheet))?.focus();
      announce(t('app.section.removed'));
      return;
    }
    const regen = event.target.closest('[data-action="regenerate-section"]');
    if (regen) regenerate(regen.closest('.note-section').dataset.section);
  });
  document.addEventListener('ui:flag-resolved', (event) => store.dispatch({ type: 'flag/resolve', id: event.detail.id, resolved: event.detail.resolved }));
  $('#flags-list').addEventListener('click', (event) => {
    const go = event.target.closest('[data-action="go-to-turn"]');
    if (!go) return;
    const first = document.querySelector(`.turn[data-turn-id="${CSS.escape(go.dataset.turns.split(' ')[0] || '')}"]`);
    if (!first) return;
    if (narrow.matches) showPane('source');
    first.scrollIntoView({ block: 'center' });
    first.classList.remove('is-flash');
    void first.offsetWidth;
    first.classList.add('is-flash');
  });

  $('#btn-generate').addEventListener('click', () => generate());
  $('#btn-generate-retry').addEventListener('click', () => generate({ confirmEdits: false }));
  $('#btn-cancel-generate').addEventListener('click', () => generateController?.abort());
  $('#btn-regenerate-all').addEventListener('click', () => generate());
  $('#btn-stale-dismiss').addEventListener('click', () => store.dispatch({ type: 'stale/dismiss' }));

  store.subscribe((state, previous, action) => {
    const noteChanged = state.session.note !== previous.session.note;
    const turnsChanged = state.session.turns !== previous.session.turns || state.session.speakersOn !== previous.session.speakersOn;
    if (noteChanged && ['statement/edit'].includes(action.type)) { scheduleVerify(); return; }
    if (noteChanged && action.type === 'flag/resolve') { renderFlags(); return; }
    if (noteChanged && ['statement/add', 'statement/remove'].includes(action.type)) {
      renderSection(action.section);
      verify();
      renderMarks();
      renderState();
      return;
    }
    if (noteChanged && action.type === 'section/replace') { renderSection(action.section); verify(); renderMarks(); renderState(); return; }
    if (noteChanged || action.type === 'session/load' || action.type === 'session/new') { renderAll(); return; }
    if (turnsChanged && state.session.note) {
      if (action.type === 'turn/edit') scheduleVerify();
      else { verify(); renderMarks(); }
    }
    if (state.noteState !== previous.noteState || state.session.staleDismissed !== previous.session.staleDismissed || turnsChanged) renderState();
  });
  onLangChange(() => { if (store.getState().session.note) { verify(); renderMarks(); } renderState(); });
  renderAll();

  return {
    generate,
    cancel() { generateController?.abort(); sectionController?.abort(); },
    get busy() { return Boolean(generateController || sectionController); },
  };
}
