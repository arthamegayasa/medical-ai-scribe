import test from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, ScribeError } from '../web/core/errors.js';
import { verifyNote, validateNote, hashText, SECTIONS, toMarkdown } from '../web/core/index.js';
import { describeError, ERROR_KEYS, APP_ERROR_KEYS, AppError } from '../web/assets/js/app/messages.js';
import { exampleData, EXAMPLE_UNVERIFIED } from '../web/assets/js/app/example.js';
import { parsePasted, turnsFromTranscript, buildSource, turnIdsForSpan, spanPiecesByTurn, splitPlain, clock, transcriptForCopy } from '../web/assets/js/app/transcript.js';
import { fromEngineNote, toEngineNote, annotate, applyProvenance, itemsFromEngine } from '../web/assets/js/app/note.js';
import { reducer, initialState } from '../web/assets/js/app/store.js';
import { createSegmentJob } from '../web/assets/js/app/segments.js';
import en from '../web/assets/js/strings/en.js';
import id from '../web/assets/js/strings/id.js';

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every engine error code maps to a specific message that exists in English and Indonesian', () => {
  assert.deepEqual(Object.keys(ERROR_KEYS).sort(), [...ERROR_CODES].sort());
  const keys = [...Object.values(ERROR_KEYS), ...Object.values(APP_ERROR_KEYS), 'app.err.corsLocal', 'app.err.corsCustom', 'app.err.rate_limit_wait', 'app.err.endpointNotFound'];
  for (const key of keys) {
    assert.ok(en[key], `missing English string ${key}`);
    assert.ok(id[key], `missing Indonesian string ${key}`);
    assert.deepEqual(placeholders(id[key]), placeholders(en[key]), `placeholders differ for ${key}`);
  }
});

test('English and Indonesian string tables have the same keys and placeholders', () => {
  assert.deepEqual(Object.keys(id).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) assert.deepEqual(placeholders(id[key]), placeholders(en[key]), key);
});

test('error descriptions depend only on the code and context, never on the error message', () => {
  const leaky = new ScribeError('auth', 'sk-secret-key leaked in message');
  const described = describeError(leaky, { providerLabel: 'OpenAI' });
  assert.equal(described.key, 'app.err.auth');
  assert.ok(!JSON.stringify(described).includes('sk-secret'));
  assert.equal(describeError(new ScribeError('network'), { browser: 'local', origin: 'http://127.0.0.1:3000' }).key, 'app.err.corsLocal');
  assert.equal(describeError(new ScribeError('network'), { browser: 'unknown' }).key, 'app.err.corsCustom');
  assert.equal(describeError(new ScribeError('network'), { browser: 'direct' }).key, 'app.err.network');
  assert.equal(describeError(new ScribeError('model_not_found'), { operation: 'test' }).key, 'app.err.endpointNotFound', 'a 404 during a key test points at the base URL');
  assert.equal(describeError(new ScribeError('model_not_found')).key, 'app.err.model_not_found');
  assert.deepEqual(describeError(new ScribeError('rate_limit', undefined, { retryAfterMs: 2500 })).vars.seconds, 3);
  assert.equal(describeError(new ScribeError('rate_limit')).retryable, true);
  assert.equal(describeError(new TypeError('boom sk-x')).key, 'app.err.unexpected');
  assert.equal(describeError(new AppError('micNotFound')).key, 'app.err.micNotFound');
  assert.equal(describeError(null).key, 'app.err.unexpected');
});

for (const language of ['en', 'id']) {
  test(`fictional example (${language}) is a valid note whose evidence verifies through the real verifier, except the deliberate line`, () => {
    const { turns, note, meta } = exampleData(language);
    assert.deepEqual(validateNote(note), note);
    const source = buildSource(turns).text;
    assert.equal(meta.transcriptHash, hashText(source));
    assert.equal(meta.language, language);
    const verification = verifyNote(note, source);
    for (const key of SECTIONS) {
      verification.sections[key].forEach((result, i) => {
        const deliberate = key === EXAMPLE_UNVERIFIED.section && i === EXAMPLE_UNVERIFIED.index;
        assert.equal(result.status, deliberate ? 'unverified' : 'grounded', `${language} ${key}[${i}]: ${note[key][i].text}`);
        if (!deliberate) assert.ok(result.quotes.every((q) => q.exact), `${key}[${i}] quotes should be verbatim`);
        assert.ok(result.numbers.every((n) => n.found), `${key}[${i}] has an unmatched number`);
      });
    }
    verification.review_flags.forEach((result, i) => {
      if (note.review_flags[i].evidence.length) assert.equal(result.status, 'grounded', `flag ${i}`);
    });
    assert.equal(verification.summary.unverified, 1);
    const markdown = toMarkdown({ note, meta, verification, fictional: true });
    assert.match(markdown, language === 'id' ? /CONTOH FIKTIF/ : /FICTIONAL SAMPLE/);
  });
}

