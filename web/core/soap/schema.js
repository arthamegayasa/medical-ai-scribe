import { ScribeError } from '../errors.js';

export const SECTIONS = Object.freeze(['chief_complaint', 'subjective', 'objective', 'assessment', 'plan']);
export const FLAG_TYPES = Object.freeze(['unclear', 'contradiction', 'uncertain_number', 'uncertain_medication', 'possible_mistranscription', 'other']);
export const NOTE_LIMITS = Object.freeze({
  outputChars: 600000, statementChars: 2000, quoteChars: 600, quotesPerStatement: 8, statementsPerSection: 100, flags: 60,
});

const statement = {
  type: 'object',
  properties: { text: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
  required: ['text', 'evidence'], additionalProperties: false,
};
const flag = {
  type: 'object',
  properties: { type: { type: 'string', enum: [...FLAG_TYPES] }, text: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
  required: ['type', 'text', 'evidence'], additionalProperties: false,
};

// Written to the intersection supported by OpenAI strict mode, Anthropic, Gemini and Mistral.
export const NOTE_SCHEMA = Object.freeze({
  type: 'object',
  properties: { ...Object.fromEntries(SECTIONS.map(key => [key, { type: 'array', items: statement }])), review_flags: { type: 'array', items: flag } },
  required: [...SECTIONS, 'review_flags'], additionalProperties: false,
});
export const SECTION_SCHEMA = Object.freeze({
  type: 'object', properties: { items: { type: 'array', items: statement } }, required: ['items'], additionalProperties: false,
});

const fail = () => new ScribeError('invalid_output');

function parseObject(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > NOTE_LIMITS.outputChars) throw fail();
  const cleaned = text.trim().replace(/^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i, '$1').trim();
  let data;
  try { data = JSON.parse(cleaned); } catch { throw fail(); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail();
  return data;
}

const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function cleanText(value, max) {
  if (typeof value !== 'string') throw fail();
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw fail();
  return trimmed;
}

function cleanEvidence(value) {
  if (!Array.isArray(value) || value.length > NOTE_LIMITS.quotesPerStatement) throw fail();
  return value.map(quote => cleanText(quote, NOTE_LIMITS.quoteChars));
}

function cleanStatements(value) {
  if (!Array.isArray(value) || !value.length || value.length > NOTE_LIMITS.statementsPerSection) throw fail();
  return value.map(item => {
    if (!exactKeys(item, ['text', 'evidence'])) throw fail();
    return { text: cleanText(item.text, NOTE_LIMITS.statementChars), evidence: cleanEvidence(item.evidence) };
  });
}

/** Strictly validates model output into a note. Throws ScribeError('invalid_output'). */
export function parseNote(text) {
  const data = parseObject(text);
  if (!exactKeys(data, [...SECTIONS, 'review_flags'])) throw fail();
  const note = Object.fromEntries(SECTIONS.map(key => [key, cleanStatements(data[key])]));
  if (!Array.isArray(data.review_flags) || data.review_flags.length > NOTE_LIMITS.flags) throw fail();
  note.review_flags = data.review_flags.map(item => {
    if (!exactKeys(item, ['type', 'text', 'evidence']) || !FLAG_TYPES.includes(item.type)) throw fail();
    return { type: item.type, text: cleanText(item.text, NOTE_LIMITS.statementChars), evidence: cleanEvidence(item.evidence) };
  });
  return note;
}

/** Validates a regenerated section `{ items: [...] }` and returns the statement list. */
export function parseSection(text) {
  const data = parseObject(text);
  if (!exactKeys(data, ['items'])) throw fail();
  return cleanStatements(data.items);
}

/** Checks that a value already in memory (e.g. edited by the UI) is a well-formed note. */
export function validateNote(note) {
  return parseNote(JSON.stringify(note));
}
