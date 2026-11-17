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

test('minor transcription differences in longer quotes give an approximate match, inventions none', () => {
  const index = indexTranscript(SOURCE);
  const fuzzy = findQuote(index, 'about three days the headache is on left side');
  assert.equal(fuzzy.found, true);
  assert.equal(fuzzy.exact, false);
  assert.equal(fuzzy.match, 'approximate');
  assert.match(SOURCE.slice(fuzzy.start, fuzzy.end), /^About three days.*LEFT side$/);
  assert.equal(findQuote(index, 'severe crushing chest pain radiating to the arm').found, false);
  assert.equal(findQuote(index, 'about five weeks the pain is on the right').found, false);
});

test('numbers and units absent from the transcript are flagged; separators and number words match', () => {
  const numbers = indexNumbers(SOURCE);
  const check = text => checkNumbers(text, numbers);
  assert.deepEqual(check('Ibuprofen 400 mg twice.').map(n => n.found), [true, true], 'frequency words are numbers too');
  assert.deepEqual(check('Ibuprofen 400 milligrams.').map(n => n.found), [true]);
  assert.deepEqual(check('Ibuprofen 800 mg.').map(n => [n.text, n.found]), [['800 mg', false]]);
  assert.deepEqual(check('Ibuprofen 400 mcg.').map(n => n.found), [false]);
  assert.deepEqual(check('Temperature 38.5 °C.').map(n => n.found), [true]);
  assert.deepEqual(check('Blood pressure 120/80 mmHg.').map(n => [n.text, n.found]), [['120/80 mmHg', true]], 'a ratio is checked as a whole');
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
  assert.deepEqual(result.summary, { statements: 8, grounded: 3, approximate: 0, unverified: 2, edited: 0, clinician: 0, notDocumented: 3, numberIssues: 1 });
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

// ---------- Evidence safety (exact grounding) ----------

const NEGATION = 'Doctor: Any chest pain?\nPatient: No. Chest pain only when I run.\nPatient: I am not allergic to penicillin.';

test('a statement is grounded only when every quote matches exactly; negation changes never ground', () => {
  const note = {
    ...NOTE,
    subjective: [
      { text: 'No chest pain.', evidence: ['no chest pain'] },
      { text: 'Allergic to penicillin.', evidence: ['I am allergic to penicillin'] },
      { text: 'Not allergic to penicillin.', evidence: ['I am not allergic to penicillin'] },
      { text: 'Chest pain on running.', evidence: ['chest pain only when I run', 'I am allergic to penicillin'] },
    ],
  };
  const [noPain, allergic, notAllergic, mixed] = verifyNote(note, NEGATION).sections.subjective;
  assert.notEqual(noPain.status, 'grounded', '"no chest pain" must not be grounded by "Any chest pain" or "No. Chest pain"');
  assert.notEqual(allergic.status, 'grounded', '"I am allergic" must not be grounded by "I am not allergic"');
  assert.equal(notAllergic.status, 'grounded');
  assert.notEqual(mixed.status, 'grounded', 'one inexact quote is enough to withhold grounding');
});

test('tolerant matches are reported as approximate (never grounded) and counted separately', () => {
  const index = indexTranscript(NEGATION);
  const close = findQuote(index, 'I am allergic to penicillin');
  assert.equal(close.found, true);
  assert.equal(close.exact, false);
  assert.equal(close.match, 'approximate');
  assert.equal(NEGATION.slice(close.start, close.end), 'I am not allergic to penicillin');
  const result = verifyNote({ ...NOTE, subjective: [{ text: 'Allergic to penicillin.', evidence: ['I am allergic to penicillin'] }] }, NEGATION);
  assert.equal(result.sections.subjective[0].status, 'approximate');
  assert.equal(result.summary.approximate, 1);
  assert.equal(result.summary.grounded, 0);
  assert.equal(result.summary.unverified, 1);
});

test('a quote cannot run across a sentence boundary that the quote does not contain', () => {
  const index = indexTranscript(NEGATION);
  const crossing = findQuote(index, 'no chest pain only when I run');
  assert.notEqual(crossing.exact, true);
  const kept = findQuote(index, 'No. Chest pain only');
  assert.equal(kept.exact, true);
  assert.equal(NEGATION.slice(kept.start, kept.end), 'No. Chest pain only');
  assert.equal(findQuote(index, 'chest pain?').exact, true, 'trailing punctuation in the quote is ignored');
  assert.equal(findQuote(index, '“not allergic” to penicillin').exact, true, 'quote marks are ignored');
});

test('very short, bare-number or filler-only quotes never ground a statement', () => {
  const source = 'Doctor: Is it OK? Patient: Yes, it is. The pain is 7 out of 10. BP 140.';
  const index = indexTranscript(source);
  for (const quote of ['a', 'is', 'BP', 'yes', 'Yes, it is', 'ok', '7', '140', 'the']) {
    const hit = findQuote(index, quote);
    assert.equal(hit.found, false, `"${quote}" is too weak to be evidence`);
    assert.equal(hit.reason, 'weak');
  }
  assert.equal(findQuote(index, 'pain').found, true, 'a single meaningful word is still evidence');
  assert.equal(findQuote(index, '7 out of 10').exact, true);
  const result = verifyNote({ ...NOTE, subjective: [{ text: 'Patient agrees.', evidence: ['yes'] }] }, source);
  assert.equal(result.sections.subjective[0].status, 'unverified');
});

test('matches never start or end inside a word or a number', () => {
  const source = 'Aspirin 2.5 mg daily. Count 1,000 cells. BP 120/80 mmHg. Pain for 2-3 days. Painless lump.';
  const index = indexTranscript(source);
  assert.equal(findQuote(index, '5 mg').found, false, '"5 mg" is not inside "2.5 mg"');
  assert.equal(findQuote(index, '000 cells').found, false);
  assert.equal(findQuote(index, '80 mmHg').found, false, '"80 mmHg" is not inside "120/80 mmHg"');
  assert.equal(findQuote(index, '3 days').found, false, '"3 days" is not inside "2-3 days"');
  assert.equal(findQuote(index, 'less lump').found, false, '"less" is not a word of "Painless"');
  assert.equal(findQuote(index, 'aspirin 2.5 mg').exact, true);
  assert.equal(findQuote(index, '120/80 mmhg').exact, true);
  assert.equal(findQuote(index, '2-3 days').exact, true);
});

test('highlight offsets cover exactly the matched source text, with CRLF and multi-byte characters', () => {
  const source = 'Doctor: Café? 🙂\r\nPatient: I feel “dizzy”\r\n when standing — 𝟐 days.\r\nPatient: Naïve façade.';
  const index = indexTranscript(source);
  const hit = findQuote(index, 'I feel "dizzy" when standing');
  assert.equal(hit.exact, true);
  assert.equal(source.slice(hit.start, hit.end), 'I feel “dizzy”\r\n when standing');
  const accent = findQuote(index, 'naive facade');
  assert.equal(source.slice(accent.start, accent.end), 'Naïve façade');
  const cafe = findQuote(index, 'doctor cafe');
  assert.equal(source.slice(cafe.start, cafe.end), 'Doctor: Café');
});

test('a unit glued to its number matches the spaced form, in either direction', () => {
  const source = 'Patient: I take aspirin 2.5mg and metformin 500 mg. Vitamin B12 too.';
  const index = indexTranscript(source);
  const glued = findQuote(index, 'aspirin 2.5 mg');
  assert.equal(glued.exact, true);
  assert.equal(source.slice(glued.start, glued.end), 'aspirin 2.5mg');
  assert.equal(findQuote(index, 'metformin 500mg').exact, true);
  assert.equal(findQuote(index, 'vitamin b12').exact, true);
  assert.equal(findQuote(index, 'vitamin b 12').found, false, 'letters before digits stay one word');
});
