import { SECTIONS } from './schema.js';
import { LANGUAGES } from './prompt.js';
import { checkNumbers, indexNumbers } from './numbers.js';

export { checkNumbers, indexNumbers };

const WORD_CHAR = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;
// Inside a number these stay part of the token, so "2.5", "1,000", "120/80" and "2-3" are single
// words: a quote can never start or end inside them ("5 mg" is not found in "2.5 mg").
const NUMBER_JOINERS = new Set(['.', ',', '/', ':', '-']);
const DASHES = /[\p{Pd}]/u;
// Sentence punctuation. A quote may cross one only if it contains one there too. Line breaks are
// not boundaries: pasted transcripts often wrap mid-sentence.
const STRONG = /[.!?;…。]/u;
export const BOUNDARY = '|';

function fold(char) {
  return char.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Normalises text for quote matching while remembering, for every normalised character, the
 * [start, end) UTF-16 range in the original text:
 * - case and diacritics are folded, every other run of punctuation and whitespace becomes one
 *   space (so quote marks, commas, dashes and line endings never matter);
 * - "." "," "/" ":" and dashes between two digits are kept, so numbers stay whole tokens, and a
 *   letter right after a digit starts a new word ("500mg" reads as "500 mg");
 * - with `boundaries` (the default), a run that contains sentence punctuation (. ! ? ; or an
 *   ellipsis) becomes the token "|" instead, so a quote cannot silently run across a sentence
 *   boundary ("No. Chest pain" does not support "no chest pain").
 */
export function normalizeWithMap(text, { boundaries = true } = {}) {
  const chars = [];
  let index = 0;
  for (const char of text) {
    chars.push({ char, start: index, end: index + char.length, folded: fold(char) });
    index += char.length;
  }
  let normalized = '';
  const starts = [];
  const ends = [];
  let previous = ''; // last normalised character (reading the end of a growing string is slow)
  const push = (piece, from) => { normalized += piece; previous = piece; starts.push(from.start); ends.push(from.end); };
  let gap = null;      // first separator character of the pending run
  let strong = null;   // first sentence boundary in the pending run
  for (let i = 0; i < chars.length; i++) {
    const current = chars[i];
    for (const piece of current.folded) {
      if (WORD_CHAR.test(piece)) {
        if (normalized && gap) {
          if (boundaries && strong) { push(' ', strong); push(BOUNDARY, strong); push(' ', strong); } else push(' ', gap);
        }
        // A unit glued to its number ("500mg") reads like the spaced form ("500 mg").
        else if (DIGIT.test(previous) && !DIGIT.test(piece)) push(' ', current);
        gap = null; strong = null;
        push(piece, current);
        continue;
      }
      const joiner = NUMBER_JOINERS.has(piece) || DASHES.test(piece);
      const nextFolded = chars[i + 1]?.folded[0] ?? '';
      if (joiner && !gap && DIGIT.test(previous) && DIGIT.test(nextFolded) && current.folded.length === 1) {
        push(DASHES.test(piece) ? '-' : piece, current);
        continue;
      }
      if (!gap) gap = current;
      if (!strong && STRONG.test(current.char)) strong = current;
    }
  }
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
  const strict = normalizeWithMap(transcript);
  const loose = normalizeWithMap(transcript, { boundaries: false });
  const tokens = tokenize(loose.normalized);
  return { ...strict, loose: { ...loose, tokens, words: tokens.map(token => token.word) } };
}

// Words that carry no evidence on their own (fillers, pronouns, speaker labels), English and Indonesian.
const FILLER = new Set(`a an the and or but of to in on at for with by from as if so it its is are was were be been am i you he she we they me my your his her our
their this that these those there here yes yeah yep no nope not ok okay alright right well um uh erm hmm mm mhm oh ah sure thanks thank please just
also very really do does did have has had can could will would what how when where who why which then than out up like doctor dr patient other speaker
unknown unlabelled ya iya tidak nggak enggak gak ga ndak dan atau yang di ke dari itu ini saya aku anda kamu dia kami kita mereka dokter pasien baik
oke sudah belum ada juga sangat saja aja dengan untuk pada dalam apa bagaimana kapan mana siapa kenapa mengapa terima kasih nah eh hm lah kok sih dong
kan jadi kalau karena tapi bu pak mas mbak`.split(/\s+/));

/**
 * A quote too weak to be evidence: fewer than three letters or digits, a bare number, or only
 * filler words. Such a quote would "match" almost any transcript.
 */
export function isWeakQuote(normalizedQuote) {
  const words = normalizedQuote.split(' ').filter(word => word && word !== BOUNDARY);
  if (words.join('').length < 3) return true;
  if (words.length === 1 && /^[\p{N}.,/:-]+$/u.test(words[0])) return true;
  return words.every(word => FILLER.has(word));
}

function alignedFind(map, needle) {
  const haystack = map.normalized;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = at === 0 || haystack[at - 1] === ' ';
    const after = at + needle.length === haystack.length || haystack[at + needle.length] === ' ';
    if (before && after) return { start: map.starts[at], end: map.ends[at + needle.length - 1] };
  }
  return null;
}

