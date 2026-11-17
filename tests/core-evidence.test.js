import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNumbers, findQuote, indexNumbers, indexTranscript, normalizeWithMap, verifyNote } from '../web/core/soap/evidence.js';
import { NOTE, TRANSCRIPT } from './fixtures.js';

const SOURCE = 'Doctor: How long?\nPatient: About three days, the headache is on the LEFT side.  I took Ibuprofen 400 mg twice.\nDoctor: Blood pressure 120/80 mmHg, temperature 38,5 °C. Possible migraine — we will try sumatriptan 50 mg.';

test('normalisation folds case, accents, punctuation and whitespace while keeping an offset map', () => {
  const { normalized, starts, ends } = normalizeWithMap('Café,  NIHSS-4!');
  assert.equal(normalized, 'cafe nihss 4');
  assert.equal(starts.length, normalized.length);
  assert.equal(ends[3], 4);
});

test('quotes are found exactly with offsets into the original transcript, tolerant of case and punctuation', () => {
  const index = indexTranscript(SOURCE);
  const hit = findQuote(index, 'the headache is on the left side');
  assert.equal(hit.found, true);
  assert.equal(hit.exact, true);
  assert.equal(SOURCE.slice(hit.start, hit.end), 'the headache is on the LEFT side');
  const spaced = findQuote(index, 'side. I took ibuprofen');
  assert.equal(SOURCE.slice(spaced.start, spaced.end), 'side.  I took Ibuprofen');
  assert.equal(findQuote(index, 'took ibu').found, false, 'partial words are not matches');
  assert.equal(findQuote(index, 'right side').found, false);
  assert.equal(findQuote(index, '').found, false);
});

test('minor transcription differences in longer quotes are tolerated, inventions are not', () => {
  const index = indexTranscript(SOURCE);
  const fuzzy = findQuote(index, 'about three days the headache is on left side');
  assert.equal(fuzzy.found, true);
  assert.equal(fuzzy.exact, false);
  assert.match(SOURCE.slice(fuzzy.start, fuzzy.end), /^About three days.*LEFT side$/);
  assert.equal(findQuote(index, 'severe crushing chest pain radiating to the arm').found, false);
  assert.equal(findQuote(index, 'about five weeks the pain is on the right').found, false);
});

test('numbers and units absent from the transcript are flagged; separators and number words match', () => {
  const numbers = indexNumbers(SOURCE);
  const check = text => checkNumbers(text, numbers);
  assert.deepEqual(check('Ibuprofen 400 mg twice.').map(n => n.found), [true]);
  assert.deepEqual(check('Ibuprofen 400 milligrams.').map(n => n.found), [true]);
  assert.deepEqual(check('Ibuprofen 800 mg.').map(n => [n.text, n.found]), [['800 mg', false]]);
  assert.deepEqual(check('Ibuprofen 400 mcg.').map(n => n.found), [false]);
  assert.deepEqual(check('Temperature 38.5 °C.').map(n => n.found), [true]);
  assert.deepEqual(check('Blood pressure 120/80 mmHg.').map(n => n.found), [true, true]);
  assert.deepEqual(check('Symptoms for 3 days.').map(n => n.found), [true]);
  assert.deepEqual(check('No numbers here.'), []);
});

test('verifyNote reports per-statement status, highlight offsets and a summary', () => {
  const note = {
    ...NOTE,
    subjective: [
      { text: 'Takes paracetamol 500 mg.', evidence: ['paracetamol 500 mg'] },
      { text: 'Takes paracetamol 1000 mg.', evidence: ['I take paracetamol 500 mg'] },
      { text: 'Has nausea.', evidence: ['nausea'] },
      { text: 'Has a fever.', evidence: [] },
    ],
    review_flags: [{ type: 'uncertain_number', text: 'Dose unclear', evidence: ['500 mg'] }],
  };
  const result = verifyNote(note, TRANSCRIPT);
  const [ok, wrongNumber, invented, noEvidence] = result.sections.subjective;
  assert.equal(ok.status, 'grounded');
  assert.equal(TRANSCRIPT.slice(ok.quotes[0].start, ok.quotes[0].end), 'paracetamol 500 mg');
  assert.equal(wrongNumber.status, 'grounded');
  assert.deepEqual(wrongNumber.numbers.map(n => [n.text, n.found]), [['1000 mg', false]]);
  assert.equal(invented.status, 'unverified');
  assert.equal(noEvidence.status, 'unverified');
  assert.equal(result.sections.objective[0].status, 'not_documented');
  assert.equal(result.review_flags[0].status, 'grounded');
  assert.deepEqual(result.summary, { statements: 8, grounded: 3, unverified: 2, notDocumented: 3, numberIssues: 1 });
  const indonesian = verifyNote({ ...NOTE, plan: [{ text: 'Tidak didokumentasikan dalam pertemuan ini.', evidence: [] }] }, TRANSCRIPT);
  assert.equal(indonesian.sections.plan[0].status, 'not_documented');
});

test('verification of a long transcript stays fast', () => {
  const long = Array.from({ length: 12000 }, (_, i) => `word${i % 400} said ${i % 37}`).join(' ');
  const statements = Array.from({ length: 60 }, (_, i) => ({ text: `Statement ${i} 12 mg.`, evidence: [`word${i} said ${i % 37} word${i + 1}`, 'completely absent quote text here'] }));
  const started = performance.now();
  verifyNote({ ...NOTE, subjective: statements }, long);
  assert.ok(performance.now() - started < 3000);
});