test('pasted text: labelled lines become turns (English and Indonesian labels), continuation lines join, plain text splits', () => {
  let n = 0;
  const makeId = () => `t${++n}`;
  const { turns, labelled } = parsePasted('Doctor: Hello.\nPasien: Kepala saya sakit\nsudah tiga hari.\n\nDr: Okay.\nKeluarga: Dia juga demam.', makeId);
  assert.equal(labelled, true);
  assert.deepEqual(turns.map((t) => [t.speaker, t.text]), [['doctor', 'Hello.'], ['patient', 'Kepala saya sakit sudah tiga hari.'], ['doctor', 'Okay.'], ['other', 'Dia juga demam.']]);
  const plain = parsePasted('First paragraph.\n\nSecond paragraph.', makeId);
  assert.equal(plain.labelled, false);
  assert.deepEqual(plain.turns.map((t) => [t.speaker, t.text]), [['unknown', 'First paragraph.'], ['unknown', 'Second paragraph.']]);
  const long = splitPlain(`${'Word sentence here. '.repeat(60)}`);
  assert.ok(long.length > 1 && long.every((part) => part.length <= 420));
  assert.equal(long.join(' ').replace(/\s+/g, ' '), 'Word sentence here. '.repeat(60).trim());
});

test('transcription results become turns: diarized speakers grouped, timestamps kept, text-only results split', () => {
  let n = 0;
  const makeId = () => `t${++n}`;
  const diarized = turnsFromTranscript({ text: '', segments: [
    { start: 0, end: 2, text: 'Hello.', speaker: 'A' }, { start: 2, end: 3, text: 'How are you?', speaker: 'A' }, { start: 3, end: 5, text: 'Fine.', speaker: 'B' },
  ] }, makeId);
  assert.equal(diarized.diarized, true);
  assert.deepEqual(diarized.turns.map((t) => [t.text, t.diarSpeaker, t.start, t.end]), [['Hello. How are you?', 'A', 0, 3], ['Fine.', 'B', 3, 5]]);
  const textOnly = turnsFromTranscript({ text: 'One. Two.', segments: [] }, makeId);
  assert.equal(textOnly.timed, false);
  assert.deepEqual(textOnly.turns.map((t) => t.text), ['One. Two.']);
  assert.equal(clock(3725), '1:02:05');
  assert.equal(clock(65), '01:05');
});

test('source text carries English role labels and maps evidence spans back to turns and in-turn offsets', () => {
  const turns = [{ id: 'a', speaker: 'doctor', text: 'What brings you in?' }, { id: 'b', speaker: 'unknown', text: '  ' }, { id: 'c', speaker: 'patient', text: 'Headache for three days.' }];
  const { text, ranges } = buildSource(turns);
  assert.equal(text, 'Doctor: What brings you in?\nPatient: Headache for three days.');
  assert.equal(buildSource(turns, { speakers: false }).text, 'What brings you in?\nHeadache for three days.');
  const start = text.indexOf('three days');
  assert.deepEqual(turnIdsForSpan(ranges, start, start + 10), ['c']);
  assert.deepEqual(spanPiecesByTurn(ranges, start, start + 10), [{ id: 'c', start: 'Headache for '.length, end: 'Headache for three days'.length }]);
  assert.deepEqual(turnIdsForSpan(ranges, 0, text.length), ['a', 'c']);
  assert.equal(transcriptForCopy([{ speaker: 'patient', text: 'Hi', start: 5 }], { patient: 'Pasien' }), '[00:05] Pasien: Hi');
});

