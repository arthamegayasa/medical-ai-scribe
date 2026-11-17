import { ScribeError } from './errors.js';
import { request } from './http.js';
import { authHeaders, resolveConnection } from './providers.js';

// OpenAI-style /models endpoints mix every model type; these heuristics only order the dropdown.
const TRANSCRIPTION_PATTERN = /transcrib|whisper|voxtral|scribe|nova/i;
const NON_CHAT_PATTERN = /embed|tts|speech|transcrib|whisper|dall-e|image|moderation|audio|realtime|search|davinci|babbage|guard|ocr|rerank|voxtral/i;

function byPurpose(models, purpose) {
  if (!purpose) return models;
  return models.filter(model => (purpose === 'transcription' ? TRANSCRIPTION_PATTERN.test(model.id) : !NON_CHAT_PATTERN.test(model.id)));
}

function entry(id, label, contextTokens, extra = {}) {
  const model = { id, label: label || id };
  if (Number.isFinite(contextTokens)) model.contextTokens = contextTokens;
  return { ...model, ...extra };
}

/**
 * Lists the models the user's key can access.
 * @returns {Promise<Array<{id: string, label: string, contextTokens?: number, structuredOutputs?: boolean}>>}
 */
export async function listModels(connection, { purpose = 'chat', signal, fetchImpl, timeoutMs = 20000 } = {}) {
  const resolved = resolveConnection(connection);
  const { preset, baseUrl } = resolved;
  if (!preset.capabilities.modelListing) throw new ScribeError('unsupported', `${preset.label} does not allow listing models from the browser. Enter a model ID instead.`);
  const options = { headers: authHeaders(resolved), signal, fetchImpl, timeoutMs };

  if (preset.family === 'anthropic') {
    const data = await request(`${baseUrl}/models?limit=1000`, options);
    return list(data.data).map(m => entry(m.id, m.display_name, m.max_input_tokens));
  }
  if (preset.family === 'gemini') {
    const models = [];
    let pageToken = '';
    for (let page = 0; page < 5; page++) {
      const data = await request(`${baseUrl}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, options);
      for (const m of list(data.models)) {
        if (typeof m.name !== 'string' || !list(m.supportedGenerationMethods).includes('generateContent')) continue;
        models.push(entry(m.name.replace(/^models\//, ''), m.displayName, m.inputTokenLimit));
      }
      pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
      if (!pageToken) break;
    }
    return models;
  }
  const data = await request(`${baseUrl}/models`, options);
  const models = list(data.data).map(m => entry(
    m.id, m.name, m.context_length ?? m.context_window ?? m.max_context_length,
    Array.isArray(m.supported_parameters) ? { structuredOutputs: m.supported_parameters.includes('structured_outputs') } : {},
  ));
  return byPurpose(models, purpose);
}

function list(value) {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' ? typeof (item.id ?? item.name) === 'string' : typeof item === 'string') : [];
}

/**
 * Validates a key with a free, read-only call. Resolves `{ ok: true, models }` or throws a
 * ScribeError (`auth`, `network`, `unsupported`, ...).
 */
export async function testConnection(connection, options = {}) {
  const resolved = resolveConnection(connection);
  const { preset, baseUrl } = resolved;
  if (preset.family === 'elevenlabs') {
    await request(`${baseUrl}/user`, { headers: authHeaders(resolved), signal: options.signal, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs ?? 20000 });
    return { ok: true, models: preset.transcriptionModels.map(id => entry(id)) };
  }
  if (!preset.capabilities.modelListing) {
    throw new ScribeError('unsupported', `${preset.label} keys cannot be checked from the browser; the key is checked on the first transcription.`);
  }
  return { ok: true, models: await listModels(connection, options) };
}