/**
 * Finds a quote in an indexed transcript.
 * - `match: 'exact'`: the quote occurs word-aligned after normalisation (see normalizeWithMap).
 *   Only exact matches can make a statement grounded.
 * - `match: 'approximate'`: the quote only matches when sentence boundaries are ignored, or (for
 *   quotes of 3+ words) within about 15% word edits. A close match can hide a changed negation
 *   ("I am allergic" vs "I am not allergic"), so it always needs the clinician to check the wording.
 * - not found, with `reason: 'weak'` for quotes too short or generic to be evidence.
 * @returns {{ found: true, start: number, end: number, exact: boolean, match: 'exact'|'approximate' } | { found: false, reason: 'weak'|'absent' }}
 */
export function findQuote(index, quote) {
  const strict = normalizeWithMap(String(quote ?? '')).normalized;
  if (isWeakQuote(strict)) return { found: false, reason: 'weak' };
  const exact = alignedFind(index, strict);
  if (exact) return { found: true, ...exact, exact: true, match: 'exact' };
  const loose = index.loose;
  const needle = normalizeWithMap(String(quote), { boundaries: false }).normalized;
  const close = alignedFind(loose, needle);
  if (close) return { found: true, ...close, exact: false, match: 'approximate' };
  const words = needle.split(' ');
  if (words.length < 3) return { found: false, reason: 'absent' };
  const limit = Math.max(1, Math.floor(words.length * 0.15));
  const tokens = loose.tokens;
  const anchors = [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 3);
  let best = null;
  for (const anchor of anchors) {
    const offsetInQuote = words.indexOf(anchor);
    for (let position = loose.words.indexOf(anchor); position !== -1; position = loose.words.indexOf(anchor, position + 1)) {
      for (let shift = -limit; shift <= limit; shift++) {
        const from = position - offsetInQuote + shift;
        for (let length = words.length - limit; length <= words.length + limit; length++) {
          if (from < 0 || length < 1 || from + length > tokens.length) continue;
          const distance = editDistance(words, loose.words.slice(from, from + length), limit);
          if (distance <= limit && (!best || distance < best.distance)) best = { distance, from, length };
        }
      }
    }
  }
  if (!best) return { found: false, reason: 'absent' };
  const first = tokens[best.from];
  const last = tokens[best.from + best.length - 1];
  return { found: true, start: loose.starts[first.start], end: loose.ends[last.end - 1], exact: false, match: 'approximate' };
}

/** Statuses a statement can have. `edited` and `clinician` are assigned by the app (see README). */
export const STATUSES = Object.freeze(['grounded', 'approximate', 'unverified', 'not_documented', 'edited', 'clinician']);

function verifyStatement(statement, index, numberIndex, notDocumented) {
  if (statement.evidence.length === 0 && notDocumented.has(statement.text)) return { status: 'not_documented', quotes: [], numbers: [] };
  const quotes = statement.evidence.map(quote => ({ quote, ...findQuote(index, quote) }));
  let status = 'unverified';
  if (quotes.length > 0 && quotes.every(quote => quote.found)) status = quotes.every(quote => quote.exact) ? 'grounded' : 'approximate';
  return { status, quotes, numbers: checkNumbers(statement.text, numberIndex) };
}

/** Counts statuses and number issues over verified statements. */
export function summarizeVerification(sections) {
  const all = Object.values(sections).flat();
  const count = status => all.filter(item => item.status === status).length;
  return {
    statements: all.length,
    grounded: count('grounded'),
    approximate: count('approximate'),
    unverified: count('unverified'),
    edited: count('edited'),
    clinician: count('clinician'),
    notDocumented: count('not_documented'),
    numberIssues: all.reduce((total, item) => total + item.numbers.filter(n => !n.found).length, 0),
  };
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
  return { sections, review_flags: reviewFlags, summary: summarizeVerification(sections) };
}
