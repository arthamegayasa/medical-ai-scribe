// Number and unit check: every number in a statement must appear in the transcript with the same
// value (and the same unit, when the statement gives one). Numbers are parsed, never compared as
// text, so "25" never matches "2.5" and "15" never matches "1,5".
//
// Parsing rules (documented in web/core/README.md):
// - "." and "," are both decimal marks. A separator is read as a thousands separator only in a
//   valid grouping: groups of exactly three digits after a first group of one to three digits
//   that does not start with 0 ("1,000", "1.000", "1 000", "250 000", "1,234.5").
// - Anything else with several separators ("1,23,456", "1.2.3") is ambiguous: a statement number
//   like that is always flagged, and a transcript number like that never confirms anything.
// - Ratios ("120/80", "120 over 80") and ranges ("2-3", "2 to 3", "2 sampai 3") are compared as
//   a whole. A single value may come from one side of a ratio ("diastolic 80"), never from a
//   range ("3 days" is not "2-3 days").
// - English and Indonesian number words are parsed in both texts ("twenty-five", "dua puluh
//   lima", "two point five", "satu setengah", "twice"). Words in other languages are not parsed.

const lowerSameLength = (text) => [...text].map((char) => { const lower = char.toLowerCase(); return lower.length === char.length ? lower : char; }).join('');

// Canonical unit -> spellings (regex sources, matched in order, so specific spellings come first).
const UNITS = [
  ['mg/dl', ['mg\\s?/\\s?dl', 'mg per dl', 'milligrams? per decilit(?:er|re)s?']],
  ['mmol/l', ['mmol\\s?/\\s?l', 'mmol per l', 'millimoles? per lit(?:er|re)s?', 'mmol']],
  ['mg/kg', ['mg\\s?/\\s?kg', 'mg per kg', 'milligrams? per kilo(?:gram)?s?']],
  ['mmhg', ['mmhg', 'mm hg', 'millimet(?:er|re)s? of mercury']],
  ['/min', ['bpm', 'beats? per min(?:ute)?', 'beats? a minute', 'per min(?:ute)?', '\\s?/\\s?min', 'x\\s?/\\s?menit', 'kali per menit', 'per menit']],
  ['mcg', ['mcg', 'µg', 'μg', 'ug', 'micrograms?', 'mikrogram']],
  ['mg', ['mg', 'milligrams?', 'milligrammes?', 'miligram']],
  ['kg', ['kg', 'kilograms?', 'kilogrammes?', 'kilos?', 'kilogram']],
  ['g', ['g', 'grams?', 'grammes?', 'gram']],
  ['ml', ['ml', 'millilit(?:er|re)s?', 'mililiter', 'cc']],
  ['l', ['l', 'lit(?:er|re)s?', 'liter']],
  ['meq', ['meq', 'milliequivalents?']],
  ['cm', ['cm', 'centimet(?:er|re)s?', 'sentimeter']],
  ['mm', ['mm', 'millimet(?:er|re)s?', 'milimeter']],
  ['%', ['%', 'per ?cent', 'persen', 'pct']],
  ['°c', ['°\\s?c', 'º\\s?c', 'degrees? c(?:elsius)?', 'degrees? centigrade', 'derajat c(?:elsius)?', 'celsius']],
  ['°f', ['°\\s?f', 'º\\s?f', 'degrees? f(?:ahrenheit)?', 'derajat f(?:ahrenheit)?', 'fahrenheit']],
  ['degree', ['degrees?', 'derajat', '°', 'º']],
  ['unit', ['iu', 'units?', 'unit', 'ui']],
  ['tablet', ['tablets?', 'tabs?', 'pills?', 'tablet', 'butir']],
  ['capsule', ['capsules?', 'caps?', 'kapsul']],
  ['puff', ['puffs?', 'sprays?', 'semprot(?:an)?']],
  ['drop', ['drops?', 'tetes']],
  ['times', ['times?', 'x', 'kali']],
  ['minute', ['minutes?', 'mins?', 'menit']],
  ['hour', ['hours?', 'hrs?', 'h', 'jam']],
  ['day', ['days?', 'hari']],
  ['week', ['weeks?', 'wks?', 'minggu', 'pekan']],
  ['month', ['months?', 'bulan']],
  ['year', ['years?', 'yrs?', 'tahun']],
].map(([unit, spellings]) => [unit, new RegExp(`^\\s?(?:${spellings.join('|')})(?![\\p{L}\\p{N}])`, 'u')]);