test('app note converts to a valid engine note (empty sections become "not documented") and annotates verification', () => {
  const { turns, note } = exampleData('en');
  const app = fromEngineNote(note);
  app.sections.assessment = [];
  app.sections.plan.push({ id: 'empty', text: '   ', evidence: [] });
  app.sections.plan.push({ id: 'mine', text: 'Paracetamol 500 mg as needed.', evidence: [], origin: 'clinician' });
  const { note: engine, positions } = toEngineNote(app, 'id');
  assert.deepEqual(validateNote(engine), engine);
  assert.deepEqual(engine.assessment, [{ text: 'Tidak didokumentasikan dalam pertemuan ini.', evidence: [] }]);
  assert.equal(positions.has('empty'), false);
  const { text, ranges } = buildSource(turns);
  const view = annotate(app, applyProvenance(app, verifyNote(engine, text), positions), positions, ranges);
  const cc = view.statements.get(app.sections.chief_complaint[0].id);
  assert.equal(cc.status, 'grounded');
  assert.deepEqual(cc.turnIds, ['t2']);
  const mine = view.statements.get('mine');
  assert.equal(mine.status, 'clinician');
  assert.deepEqual(mine.numberIssues, ['500 mg']);
  assert.equal(view.statements.get('empty').status, 'none');
  const dominance = view.flags.get(app.flags[0].id);
  assert.equal(dominance.target, app.sections.chief_complaint[0].id, 'a flag points at the first statement citing the same turn');
  assert.equal(view.summary.unverified, 1);
});

test('segment job keeps completed segments when one fails and retries only what is missing', async () => {
  const calls = [];
  let failOnce = true;
  const segments = [0, 1, 2, 3].map((i) => ({ audio: { i }, start: i * 10, end: i * 10 + 10 }));
  const progress = [];
  const job = createSegmentJob({
    segments, concurrency: 2, onProgress: (p) => progress.push(p.completed),
    run: async (segment, index, signal) => {
      calls.push(index);
      await new Promise((r) => setTimeout(r, 5));
      if (signal.aborted) throw new ScribeError('aborted');
      if (index === 2 && failOnce) { failOnce = false; throw new ScribeError('bad_request'); }
      return { text: `seg${index}`, segments: [] };
    },
  });
  await assert.rejects(job.start(), (error) => error.code === 'bad_request' && error.failedIndex === 2);
  assert.equal(job.failedIndex, 2);
  const kept = job.results().filter(Boolean).map((r) => r.text);
  assert.ok(kept.includes('seg0') && kept.includes('seg1'));
  const before = calls.length;
  const results = await job.start();
  assert.deepEqual(results.map((r) => r.text), ['seg0', 'seg1', 'seg2', 'seg3']);
  assert.ok(!calls.slice(before).includes(0) && !calls.slice(before).includes(1), 'completed segments are not sent again');
  assert.equal(progress.at(-1), 4);
});

test('segment job cancels on the caller signal', async () => {
  const controller = new AbortController();
  const job = createSegmentJob({
    segments: [{}, {}, {}],
    concurrency: 1,
    run: (segment, index, signal) => new Promise((resolve, reject) => {
      if (index === 0) setTimeout(() => controller.abort(), 1);
      signal.addEventListener('abort', () => reject(new ScribeError('aborted')));
    }),
  });
  await assert.rejects(job.start(controller.signal), (error) => error.code === 'aborted');
});

test('retryability comes from the engine error itself, and the messages module has no duplicate code list', async () => {
  for (const code of ERROR_CODES) assert.equal(describeError(new ScribeError(code)).retryable, new ScribeError(code).retryable, code);
  assert.equal(describeError({ code: 'network', retryable: false }).retryable, false, 'the flag, not a second list, decides');
  assert.equal(describeError({ code: 'bad_request', retryable: true }).retryable, true);
  const messages = await import('../web/assets/js/app/messages.js');
  assert.equal('KNOWN_ENGINE_CODES' in messages, false);
});

// ---------- Statement provenance: edited and clinician-entered lines ----------
const verifyApp = (app, turns, language = 'en') => {
  const { note: engine, positions } = toEngineNote(app, language);
  const { text, ranges } = buildSource(turns);
  const verification = applyProvenance(app, verifyNote(engine, text), positions);
  return { engine, verification, view: annotate(app, verification, positions, ranges) };
};

