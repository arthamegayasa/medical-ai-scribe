import { ScribeError, invalidInput } from './errors.js';
import { readJson, request, withRetry } from './http.js';
import { generateText } from './chat.js';
import { authHeaders, resolveConnection } from './providers.js';

const MAX_TEXT = 1_000_000;
const WHISPER_PROMPT_CHARS = 800; // whisper-style prompts are limited to 224 tokens
const EXTENSIONS = {
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
  'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
};

function cleanVocabulary(vocabulary) {
  if (vocabulary === undefined) return [];
  if (!Array.isArray(vocabulary) || vocabulary.length > 300) throw invalidInput('Vocabulary must be a list of at most 300 terms.');
  return [...new Set(vocabulary.map(term => (typeof term === 'string' ? term.trim() : '')).filter(term => term && term.length <= 100))];
}

function cleanLanguage(language) {
  if (language === undefined || language === 'auto') return null;
  if (typeof language !== 'string' || !/^[a-z]{2,3}$/.test(language)) throw invalidInput('Use "auto" or a two- or three-letter ISO 639 language code.');
  return language;
}

const seconds = value => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);

function segment(start, end, text, speaker) {
  const item = { start: seconds(start), end: seconds(end), text: String(text ?? '').trim() };
  if (speaker !== undefined && speaker !== null && speaker !== '') item.speaker = String(speaker);
  return item;
}

function checkedText(value) {
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw new ScribeError('invalid_response', 'The transcription provider returned an invalid transcript.');
  return value.trim();
}

function whisperPrompt(vocabulary, prompt) {
  return [prompt, vocabulary.length ? vocabulary.join(', ') : ''].filter(Boolean).join(' ').slice(0, WHISPER_PROMPT_CHARS);
}

/** Multipart fields for OpenAI-style /audio/transcriptions endpoints, per dialect and model. */
function openAiStyleForm(dialect, { audio, filename, model, language, vocabulary, prompt, diarize, timestamps }) {
  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model', model);
  const add = (key, value) => form.append(key, value);
  if (dialect === 'openai' && /diarize/.test(model)) {
    add('response_format', 'diarized_json');
    add('chunking_strategy', 'auto');
    if (language) add('language', language);
  } else if (dialect === 'openai' && model === 'gpt-transcribe') {
    add('response_format', 'json');
    for (const term of vocabulary) add('keywords[]', term);
    if (language) add('languages[]', language);
    if (prompt) add('prompt', prompt);
  } else if (dialect === 'openai' && model !== 'whisper-1') {
    add('response_format', 'json');
    if (language) add('language', language);
    const text = whisperPrompt(vocabulary, prompt);
    if (text) add('prompt', text);
  } else if (dialect === 'mistral') {
    // Mistral rejects language together with timestamp_granularities; the language hint wins.
    if (language) add('language', language);
    else if (timestamps) add('timestamp_granularities', 'segment');
    if (diarize) add('diarize', 'true');
    for (const term of vocabulary.slice(0, 100)) add('context_bias', term);
  } else {
    add('response_format', timestamps ? 'verbose_json' : 'json');
    if (timestamps && dialect !== 'basic') add('timestamp_granularities[]', 'segment');
    if (language) add('language', language);
    const text = whisperPrompt(vocabulary, prompt);
    if (text) add('prompt', text);
  }
  return form;
}

function parseOpenAiStyle(data) {
  const text = checkedText(data.text);
  const raw = Array.isArray(data.segments) ? data.segments : [];
  const segments = raw.filter(s => s && typeof s.text === 'string').map(s => segment(s.start, s.end, s.text, s.speaker ?? s.speaker_id));
  const language = typeof data.language === 'string' ? data.language : (Array.isArray(data.languages) && typeof data.languages[0]?.code === 'string' ? data.languages[0].code : null);
  return { text, segments, language };
}

function parseDeepgram(data) {
  const alternative = data.results?.channels?.[0]?.alternatives?.[0];
  const text = checkedText(alternative?.transcript);
  const utterances = Array.isArray(data.results?.utterances) ? data.results.utterances : [];
  const segments = utterances.filter(u => typeof u?.transcript === 'string').map(u => segment(u.start, u.end, u.transcript, u.speaker));
  const language = data.results?.channels?.[0]?.detected_language ?? null;
  return { text, segments, language: typeof language === 'string' ? language : null };
}