function unitAt(lower, from) {
  const rest = lower.slice(from, from + 40);
  for (const [unit, pattern] of UNITS) {
    const match = rest.match(pattern);
    if (match) return { unit, end: from + match[0].length };
  }
  return null;
}

/** Parses a run of digits and separators. @returns {{ value: number|null, ambiguous: boolean }} */
export function parseNumeral(raw) {
  const text = raw.replace(/\s+/g, ' ').trim();
  const grouped = (groups) => /^[1-9]\d{0,2}$/.test(groups[0]) && groups.slice(1).every((group) => /^\d{3}$/.test(group));
  const ambiguous = { value: null, ambiguous: true };
  if (text.includes(' ')) {
    const groups = text.split(' ');
    const last = groups.pop();
    const tail = last.match(/^(\d{3})(?:[.,](\d+))?$/);
    if (!tail || !grouped([...groups, tail[1]]) || /[.,]/.test(groups.join(''))) return ambiguous;
    return { value: Number(`${groups.join('')}${tail[1]}${tail[2] ? `.${tail[2]}` : ''}`), ambiguous: false };
  }
  const separators = [...new Set(text.match(/[.,]/g) || [])];
  if (!separators.length) return { value: Number(text), ambiguous: false };
  if (separators.length === 2) {
    const decimal = text.match(/[.,](?=\d+$)/)?.[0];
    const at = text.lastIndexOf(decimal);
    const integer = text.slice(0, at);
    if (integer.includes(decimal) || !grouped(integer.split(decimal === '.' ? ',' : '.'))) return ambiguous;
    return { value: Number(`${integer.replace(/[.,]/g, '')}.${text.slice(at + 1)}`), ambiguous: false };
  }
  const parts = text.split(separators[0]);
  if (parts.length === 2) {
    if (parts[1].length === 3 && grouped(parts)) return { value: Number(parts.join('')), ambiguous: false };
    return { value: Number(`${parts[0] || '0'}.${parts[1]}`), ambiguous: false };
  }
  return grouped(parts) ? { value: Number(parts.join('')), ambiguous: false } : ambiguous;
}

// ---------- Number words (English and Indonesian) ----------
const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  nol: 0, satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, delapan: 8, sembilan: 9, sepuluh: 10, sebelas: 11,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { thousand: 1e3, million: 1e6, ribu: 1e3, juta: 1e6 };
const WHOLE = { seratus: [100, 'hundred'], seribu: [1000, 'scale'], sejuta: [1e6, 'scale'] };
const STANDALONE = { once: [1, 'times'], twice: [2, 'times'], thrice: [3, 'times'], seminggu: [1, 'week'], sebulan: [1, 'month'], setahun: [1, 'year'] };
const PRONOUN_BEFORE = new Set(['no', 'any', 'every', 'each', 'some', 'the', 'this', 'that', 'which', 'another', 'other', 'salah']);

function wordTokens(lower) {
  return [...lower.matchAll(/\p{L}+/gu)].map((match) => ({ word: match[0], start: match.index, end: match.index + match[0].length }));
}

