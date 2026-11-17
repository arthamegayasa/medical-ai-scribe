// User preferences. These may persist on the device; they never contain encounter content or keys.
import { TEMPLATES } from '../../../core/soap/prompt.js';

export const PREFS_KEY = 'scribe.prefs';
export const NOTE_LANGUAGES = Object.freeze(['en', 'id']);
export const RETENTION_DAYS = Object.freeze([1, 7, 30, 0]);
export const VOCABULARY_LIMITS = Object.freeze({ terms: 300, termChars: 100 });

export const DEFAULT_PREFS = Object.freeze({
  noteLanguage: 'en',
  template: 'general',
  speakers: true,
  vocabulary: '',
  history: false,
  autoDeleteDays: 7,
  onboarded: false,
  selection: { transcription: { connectionId: null, model: '' }, note: { connectionId: null, model: '' } },
});

function cleanSelection(value) {
  const item = value && typeof value === 'object' ? value : {};
  return {
    connectionId: typeof item.connectionId === 'string' && item.connectionId.length <= 60 ? item.connectionId : null,
    model: typeof item.model === 'string' ? item.model.trim().slice(0, 200) : '',
  };
}

/** Returns a complete, valid preferences object from anything (stored JSON, partial patches). */
export function sanitizePrefs(raw, fallbackLanguage = 'en') {
  const value = raw && typeof raw === 'object' ? raw : {};
  const selection = value.selection && typeof value.selection === 'object' ? value.selection : {};
  return {
    noteLanguage: NOTE_LANGUAGES.includes(value.noteLanguage) ? value.noteLanguage : (NOTE_LANGUAGES.includes(fallbackLanguage) ? fallbackLanguage : 'en'),
    template: Object.hasOwn(TEMPLATES, value.template) ? value.template : 'general',
    speakers: typeof value.speakers === 'boolean' ? value.speakers : true,
    vocabulary: typeof value.vocabulary === 'string' ? value.vocabulary.slice(0, 40000) : '',
    history: value.history === true,
    autoDeleteDays: RETENTION_DAYS.includes(Number(value.autoDeleteDays)) ? Number(value.autoDeleteDays) : 7,
    onboarded: value.onboarded === true,
    selection: { transcription: cleanSelection(selection.transcription), note: cleanSelection(selection.note) },
  };
}

/** Splits the vocabulary box (commas, semicolons or new lines) into unique terms within engine limits. */
export function vocabularyList(text) {
  if (typeof text !== 'string') return [];
  const seen = new Set();
  const terms = [];
  for (const piece of text.split(/[\n,;]+/)) {
    const term = piece.trim();
    const key = term.toLowerCase();
    if (!term || term.length > VOCABULARY_LIMITS.termChars || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === VOCABULARY_LIMITS.terms) break;
  }
  return terms;
}
