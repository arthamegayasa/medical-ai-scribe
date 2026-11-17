import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNumbers, indexNumbers } from '../web/core/soap/evidence.js';

const found = (transcript, statement) => checkNumbers(statement, indexNumbers(transcript)).map((n) => n.found);
const pairs = (transcript, statement) => checkNumbers(statement, indexNumbers(transcript)).map((n) => [n.text, n.found]);

test('numbers are compared as parsed values: tenfold and decimal-separator errors are flagged', () => {
  assert.deepEqual(found('Doctor: aspirin 2.5 mg daily.', 'Aspirin 25 mg daily.'), [false]);
  assert.deepEqual(found('Doctor: aspirin 2.5 mg daily.', 'Aspirin 2.5 mg daily.'), [true]);
  assert.deepEqual(found('Dokter: metoprolol 1,5 mg.', 'Metoprolol 15 mg.'), [false]);
  assert.deepEqual(found('Dokter: metoprolol 1,5 mg.', 'Metoprolol 1.5 mg.'), [true]);
  assert.deepEqual(found('Dokter: metoprolol 1,5 mg.', 'Metoprolol 1,5 mg.'), [true]);
  assert.deepEqual(found('Doctor: digoxin 0,125 mg.', 'Digoxin 0.125 mg.'), [true]);
  assert.deepEqual(found('Doctor: digoxin 0.125 mg.', 'Digoxin 125 mg.'), [false]);
  assert.deepEqual(found('Doctor: aspirin 2.5 mg.', 'Aspirin 5 mg.'), [false], 'a number inside a decimal is not a match');
});

test('separators are ignored only for a valid thousands grouping; ambiguous numbers fail safe', () => {
  const t = 'Paracetamol 1,000 mg. Vitamin D 2.500 IU. Platelets 250 000. Count 1,234.5 units.';
  assert.deepEqual(found(t, 'Paracetamol 1000 mg.'), [true]);
  assert.deepEqual(found(t, 'Paracetamol 1.000 mg.'), [true]);
  assert.deepEqual(found(t, 'Paracetamol 1 000 mg.'), [true]);
  assert.deepEqual(found(t, 'Paracetamol 1 mg.'), [false]);
  assert.deepEqual(found(t, 'Vitamin D 2500 IU.'), [true]);
  assert.deepEqual(found(t, 'Vitamin D 2.5 IU.'), [false]);
  assert.deepEqual(found(t, 'Platelets 250000.'), [true]);
  assert.deepEqual(found(t, 'Count 1234.5 units.'), [true]);
  const ambiguous = checkNumbers('Count 1,23,456 cells.', indexNumbers('Count 1,23,456 cells. Count 123456 cells.'));
  assert.deepEqual(ambiguous.map((n) => [n.text, n.found, n.reason]), [['1,23,456', false, 'ambiguous']]);
  assert.deepEqual(found('Count 1,23,456 cells.', 'Count 123456 cells.'), [false], 'an invalid grouping in the transcript never confirms a value');
});

test('units glued or spaced are compared, and a changed unit with the same number is flagged', () => {
  const t = 'Metformin 500mg twice a day. Then 5 mg. Also 5 mcg. Fever 38 degrees Fahrenheit for 3 days. Take 2 daily.';
  assert.deepEqual(found(t, 'Metformin 500 mg.'), [true]);
  assert.deepEqual(found(t, 'Metformin 500mg.'), [true]);
  assert.deepEqual(found(t, 'Metformin 500 milligrams.'), [true]);
  assert.deepEqual(found(t, 'Metformin 500 g.'), [false]);
  assert.deepEqual(found(t, 'Metformin 500 mcg.'), [false]);
  assert.deepEqual(found(t, 'Then 5 g.'), [false]);
  assert.deepEqual(found(t, 'Also 5 micrograms.'), [true]);
  assert.deepEqual(found(t, 'Also 5 µg.'), [true]);
  assert.deepEqual(found(t, 'Fever 38 °C.'), [false]);
  assert.deepEqual(found(t, 'Fever 38 °F.'), [true]);
  assert.deepEqual(found(t, 'For 3 weeks.'), [false]);
  assert.deepEqual(found(t, 'For 3 days.'), [true]);
  assert.deepEqual(found('Pasien: sudah 3 hari.', 'For 3 days.'), [true], 'units match across English and Indonesian');
  assert.deepEqual(found(t, 'Take 2 mg.'), [false], 'a unit the transcript did not give is flagged');
  assert.deepEqual(found(t, 'Take 2.'), [true]);
});