/** Parses the longest number phrase starting at token i. */
function parseWords(lower, tokens, i) {
  const first = tokens[i].word;
  if (STANDALONE[first]) return { value: STANDALONE[first][0], unit: STANDALONE[first][1], last: i };
  if (first === 'half' && ['a', 'an'].includes(tokens[i + 1]?.word)) return { value: 0.5, last: i };
  const joined = (j) => j > i && /^[\s-]+$/.test(lower.slice(tokens[j - 1].end, tokens[j].start));
  let total = 0;
  let group = 0;
  let lastKind = null;
  let lastSmall = 0;
  let last = -1;
  let fraction = null;
  for (let j = i; j < tokens.length; j++) {
    if (j > i && !joined(j)) break;
    const word = tokens[j].word;
    const next = tokens[j + 1]?.word;
    if (j === i && word === 'a' && (next === 'hundred' || next === 'thousand')) { group = 1; lastKind = 'small'; lastSmall = 1; continue; }
    if (SMALL[word] !== undefined) {
      const value = SMALL[word];
      if (lastKind === 'small' || lastKind === 'teen' || (lastKind === 'tens' && value >= 10)) break;
      group += value; lastSmall = value; lastKind = value >= 10 ? 'teen' : 'small';
    } else if (TENS[word]) {
      if (['small', 'teen', 'tens'].includes(lastKind)) break;
      group += TENS[word]; lastKind = 'tens';
    } else if (word === 'hundred') {
      if (lastKind === 'hundred') break;
      group = (group || 1) * 100; lastKind = 'hundred';
    } else if (word === 'belas' && lastKind === 'small') {
      group += 10; lastKind = 'teen';
    } else if (word === 'puluh' && lastKind === 'small') {
      group += lastSmall * 9; lastKind = 'tens';
    } else if (word === 'ratus' && lastKind === 'small') {
      group += lastSmall * 99; lastKind = 'hundred';
    } else if (SCALES[word] && lastKind && lastKind !== 'scale') {
      total += group * SCALES[word]; group = 0; lastKind = 'scale';
    } else if (WHOLE[word] && (lastKind === null || lastKind === 'scale')) {
      if (WHOLE[word][1] === 'scale') total += WHOLE[word][0]; else group += WHOLE[word][0];
      lastKind = WHOLE[word][1];
    } else if (word === 'and' && lastKind && ['hundred', 'scale'].includes(lastKind) && (SMALL[next] !== undefined || TENS[next])) {
      continue;
    } else if (word === 'and' && lastKind && next === 'a' && tokens[j + 2]?.word === 'half') {
      fraction = 0.5; last = j + 2; break;
    } else if (word === 'setengah') {
      fraction = 0.5; last = j; break;
    } else if ((word === 'point' || word === 'koma') && lastKind && SMALL[next] !== undefined && SMALL[next] < 10) {
      let digits = '';
      let k = j + 1;
      while (k < tokens.length && joined(k) && SMALL[tokens[k].word] !== undefined && SMALL[tokens[k].word] < 10) { digits += SMALL[tokens[k].word]; k += 1; }
      fraction = Number(`0.${digits}`); last = k - 1; break;
    } else break;
    last = j;
  }
  if (last < i) return null;
  if (lastKind === null && fraction === null) return null;
  return { value: total + group + (fraction ?? 0), last };
}

// ---------- Scanning a text into numeric items ----------
const DIGITS = /(?<![\p{L}\p{N}])(?:[.,](?=\d))?\d+(?:[.,]\d+)*(?:[ \u00a0\u202f]\d{3}(?!\d))*(?:[.,]\d+)?/gu;
const DIGIT_SCALE = /^\s+(hundred|thousand|million|ratus|ribu|juta)(?![\p{L}])/u;
const RATIO = /^(?:\s*\/\s*|\s+(?:over|per)\s+)$/u;
const RANGE = /^(?:\s*[-–—]\s*|\s+(?:to|sampai|hingga|until|or|atau|s\/d)\s+)$/u;

