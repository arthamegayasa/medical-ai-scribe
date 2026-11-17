import test from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, ScribeError } from '../web/core/errors.js';
import { verifyNote, validateNote, hashText, SECTIONS, toMarkdown } from '../web/core/index.js';
import { describeError, ERROR_KEYS, APP_ERROR_KEYS, AppError } from '../web/assets/js/app/messages.js';
import { exampleData, EXAMPLE_UNVERIFIED } from '../web/assets/js/app/example.js';
import { parsePasted, turnsFromTranscript, buildSource, turnIdsForSpan, spanPiecesByTurn, splitPlain, clock, transcriptForCopy } from '../web/assets/js/app/transcript.js';
import { fromEngineNote, toEngineNote, annotate } from '../web/assets/js/app/note.js';
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
  app.sections.plan.push({ id: 'mine', text: 'Paracetamol 500 mg as needed.', evidence: [] });
  const { note: engine, positions } = toEngineNote(app, 'id');
  assert.deepEqual(validateNote(engine), engine);
  assert.deepEqual(engine.assessment, [{ text: 'Tidak didokumentasikan dalam pertemuan ini.', evidence: [] }]);
  assert.equal(positions.has('empty'), false);
  const { text, ranges } = buildSource(turns);
  const view = annotate(app, verifyNote(engine, text), positions, ranges);
  const cc = view.statements.get(app.sections.chief_complaint[0].id);
  assert.equal(cc.status, 'grounded');
  assert.deepEqual(cc.turnIds, ['t2']);
  const mine = view.statements.get('mine');
  assert.equal(mine.status, 'unverified');
  assert.deepEqual(mine.numberIssues, ['500 mg']);
  assert.equal(view.statements.get('empty').status, 'none');
  const dominance = view.flags.get(app.flags[0].id);
  assert.equal(dominance.target, app.sections.chief_complaint[0].id, 'a flag points at the first statement citing the same turn');
  assert.equal(view.summary.unverified, 2);
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
