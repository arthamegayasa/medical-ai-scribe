import { SECTIONS } from './schema.js';
import { LANGUAGES } from './prompt.js';

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Lowercases, strips diacritics and turns punctuation/whitespace runs into single spaces while
 * remembering, for every normalised character, the [start, end) range in the original text.
 */
export function normalizeWithMap(text) {
  let normalized = '';
  const starts = [];
  const ends = [];
  let index = 0;
  for (const char of text) {
    const end = index + char.length;
    const folded = char.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    for (const piece of folded) {
      if (WORD_CHAR.test(piece)) {
        normalized += piece; starts.push(index); ends.push(end);
      } else if (normalized && !normalized.endsWith(' ')) {
        normalized += ' '; starts.push(index); ends.push(end);
      }
    }
    index = end;
  }
  if (normalized.endsWith(' ')) { normalized = normalized.slice(0, -1); starts.pop(); ends.pop(); }
  return { normalized, starts, ends };
}

function tokenize(normalized) {
  const tokens = [];
  const pattern = /\S+/g;
  let match;
  while ((match = pattern.exec(normalized))) tokens.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  return tokens;
}

function editDistance(a, b, limit) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

/** Prepares a transcript once for many quote lookups. */
export function indexTranscript(transcript) {
  const map = normalizeWithMap(transcript);
  const tokens = tokenize(map.normalized);
  return { ...map, tokens, words: tokens.map(token => token.word) };
}

function toOriginal(index, from, to) {
  return { start: index.starts[from], end: index.ends[to - 1] };
}

/**
 * Finds a quote in an indexed transcript. Exact (normalised, word-aligned) matches come first;
 * otherwise a token-level match within ~15% word edits is accepted for quotes of 3+ words.
 * @returns {{ found: true, start: number, end: number, exact: boolean } | { found: false }}
 */
export function findQuote(index, quote) {
  const needle = normalizeWithMap(quote).normalized;
  if (needle.length < 2) return { found: false };
  const haystack = index.normalized;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = at === 0 || haystack[at - 1] === ' ';
    const after = at + needle.length === haystack.length || haystack[at + needle.length] === ' ';
    if (before && after) return { found: true, ...toOriginal(index, at, at + needle.length), exact: true };
  }
  const words = needle.split(' ');
  if (words.length < 3) return { found: false };
  const limit = Math.max(1, Math.floor(words.length * 0.15));
  const tokens = index.tokens;
  const anchors = [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 3);
  let best = null;
  for (const anchor of anchors) {
    const offsetInQuote = words.indexOf(anchor);
    for (let position = index.words.indexOf(anchor); position !== -1; position = index.words.indexOf(anchor, position + 1)) {
      for (let shift = -limit; shift <= limit; shift++) {
        const from = position - offsetInQuote + shift;
        for (let length = words.length - limit; length <= words.length + limit; length++) {
          if (from < 0 || length < 1 || from + length > tokens.length) continue;
          const distance = editDistance(words, index.words.slice(from, from + length), limit);
          if (distance <= limit && (!best || distance < best.distance)) best = { distance, from, length };
        }
      }
    }
  }
  if (!best) return { found: false };
  const first = tokens[best.from];
  const last = tokens[best.from + best.length - 1];
  return { found: true, ...toOriginal(index, first.start, last.end), exact: false };
}

const UNIT_SYNONYMS = [
  ['mg', 'milligrams?', 'miligram'], ['mcg', 'µg', 'μg', 'micrograms?', 'mikrogram'], ['g', 'grams?', 'gram'], ['kg', 'kilograms?', 'kilos?'],
  ['ml', 'milliliters?', 'millilitres?', 'mililiter', 'cc'], ['l', 'liters?', 'litres?'], ['mmhg', 'mm hg', 'millimeters? of mercury'],
  ['bpm', 'beats per minute', 'per minute', 'kali per menit'], ['%', 'percent', 'per cent', 'persen'], ['°c', 'degrees?', 'derajat', 'celsius'],
  ['°f', 'degrees?', 'fahrenheit'], ['iu', 'units?', 'unit'], ['units?', 'iu', 'unit'], ['mmol/l', 'mmol', 'millimoles?'], ['mg/dl', 'milligrams? per deciliter'],
  ['cm', 'centimeters?', 'centimetres?', 'sentimeter'], ['mm', 'millimeters?', 'millimetres?', 'milimeter'],
  ['tablets?', 'tabs?', 'pills?', 'tablet'], ['puffs?', 'semprot'],
];
const UNIT_PATTERN = '(mg\\/dl|mmol\\/l|mmhg|mm hg|mcg|µg|μg|mg|kg|ml|bpm|iu|units?|tablets?|tabs?|puffs?|cm|mm|°c|°f|%|g|l)(?![\\p{L}\\p{N}])';
const NUMBER_WITH_UNIT = new RegExp(`(?<![\\p{L}\\p{N}.,])(\\d+(?:[.,]\\d+)*)(?:\\s?${UNIT_PATTERN})?`, 'giu');

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
  nol: 0, satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, delapan: 8, sembilan: 9, sepuluh: 10, sebelas: 11, seratus: 100,
};