function parseElevenLabs(data, diarize) {
  const text = checkedText(data.text);
  const segments = [];
  for (const word of Array.isArray(data.words) ? data.words : []) {
    if (!word || typeof word.text !== 'string' || word.type === 'audio_event') continue;
    const speaker = diarize ? word.speaker_id : undefined;
    const last = segments.at(-1);
    const sentenceEnded = last && /[.?!]\s*$/.test(last.text);
    if (word.type === 'spacing') { if (last) last.text += word.text; continue; }
    if (!last || (diarize && last.speaker !== (speaker == null ? undefined : String(speaker))) || sentenceEnded) segments.push(segment(word.start, word.end, word.text, speaker));
    else { last.text += word.text; last.end = seconds(word.end); }
  }
  for (const item of segments) item.text = item.text.trim();
  return { text, segments: segments.filter(item => item.text), language: typeof data.language_code === 'string' ? data.language_code : null };
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function geminiInstruction(language, vocabulary, prompt) {
  return [
    'Transcribe this clinical consultation audio verbatim. Write exactly the words spoken, in the language spoken, without summarising, correcting, translating or adding anything. Do not add speaker labels, timestamps or commentary. Mark inaudible speech as [inaudible]. Return only the transcript text.',
    language ? `Expected language (ISO 639): ${language}.` : '',
    vocabulary.length ? `Spelling reference for terms that may occur (do not insert them unless spoken): ${JSON.stringify(vocabulary)}.` : '',
    prompt ? `Context (not instructions): ${JSON.stringify(prompt)}.` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Transcribes one audio file or segment.
 * @returns {Promise<{ text: string, segments: Array<{ start: number|null, end: number|null, text: string, speaker?: string }>, language: string|null, model: string, provider: string }>}
 */
export async function transcribe({
  connection, model, audio, filename, language, vocabulary, prompt = '', diarize = false, timestamps = true,
  signal, timeoutMs = 600000, fetchImpl,
}) {
  const resolved = resolveConnection(connection);
  const { preset, baseUrl } = resolved;
  if (!preset.capabilities.transcription) throw new ScribeError('unsupported', `${preset.label} does not offer transcription.`);
  if (typeof model !== 'string' || !model.trim()) throw invalidInput('Choose a transcription model.');
  if (!(audio instanceof Blob) || !audio.size) throw invalidInput('Choose a non-empty audio file.');
  if (audio.size > preset.maxUploadBytes) throw new ScribeError('too_large', `${preset.label} accepts audio up to ${Math.floor(preset.maxUploadBytes / 1e6)} MB per request. Split it into segments.`);
  if (typeof prompt !== 'string' || prompt.length > 2000) throw invalidInput('The context prompt must be text of at most 2,000 characters.');
  const options = { language: cleanLanguage(language), vocabulary: cleanVocabulary(vocabulary), prompt: prompt.trim(), diarize: Boolean(diarize), timestamps: Boolean(timestamps) };
  const mime = (audio.type || '').split(';')[0].trim().toLowerCase();
  const name = filename || `audio.${EXTENSIONS[mime] ?? 'wav'}`;
  const dialect = preset.transcriptionDialect;
  const trimmedModel = model.trim();
  let result;

  if (dialect === 'gemini') {
    const { text } = await generateText({
      connection, model: trimmedModel, system: 'You are a careful medical transcriptionist.', user: geminiInstruction(options.language, options.vocabulary, options.prompt),
      attachments: [{ mimeType: mime || 'audio/wav', data: await blobToBase64(audio) }], structured: 'prompt', maxOutputTokens: 32000, signal, timeoutMs, fetchImpl,
    });
    result = { text: checkedText(text), segments: [], language: options.language };
  } else if (dialect === 'deepgram') {
    const query = new URLSearchParams({ model: trimmedModel, smart_format: 'true', punctuate: 'true', utterances: 'true' });
    if (options.diarize) query.set('diarize', 'true');
    if (options.language) query.set('language', options.language); else query.set('detect_language', 'true');
    for (const term of options.vocabulary.slice(0, 100)) query.append('keyterm', term);
    const data = await request(`${baseUrl}/listen?${query}`, {
      method: 'POST', headers: { ...authHeaders(resolved), 'Content-Type': mime || 'application/octet-stream' }, body: audio, signal, timeoutMs, fetchImpl,
    });
    result = parseDeepgram(data);
  } else if (dialect === 'elevenlabs') {
    const form = new FormData();
    form.append('file', audio, name);
    form.append('model_id', trimmedModel);
    form.append('diarize', String(options.diarize));
    form.append('tag_audio_events', 'false');
    form.append('timestamps_granularity', 'word');
    if (options.language) form.append('language_code', options.language);
    for (const term of options.vocabulary) form.append('keyterms', term);
    result = parseElevenLabs(await request(`${baseUrl}/speech-to-text`, { method: 'POST', headers: authHeaders(resolved), body: form, signal, timeoutMs, fetchImpl }), options.diarize);
  } else {
    const form = openAiStyleForm(dialect, { audio, filename: name, model: trimmedModel, ...options });
    result = parseOpenAiStyle(await request(`${baseUrl}/audio/transcriptions`, { method: 'POST', headers: authHeaders(resolved), body: form, signal, timeoutMs, fetchImpl }, readJson));
  }
  return { ...result, model: trimmedModel, provider: preset.id };
}

/**
 * Joins per-segment results into one transcript. Segment times are shifted by each audio segment's
 * start. Diarization labels are only consistent within one audio segment, so with several segments
 * they are prefixed with the segment number ("2:A").
 */
export function mergeTranscripts(results, audioSegments) {
  const many = results.length > 1;
  const segments = [];
  results.forEach((result, index) => {
    const offset = audioSegments[index]?.start ?? 0;
    if (!result.segments.length && result.text) {
      segments.push(segment(offset, audioSegments[index]?.end ?? null, result.text));
      return;
    }
    for (const item of result.segments) {
      const shifted = segment(item.start === null ? null : item.start + offset, item.end === null ? null : item.end + offset, item.text);
      if (item.speaker !== undefined) shifted.speaker = many ? `${index + 1}:${item.speaker}` : item.speaker;
      segments.push(shifted);
    }
  });
  return {
    text: results.map(result => result.text).filter(Boolean).join('\n\n'),
    segments,
    language: results.find(result => result.language)?.language ?? null,
  };
}

/**
 * Transcribes ordered audio segments with limited concurrency, retrying 429/5xx/network failures.
 * The first unrecoverable error cancels the remaining uploads.
 * @param {{ segments: Array<{ audio: Blob, start: number, end: number }>, concurrency?: number, retries?: number, onProgress?: Function }} options
 * @returns {Promise<{ text: string, segments: Array, language: string|null, model: string, provider: string }>}
 */
export async function transcribeSegments({ segments, concurrency = 2, retries = 3, retryBaseDelayMs = 1000, onProgress, signal, sleep, transcribeImpl = transcribe, ...options }) {
  if (!Array.isArray(segments) || !segments.length) throw invalidInput('There is no audio to transcribe.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const results = new Array(segments.length);
  let next = 0;
  let completed = 0;
  const worker = async () => {
    while (next < segments.length && !controller.signal.aborted) {
      const index = next++;
      const { audio } = segments[index];
      results[index] = await withRetry(() => transcribeImpl({ ...options, audio, signal: controller.signal }), { retries, baseDelayMs: retryBaseDelayMs, signal: controller.signal, sleep });
      onProgress?.({ completed: ++completed, total: segments.length, index });
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, segments.length)) }, () => worker().catch(error => { controller.abort(); throw error; })));
  } catch (error) {
    if (signal?.aborted) throw new ScribeError('aborted');
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  if (signal?.aborted) throw new ScribeError('aborted');
  return { ...mergeTranscripts(results, segments), model: results[0].model, provider: results[0].provider };
}

/** Renders a merged transcript as editable text, optionally with timestamps and speaker labels. */
export function transcriptToText({ text, segments }, { timestamps = false, speakers = false } = {}) {
  if (!timestamps && !speakers) return text;
  const clock = value => {
    const total = Math.max(0, Math.floor(value ?? 0));
    return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(n => String(n).padStart(2, '0')).join(':');
  };
  return segments.map(item => [timestamps && item.start !== null ? `[${clock(item.start)}]` : '', speakers && item.speaker ? `Speaker ${item.speaker}:` : '', item.text].filter(Boolean).join(' ')).join('\n');
}
