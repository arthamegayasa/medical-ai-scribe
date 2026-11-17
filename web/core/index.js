// Public entry point of the isomorphic engine. Browser-only audio decoding is exported separately
// from ./audio/decode.browser.js so Node never loads Web Audio code.
export { ScribeError, ERROR_CODES } from './errors.js';
export { PROVIDERS, getProvider, listProviders, resolveConnection, validateBaseUrl, suggestedModels } from './providers.js';
export { listModels, testConnection } from './models.js';
export { generateText } from './chat.js';
export { parsePartialJson } from './partial-json.js';
export { hashText, estimateTokens } from './text.js';
export { SECTIONS, FLAG_TYPES, NOTE_SCHEMA, NOTE_LIMITS, parseNote, validateNote } from './soap/schema.js';
export { LANGUAGES, TEMPLATES, CUSTOM_INSTRUCTIONS_MAX, buildSoapPrompt } from './soap/prompt.js';
export { TRANSCRIPT_LIMITS, generateNote, regenerateSection } from './soap/generate.js';
export { verifyNote, findQuote, indexTranscript, isWeakQuote, summarizeVerification, STATUSES, checkNumbers, indexNumbers } from './soap/evidence.js';
export { SPEAKERS, labelSpeakers, verifyLabelledTurns, turnsToText } from './speakers.js';
export { transcribe, transcribeSegments, mergeTranscripts, transcriptToText } from './transcribe.js';
export { TARGET_SAMPLE_RATE, downmixToMono, resample, encodeWav, maxSegmentSeconds, planSegments, chooseUploadStrategy } from './audio/pcm.js';
export { toMarkdown, toPlainText, toHtml, toDocx, DOCX_MIME } from './export/formats.js';
export { createServerClient } from './server-client.js';