test('ranges, ratios and percentages are compared as a whole', () => {
  const t = 'BP 120/80 mmHg. Pain for 2-3 days. SpO2 95%. Later 130 over 85.';
  assert.deepEqual(pairs(t, 'BP 120/80 mmHg.'), [['120/80 mmHg', true]]);
  assert.deepEqual(found(t, 'BP 80/120.'), [false]);
  assert.deepEqual(found(t, 'BP 120/90.'), [false]);
  assert.deepEqual(found(t, 'Diastolic 80 mmHg.'), [true], 'a single value may come from a ratio');
  assert.deepEqual(found(t, 'BP 130/85.'), [true]);
  assert.deepEqual(found(t, 'Pain for 2-3 days.'), [true]);
  assert.deepEqual(found(t, 'Pain for 2 to 3 days.'), [true]);
  assert.deepEqual(found(t, 'Pain for 2–3 days.'), [true]);
  assert.deepEqual(found(t, 'Pain for 3 days.'), [false], 'a range collapsed to one end is flagged');
  assert.deepEqual(found(t, 'Pain for 2-4 days.'), [false]);
  assert.deepEqual(found(t, 'SpO2 95%.'), [true]);
  assert.deepEqual(found(t, 'Saturation 95 percent.'), [true]);
  assert.deepEqual(found(t, 'Saturation 9.5%.'), [false]);
  assert.deepEqual(found(t, 'Saturation 95 mg.'), [false]);
});

test('numbers written as words are understood in English and Indonesian, in either text', () => {
  assert.deepEqual(found('Patient: twenty-five milligrams.', 'Takes 25 mg.'), [true]);
  assert.deepEqual(found('Patient: twenty five milligrams.', 'Takes 35 mg.'), [false]);
  assert.deepEqual(found('Doctor: one hundred and twenty over eighty.', 'BP 120/80.'), [true]);
  assert.deepEqual(found('Doctor: two point five milligrams.', 'Dose 2.5 mg.'), [true]);
  assert.deepEqual(found('Doctor: two point five milligrams.', 'Dose 25 mg.'), [false]);
  assert.deepEqual(found('Doctor: two thousand five hundred units.', 'Dose 2,500 units.'), [true]);
  assert.deepEqual(found('Doctor: one and a half tablets.', 'Takes 1.5 tablets.'), [true]);
  assert.deepEqual(found('Dokter: dua puluh lima miligram.', 'Takes 25 mg.'), [true]);
  assert.deepEqual(found('Dokter: seratus dua puluh per delapan puluh.', 'BP 120/80.'), [true]);
  assert.deepEqual(found('Dokter: dua ribu lima ratus unit.', 'Dose 2500 units.'), [true]);
  assert.deepEqual(found('Dokter: dua koma lima miligram.', 'Dose 2.5 mg.'), [true]);
  assert.deepEqual(found('Dokter: satu setengah tablet.', 'Takes 1.5 tablets.'), [true]);
  assert.deepEqual(found('Pasien: dua belas hari.', 'For 12 days.'), [true]);
  assert.deepEqual(found('Pasien: sebelas hari.', 'For 11 days.'), [true]);
  assert.deepEqual(found('Pasien: seribu.', 'Count 1000.'), [true]);
  assert.deepEqual(found('Patient: 25 mg.', 'Takes twenty-five mg.'), [true], 'words in the statement are checked too');
  assert.deepEqual(found('Patient: 25 mg.', 'Takes twenty mg.'), [false]);
  assert.deepEqual(found('Pasien: 25 mg.', 'Minum dua puluh lima mg.'), [true]);
  assert.deepEqual(pairs('Patient: for a while.', 'Pain for fifty-five days.'), [['fifty-five days', false]], 'a number word that cannot be matched is flagged, not skipped');
});

test('frequency words are numbers, and pronoun uses of "one" are not', () => {
  assert.deepEqual(found('Doctor: take it once a day.', 'Twice daily.'), [false]);
  assert.deepEqual(found('Doctor: take it twice a day.', 'Twice daily.'), [true]);
  assert.deepEqual(found('Doctor: take it 2 times a day.', 'Twice daily.'), [true]);
  assert.deepEqual(found('Dokter: diminum dua kali sehari.', 'Twice daily.'), [true]);
  assert.deepEqual(found('Doctor: take it twice a day.', 'Three times daily.'), [false]);
  assert.deepEqual(found('Doctor: nothing.', 'No one else at home is unwell.'), []);
  assert.deepEqual(found('Doctor: nothing.', 'Salah satu anaknya sakit.'), []);
});
