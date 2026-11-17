import { ERROR_CODES, ScribeError, invalidInput } from './errors.js';
import { readJson } from './http.js';
import { transcribeSegments } from './transcribe.js';

const SERVER_CONFIG_CODES = new Set(['access_not_configured', 'provider_not_configured', 'transcription_not_configured', 'invalid_server_configuration']);

async function base64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Client for server-key mode (the app's own /api endpoints). Results have the same shapes as the
 * browser-direct functions, so the UI can switch modes without other changes.
 */
export function createServerClient({ accessToken = '', baseUrl = '', fetchImpl = globalThis.fetch, timeoutMs = 300000 } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) };

  async function call(path, body, signal) {
    if (signal?.aborted) throw new ScribeError('aborted');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, body === undefined
        ? { method: 'GET', headers, signal: controller.signal }
        : { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      const data = await readJson(response).catch(() => ({}));
      if (response.ok) return data;
      // Only the stable `code` is used; the body's `error` text is never copied into errors, so a
      // misbehaving proxy or server cannot put arbitrary (possibly clinical) text into the UI.
      if (response.status === 401) throw new ScribeError('access_denied');
      if (SERVER_CONFIG_CODES.has(data.code)) throw new ScribeError('server_not_configured');
      throw new ScribeError(ERROR_CODES.includes(data.code) ? data.code : 'invalid_response', undefined, { status: response.status });
    } catch (error) {
      if (timedOut) throw new ScribeError('timeout');
      if (signal?.aborted) throw new ScribeError('aborted');
      if (error instanceof ScribeError) throw error;
      throw new ScribeError('network');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function transcribeOne({ audio, model, language, vocabulary, prompt, diarize, timestamps, signal }) {
    if (!(audio instanceof Blob) || !audio.size) throw invalidInput('Choose a non-empty audio file.');
    return call('/api/process-audio', { audio: await base64(audio), mimeType: audio.type || 'audio/wav', model, language, vocabulary, prompt, diarize, timestamps }, signal);
  }

  return {
    config: ({ signal } = {}) => call('/api/config', undefined, signal),
    generateNote: ({ provider, model, transcript, language, template, customInstructions, signal }) =>
      call('/api/generate-soap', { provider, model, transcript, language, template, custom_instructions: customInstructions }, signal),
    regenerateSection: ({ provider, model, transcript, note, section, language, template, customInstructions, signal }) =>
      call('/api/generate-soap', { provider, model, transcript, note, section, language, template, custom_instructions: customInstructions }, signal),
    labelSpeakers: ({ provider, model, transcript, signal }) => call('/api/label-speakers', { provider, model, transcript }, signal),
    transcribe: transcribeOne,
    transcribeSegments: options => transcribeSegments({ ...options, transcribeImpl: transcribeOne }),
  };
}