test('editing a model statement withdraws grounding until its text is again exactly what was verified', () => {
  const { turns, note, meta } = exampleData('en');
  let state = reducer(initialState(), { type: 'note/ready', note: fromEngineNote(note), meta });
  const cc = state.session.note.sections.chief_complaint[0];
  assert.equal(cc.origin, 'model');
  assert.equal(verifyApp(state.session.note, turns).view.statements.get(cc.id).status, 'grounded');
  const edit = (text) => { state = reducer(state, { type: 'statement/edit', section: 'chief_complaint', id: cc.id, text }); return verifyApp(state.session.note, turns); };
  let result = edit(`No ${cc.text}`);
  assert.equal(result.view.statements.get(cc.id).status, 'edited', 'a rewritten line keeps its quotes but is not grounded');
  assert.ok(result.view.statements.get(cc.id).turnIds.length > 0, 'the original evidence stays visible for re-checking');
  assert.equal(result.verification.sections.chief_complaint[0].status, 'edited');
  assert.equal(result.verification.summary.edited, 1);
  assert.equal(result.view.summary.edited, 1);
  const md = toMarkdown({ note: result.engine, meta, verification: result.verification });
  assert.match(md, /\[EDITED - RE-CHECK AGAINST TRANSCRIPT\]/);
  assert.match(md, /edited after verification/);
  result = edit(`  ${cc.text.replace(/ /g, '  ')} `);
  assert.equal(result.view.statements.get(cc.id).status, 'grounded', 'whitespace-only changes keep the verified text');
  result = edit(cc.text.toUpperCase());
  assert.equal(result.view.statements.get(cc.id).status, 'edited', 'any other change, even case, needs a re-check');
  result = edit(cc.text);
  assert.equal(result.view.statements.get(cc.id).status, 'grounded', 'restoring the verified text restores grounding');
  const rewritten = itemsFromEngine([{ text: 'Rest the hand.', evidence: ['splint at night'] }]);
  assert.deepEqual([rewritten[0].origin, rewritten[0].verifiedText], ['model', 'Rest the hand.']);
});

test('a line the clinician typed reads as clinician-entered, never as an unverified AI claim', () => {
  const { turns, note, meta } = exampleData('en');
  let state = reducer(initialState(), { type: 'note/ready', note: fromEngineNote(note), meta });
  state = reducer(state, { type: 'statement/add', section: 'assessment', id: 'mine' });
  assert.deepEqual(state.session.note.sections.assessment.at(-1), { id: 'mine', text: '', evidence: [], origin: 'clinician' });
  state = reducer(state, { type: 'statement/edit', section: 'assessment', id: 'mine', text: 'Ibuprofen 400 mg as needed.' });
  const { view, verification, engine } = verifyApp(state.session.note, turns);
  const mine = view.statements.get('mine');
  assert.equal(mine.status, 'clinician');
  assert.deepEqual(mine.numberIssues, ['400 mg'], 'numbers are still checked against the transcript');
  assert.equal(view.summary.unverified, 1, 'only the deliberately unsupported AI line is unverified');
  assert.equal(view.summary.clinician, 1);
  const text = toMarkdown({ note: engine, meta, verification });
  const line = text.split('\n').find((l) => l.includes('Ibuprofen 400 mg'));
  assert.match(line, /\[CLINICIAN-ENTERED\]/);
  assert.doesNotMatch(line, /UNVERIFIED/);
});

test('note-language selects offer every engine language, from the engine list, with labels in both UI languages', async () => {
  const { LANGUAGES } = await import('../web/core/soap/prompt.js');
  const { NOTE_LANGUAGES, sanitizePrefs } = await import('../web/assets/js/app/prefs.js');
  const { noteLanguageOptions } = await import('../web/assets/js/app/format.js');
  assert.deepEqual([...NOTE_LANGUAGES], Object.keys(LANGUAGES));
  assert.deepEqual(noteLanguageOptions().map((o) => o.value), Object.keys(LANGUAGES));
  for (const { value, key } of noteLanguageOptions()) {
    assert.equal(key, `app.lang.${value}`);
    assert.ok(en[key] && id[key], `label for ${value} in English and Indonesian`);
  }
  assert.equal(sanitizePrefs({ noteLanguage: 'de' }).noteLanguage, 'de');
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../web/app/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<select[^>]*data-note-language-select[^>]*>([\s\S]*?)<\/select>/g)) {
    assert.doesNotMatch(match[1], /<option/, 'no second, hard-coded language list in the markup');
  }
});
