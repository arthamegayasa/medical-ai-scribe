// The editable note in app state, and how it maps to the engine's note shape and verifier.
import { SECTIONS, NOTE_LIMITS } from '../../../core/soap/schema.js';
import { LANGUAGES } from '../../../core/soap/prompt.js';
import { turnIdsForSpan, spanPiecesByTurn } from './transcript.js';

let counter = 0;
export function newStatementId(prefix = 's') {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

const NOT_DOCUMENTED = new Set(Object.values(LANGUAGES).map((language) => language.notDocumented));

/** Engine note `{ section: [{text, evidence}], review_flags }` -> app note with stable ids. */
export function fromEngineNote(note, makeId = newStatementId) {
  const sections = Object.fromEntries(SECTIONS.map((key) => [key, (note[key] || [])
    .filter((item) => !(item.evidence.length === 0 && NOT_DOCUMENTED.has(item.text)))
    .map((item) => ({ id: makeId('s'), text: item.text, evidence: [...item.evidence] }))]));
  const flags = (note.review_flags || []).map((flag) => ({ id: makeId('f'), type: flag.type, text: flag.text, evidence: [...flag.evidence], resolved: false }));
  return { sections, flags };
}

/** Section items from a regenerated section, with ids. */
export function itemsFromEngine(items, makeId = newStatementId) {
  return items.filter((item) => !(item.evidence.length === 0 && NOT_DOCUMENTED.has(item.text))).map((item) => ({ id: makeId('s'), text: item.text, evidence: [...item.evidence] }));
}

/**
 * App note -> a valid engine note. Empty statements are dropped and an empty section becomes the
 * language's "not documented" line, so the result always passes the engine's strict validator.
 * `positions` maps statement ids to their index in the engine note.
 */
export function toEngineNote(note, language = 'en') {
  const notDocumented = (LANGUAGES[language] || LANGUAGES.en).notDocumented;
  const positions = new Map();
  const engine = {};
  for (const key of SECTIONS) {
    const items = [];
    for (const item of note.sections[key] || []) {
      const text = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_LIMITS.statementChars);
      if (!text || items.length >= NOTE_LIMITS.statementsPerSection) continue;
      positions.set(item.id, [key, items.length]);
      items.push({ text, evidence: (item.evidence || []).slice(0, NOTE_LIMITS.quotesPerStatement) });
    }
    engine[key] = items.length ? items : [{ text: notDocumented, evidence: [] }];
  }
  engine.review_flags = (note.flags || []).filter((flag) => String(flag.text || '').trim()).slice(0, NOTE_LIMITS.flags)
    .map((flag) => ({ type: flag.type, text: String(flag.text).trim().slice(0, NOTE_LIMITS.statementChars), evidence: (flag.evidence || []).slice(0, NOTE_LIMITS.quotesPerStatement) }));
  return { note: engine, positions };
}

function resultView(result, ranges) {
  if (!result) return { status: 'none', turnIds: [], pieces: [], numberIssues: [] };
  const found = result.quotes.filter((quote) => quote.found);
  const turnIds = [...new Set(found.flatMap((quote) => turnIdsForSpan(ranges, quote.start, quote.end)))];
  const pieces = found.flatMap((quote) => spanPiecesByTurn(ranges, quote.start, quote.end));
  return {
    status: result.status === 'grounded' ? 'grounded' : result.status === 'not_documented' ? 'none' : 'unverified',
    turnIds,
    pieces,
    numberIssues: result.numbers.filter((n) => !n.found).map((n) => n.text),
  };
}

/**
 * Joins the verifier's results to app statements and flags.
 * @returns {{ statements: Map<string, {status, turnIds, pieces, numberIssues}>, flags: Map<string, {status, turnIds, pieces, target: string|null}>, summary }}
 */
export function annotate(note, verification, positions, ranges) {
  const statements = new Map();
  for (const key of SECTIONS) {
    for (const item of note.sections[key] || []) {
      const at = positions.get(item.id);
      statements.set(item.id, at ? resultView(verification.sections[at[0]][at[1]], ranges) : { status: 'none', turnIds: [], pieces: [], numberIssues: [] });
    }
  }
  const flags = new Map();
  const live = (note.flags || []).filter((flag) => String(flag.text || '').trim());
  live.forEach((flag, i) => {
    const view = resultView(verification.review_flags[i], ranges);
    let target = null;
    if (view.turnIds.length) {
      for (const key of SECTIONS) {
        const hit = (note.sections[key] || []).find((item) => statements.get(item.id)?.turnIds.some((id) => view.turnIds.includes(id)));
        if (hit) { target = hit.id; break; }
      }
    }
    flags.set(flag.id, { ...view, target });
  });
  let grounded = 0;
  let unverified = 0;
  let count = 0;
  for (const view of statements.values()) {
    count += 1;
    if (view.status === 'grounded') grounded += 1;
    if (view.status === 'unverified') unverified += 1;
  }
  return { statements, flags, summary: { statements: count, grounded, unverified } };
}

export const openFlagCount = (note) => (note?.flags || []).filter((flag) => !flag.resolved).length;