function numerals(lower) {
  const list = [];
  for (const match of lower.matchAll(DIGITS)) {
    const parsed = parseNumeral(match[0]);
    let end = match.index + match[0].length;
    let { value } = parsed;
    const scale = lower.slice(end).match(DIGIT_SCALE);
    if (scale && value !== null) { value *= { hundred: 100, ratus: 100, thousand: 1e3, ribu: 1e3, million: 1e6, juta: 1e6 }[scale[1]]; end += scale[0].length; }
    list.push({ start: match.index, end, value, ambiguous: parsed.ambiguous });
  }
  const tokens = wordTokens(lower);
  for (let i = 0; i < tokens.length; i++) {
    const parsed = parseWords(lower, tokens, i);
    if (!parsed) continue;
    if (parsed.last === i && ['one', 'satu'].includes(tokens[i].word) && PRONOUN_BEFORE.has(tokens[i - 1]?.word)) continue;
    list.push({ start: tokens[i].start, end: tokens[parsed.last].end, value: parsed.value, ambiguous: false, unit: parsed.unit });
    i = parsed.last;
  }
  return list.sort((a, b) => a.start - b.start);
}

/** Groups numerals into singles, ratios and ranges, each with its unit. */
function scan(text) {
  const lower = lowerSameLength(text);
  const list = numerals(lower);
  const items = [];
  for (let i = 0; i < list.length; i++) {
    const parts = [list[i]];
    let kind = 'single';
    let spoken = false;
    while (i + 1 < list.length && !parts.at(-1).unit) {
      const gap = lower.slice(parts.at(-1).end, list[i + 1].start);
      const next = RATIO.test(gap) ? 'ratio' : RANGE.test(gap) ? 'range' : null;
      if (!next || (kind !== 'single' && kind !== next)) break;
      kind = next;
      spoken ||= /\p{L}/u.test(gap);
      parts.push(list[++i]);
    }
    const lastPart = parts.at(-1);
    const unit = lastPart.unit ? { unit: lastPart.unit, end: lastPart.end } : unitAt(lower, lastPart.end);
    items.push({
      kind, spoken, values: parts.map((part) => part.value), ambiguous: parts.some((part) => part.ambiguous),
      unit: unit?.unit ?? null, start: parts[0].start, numberEnd: lastPart.end, end: unit?.end ?? lastPart.end,
    });
  }
  return items;
}

const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Indexes the numbers in a transcript (digits and English/Indonesian number words). */
export function indexNumbers(transcript) {
  const items = scan(transcript).filter((item) => !item.ambiguous);
  // Speech uses "from 5 to 10 mg" for changes as well as ranges, so spoken ranges also index their
  // ends. Written ranges ("2-3 days") stay whole: "3 days" is not confirmed by them.
  const ends = items.filter((item) => item.kind === 'range' && item.spoken).flatMap((item) => item.values.map((value) => ({ ...item, kind: 'single', values: [value] })));
  return { items: [...items, ...ends] };
}

function valuesMatch(statement, item) {
  if (statement.kind === 'single') {
    if (item.kind === 'single') return same(item.values[0], statement.values[0]);
    return item.kind === 'ratio' && item.values.some((value) => same(value, statement.values[0]));
  }
  return item.kind === statement.kind && item.values.length === statement.values.length && item.values.every((value, i) => same(value, statement.values[i]));
}

/**
 * Checks every number in a statement (digits or number words, with its unit when present)
 * against the transcript.
 * @returns {Array<{ text: string, number: string, unit: string|null, found: boolean, reason?: 'ambiguous'|'unit'|'absent' }>}
 */
export function checkNumbers(statementText, transcriptIndex) {
  return scan(statementText).map((item) => {
    const result = { text: statementText.slice(item.start, item.end).trim(), number: statementText.slice(item.start, item.numberEnd), unit: item.unit, found: false };
    if (item.ambiguous) return { ...result, reason: 'ambiguous' };
    const candidates = transcriptIndex.items.filter((candidate) => valuesMatch(item, candidate));
    if (!candidates.length) return { ...result, reason: 'absent' };
    if (item.unit && !candidates.some((candidate) => candidate.unit === item.unit)) return { ...result, reason: 'unit' };
    return { ...result, found: true };
  });
}
