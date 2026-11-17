// Transcript turns: parsing pasted text, building turns from transcription results, and the exact
// source text sent to the note model (with per-turn offsets so evidence spans map back to turns).

export const SPEAKER_ROLES = Object.freeze(['doctor', 'patient', 'other', 'unknown']);
// Role markers in the text sent to the model stay in English: the engine's speaker pass uses them.
const SOURCE_LABELS = { doctor: 'Doctor', patient: 'Patient', other: 'Other' };
const LABEL_PATTERN = /^\s*(doctor|dr|dokter|clinician|physician|patient|pt|pasien|other|lainnya|family|keluarga|nurse|perawat)\s*[:：]\s*/i;
const LABEL_ROLE = {
  doctor: 'doctor', dr: 'doctor', dokter: 'doctor', clinician: 'doctor', physician: 'doctor',
  patient: 'patient', pt: 'patient', pasien: 'patient',
  other: 'other', lainnya: 'other', family: 'other', keluarga: 'other', nurse: 'other', perawat: 'other',
};
const MAX_TURN_CHARS = 420;

let counter = 0;
export function newTurnId() {
  counter += 1;
  return `t${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Splits unlabelled text into readable turns at paragraph, then sentence boundaries. */
export function splitPlain(text) {
  const out = [];
  for (const paragraph of String(text).split(/\n+/)) {
    let rest = paragraph.trim();
    while (rest.length > MAX_TURN_CHARS) {
      const head = rest.slice(0, MAX_TURN_CHARS);
      let cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
      cut = cut > MAX_TURN_CHARS / 3 ? cut + 1 : head.lastIndexOf(' ');
      if (cut <= 0) cut = MAX_TURN_CHARS;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * Parses pasted or typed text. Lines starting with "Doctor:", "Patient:", "Dokter:", "Pasien:" etc.
 * become labelled turns; unlabelled lines continue the previous labelled turn. Text without any
 * label becomes unlabelled turns.
 * @returns {{ turns: Array<{ id, speaker, text, start: null, end: null }>, labelled: boolean }}
 */
export function parsePasted(text, makeId = newTurnId) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const labelled = lines.some((line) => LABEL_PATTERN.test(line));
  if (!labelled) {
    return { turns: splitPlain(text).map((body) => ({ id: makeId(), speaker: 'unknown', text: body, start: null, end: null })), labelled: false };
  }
  const turns = [];
  for (const line of lines) {
    const match = LABEL_PATTERN.exec(line);
    if (match) {
      const body = line.slice(match[0].length).trim();
      turns.push({ id: makeId(), speaker: LABEL_ROLE[match[1].toLowerCase()], text: body, start: null, end: null });
    } else if (line.trim()) {
      if (turns.length) turns[turns.length - 1].text = `${turns[turns.length - 1].text} ${line.trim()}`.trim();
      else turns.push({ id: makeId(), speaker: 'unknown', text: line.trim(), start: null, end: null });
    }
  }
  return { turns: turns.filter((turn) => turn.text), labelled: true };
}

/**
 * Turns from a transcription result `{ text, segments: [{ start, end, text, speaker? }] }`.
 * Consecutive segments from the same diarized speaker are joined. Diarized speakers are
 * anonymous ("A", "2:B"); they are kept as `diarSpeaker` and the role starts as 'unknown'.
 */
export function turnsFromTranscript(result, makeId = newTurnId) {
  const segments = Array.isArray(result?.segments) ? result.segments.filter((s) => s && String(s.text || '').trim()) : [];
  const diarized = segments.some((s) => s.speaker !== undefined);
  if (!segments.length) {
    return { turns: splitPlain(result?.text || '').map((body) => ({ id: makeId(), speaker: 'unknown', text: body, start: null, end: null })), diarized: false, timed: false };
  }
  const turns = [];
  for (const segment of segments) {
    const last = turns[turns.length - 1];
    const text = String(segment.text).trim();
    const sameSpeaker = diarized && last && last.diarSpeaker === String(segment.speaker);
    if (sameSpeaker && last.text.length + text.length < MAX_TURN_CHARS * 2) {
      last.text = `${last.text} ${text}`;
      if (segment.end !== null && segment.end !== undefined) last.end = segment.end;
    } else {
      const turn = { id: makeId(), speaker: 'unknown', text, start: segment.start ?? null, end: segment.end ?? null };
      if (diarized && segment.speaker !== undefined) turn.diarSpeaker = String(segment.speaker);
      turns.push(turn);
    }
  }
  return { turns, diarized, timed: turns.some((turn) => turn.start !== null) };
}

/** Turns from the engine's speaker pass `[{ speaker: 'Doctor'|'Patient'|'Other', text }]`. */
export function turnsFromLabelled(labelledTurns, makeId = newTurnId) {
  return labelledTurns.map((turn) => ({ id: makeId(), speaker: String(turn.speaker).toLowerCase(), text: turn.text, start: null, end: null, aiSpeaker: true }));
}

export const hasRoles = (turns) => turns.some((turn) => turn.speaker !== 'unknown');

/**
 * The exact text sent to the note model, and where each turn's words sit in it.
 * `ranges[i] = { id, lineStart, start, end }` (UTF-16 offsets; `start..end` is the turn text).
 */
export function buildSource(turns, { speakers = true } = {}) {
  let text = '';
  const ranges = [];
  for (const turn of turns) {
    const body = String(turn.text || '').trim();
    if (!body) continue;
    if (text) text += '\n';
    const lineStart = text.length;
    const label = speakers && SOURCE_LABELS[turn.speaker] ? `${SOURCE_LABELS[turn.speaker]}: ` : '';
    text += label;
    const start = text.length;
    text += body;
    ranges.push({ id: turn.id, lineStart, start, end: text.length });
  }
  return { text, ranges };
}

/** Plain text of the transcript for copying (labels follow the given translations). */
export function transcriptForCopy(turns, labels, { speakers = true, timestamps = true } = {}) {
  return turns.filter((turn) => String(turn.text).trim()).map((turn) => {
    const parts = [];
    if (timestamps && Number.isFinite(turn.start)) parts.push(`[${clock(turn.start)}]`);
    if (speakers && turn.speaker !== 'unknown' && labels[turn.speaker]) parts.push(`${labels[turn.speaker]}:`);
    parts.push(String(turn.text).trim());
    return parts.join(' ');
  }).join('\n');
}

/** Turn ids whose line overlaps the span [start, end). */
export function turnIdsForSpan(ranges, start, end) {
  return ranges.filter((range) => range.lineStart < end && range.end > start).map((range) => range.id);
}

/** Splits a span of the source into per-turn pieces relative to each turn's text. */
export function spanPiecesByTurn(ranges, start, end) {
  const pieces = [];
  for (const range of ranges) {
    const from = Math.max(start, range.start);
    const to = Math.min(end, range.end);
    if (to > from) pieces.push({ id: range.id, start: from - range.start, end: to - range.start });
  }
  return pieces;
}

export function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