function numberVariants(raw) {
  return new Set([raw, raw.replace(/,/g, ''), raw.replace(/,/g, '.'), raw.replace(/\./g, ''), raw.replace(/\./g, '').replace(/,/g, '.')]);
}

function unitAlternatives(unit) {
  const lower = unit.toLowerCase().replace(/\s+/g, '');
  const group = UNIT_SYNONYMS.find(entry => new RegExp(`^(?:${entry[0]})$`, 'u').test(lower));
  return group ? group : [lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')];
}

/** Indexes the numbers in a transcript (digits plus common English/Indonesian number words). */
export function indexNumbers(transcript) {
  const lower = transcript.toLowerCase();
  const numbers = new Map();
  for (const match of lower.matchAll(/(?<![\p{L}\p{N}.,])\d+(?:[.,]\d+)*/gu)) {
    for (const variant of numberVariants(match[0])) {
      if (!numbers.has(variant)) numbers.set(variant, []);
      numbers.get(variant).push(match.index + match[0].length);
    }
  }
  for (const match of lower.matchAll(/\p{L}+/gu)) {
    const value = NUMBER_WORDS[match[0]];
    if (value === undefined) continue;
    const key = String(value);
    if (!numbers.has(key)) numbers.set(key, []);
    numbers.get(key).push(match.index + match[0].length);
  }
  return { lower, numbers };
}

/**
 * Flags every number (with its unit, when present) in a statement that the transcript does not
 * contain. A number is matched by value across decimal-comma/point and thousands separators.
 * @returns {Array<{ text: string, number: string, unit: string|null, found: boolean }>}
 */
export function checkNumbers(statementText, transcriptIndex) {
  const results = [];
  for (const match of statementText.matchAll(NUMBER_WITH_UNIT)) {
    const [text, number, unit] = match;
    const ends = [...numberVariants(number)].flatMap(variant => transcriptIndex.numbers.get(variant) ?? []);
    let found = ends.length > 0;
    if (found && unit) {
      const units = new RegExp(`^\\s*(?:${unitAlternatives(unit).join('|')})(?![\\p{L}])`, 'u');
      found = ends.some(end => units.test(transcriptIndex.lower.slice(end, end + 40)));
    }
    results.push({ text: text.trim(), number, unit: unit ?? null, found });
  }
  return results;
}

function verifyStatement(statement, index, numberIndex, notDocumented) {
  if (statement.evidence.length === 0 && notDocumented.has(statement.text)) return { status: 'not_documented', quotes: [], numbers: [] };
  const quotes = statement.evidence.map(quote => ({ quote, ...findQuote(index, quote) }));
  const grounded = quotes.length > 0 && quotes.every(quote => quote.found);
  return { status: grounded ? 'grounded' : 'unverified', quotes, numbers: checkNumbers(statement.text, numberIndex) };
}

/**
 * Deterministically checks every statement and review flag of a note against its transcript.
 * Offsets are UTF-16 indices into the original transcript, suitable for highlighting.
 */
export function verifyNote(note, transcript) {
  const index = indexTranscript(transcript);
  const numberIndex = indexNumbers(transcript);
  const notDocumented = new Set(Object.values(LANGUAGES).map(language => language.notDocumented));
  const sections = Object.fromEntries(SECTIONS.map(key => [key, note[key].map(item => verifyStatement(item, index, numberIndex, notDocumented))]));
  const reviewFlags = (note.review_flags ?? []).map(item => verifyStatement(item, index, numberIndex, notDocumented));
  const all = Object.values(sections).flat();
  return {
    sections,
    review_flags: reviewFlags,
    summary: {
      statements: all.length,
      grounded: all.filter(item => item.status === 'grounded').length,
      unverified: all.filter(item => item.status === 'unverified').length,
      notDocumented: all.filter(item => item.status === 'not_documented').length,
      numberIssues: all.reduce((count, item) => count + item.numbers.filter(n => !n.found).length, 0),
    },
  };
}
