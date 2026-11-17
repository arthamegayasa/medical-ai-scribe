import { invalidInput } from '../errors.js';
import { generateText } from '../chat.js';
import { parsePartialJson } from '../partial-json.js';
import { hashText } from '../text.js';
import { NOTE_SCHEMA, SECTION_SCHEMA, SECTIONS, parseNote, parseSection, validateNote } from './schema.js';
import { buildSoapPrompt, sectionTask, transcriptMessage } from './prompt.js';

// About 60-75 minutes of conversational speech; most current models accept far more tokens.
export const TRANSCRIPT_LIMITS = Object.freeze({ minChars: 10, maxChars: 250000 });

export function checkTranscript(transcript) {
  if (typeof transcript !== 'string' || transcript.trim().length < TRANSCRIPT_LIMITS.minChars) {
    throw invalidInput(`Enter a transcript with at least ${TRANSCRIPT_LIMITS.minChars} characters.`);
  }
  if (transcript.length > TRANSCRIPT_LIMITS.maxChars) {
    throw invalidInput(`The transcript must be no longer than ${TRANSCRIPT_LIMITS.maxChars.toLocaleString('en-US')} characters.`);
  }
  return transcript.trim();
}

function streamHandlers(stream, onPartial) {
  if (!stream || !onPartial) return undefined;
  return ({ text }) => {
    const partial = parsePartialJson(text);
    if (partial !== undefined) onPartial({ text, partial });
  };
}

/**
 * Generates a draft SOAP note.
 * @returns {Promise<{ note: object, meta: { provider, model, template, language, structuredMode, generatedAt, transcriptHash, draft: true } }>}
 */
export async function generateNote({
  connection, model, transcript, language = 'en', template = 'general', customInstructions = '',
  stream = false, onPartial, maxOutputTokens = 16000, structured = 'auto', signal, timeoutMs, fetchImpl, now = () => new Date(),
}) {
  const source = checkTranscript(transcript);
  const system = buildSoapPrompt({ language, template, customInstructions });
  const { text, mode } = await generateText({
    connection, model, system, user: transcriptMessage(source), schema: NOTE_SCHEMA, schemaName: 'soap_note',
    structured, maxOutputTokens, stream, onDelta: streamHandlers(stream, onPartial), signal, timeoutMs, fetchImpl,
  });
  return {
    note: parseNote(text),
    meta: {
      provider: connection.provider, model, template, language, structuredMode: mode,
      generatedAt: now().toISOString(), transcriptHash: hashText(source), draft: true,
    },
  };
}

/**
 * Regenerates one section from the transcript, using the rest of the note as context.
 * @returns {Promise<{ note: object, items: Array<{text, evidence}>, structuredMode: string }>}
 */
export async function regenerateSection({
  connection, model, transcript, note, section, language = 'en', template = 'general', customInstructions = '',
  stream = false, onPartial, maxOutputTokens = 8000, structured = 'auto', signal, timeoutMs, fetchImpl,
}) {
  if (!SECTIONS.includes(section)) throw invalidInput('Choose a SOAP section to regenerate.');
  const current = validateNote(note);
  const source = checkTranscript(transcript);
  const others = Object.fromEntries(SECTIONS.filter(key => key !== section).map(key => [key, current[key].map(item => item.text)]));
  const system = `${buildSoapPrompt({ language, template, customInstructions })}\n\n${sectionTask(section, others)}`;
  const { text, mode } = await generateText({
    connection, model, system, user: transcriptMessage(source), schema: SECTION_SCHEMA, schemaName: 'soap_section',
    structured, maxOutputTokens, stream, onDelta: streamHandlers(stream, onPartial), signal, timeoutMs, fetchImpl,
  });
  const items = parseSection(text);
  return { note: { ...current, [section]: items }, items, structuredMode: mode };
}
