import { invalidInput } from './errors.js';

// CORS facts come from unauthenticated preflights sent with Origin https://medicalaiscribe.vercel.app
// on 2026-11-17 for every endpoint and header set the engine uses. Re-run them before changing a
// preset's `browser` value. Model IDs are suggestions only; the UI should prefer listModels().
// `defaultChatModel` is the balanced (mid-tier) choice used when nothing else is selected.
const MB = 1000 * 1000;

export const PROVIDERS = Object.freeze([
  {
    id: 'openai', label: 'OpenAI', family: 'openai', baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys', keyRequired: true, browser: 'direct',
    capabilities: { chat: true, transcription: true, modelListing: true, diarization: true },
    structuredModes: ['json_schema', 'json_object', 'prompt'], tokenParam: 'max_completion_tokens', sendStore: true,
    chatModels: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna'], defaultChatModel: 'gpt-6.1-terra',
    transcriptionModels: ['gpt-transcribe', 'gpt-4o-transcribe-diarize'],
    transcriptionDialect: 'openai', maxUploadBytes: 25 * MB,
  },
  {
    id: 'anthropic', label: 'Anthropic Claude', family: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://platform.claude.com/settings/keys', keyRequired: true, browser: 'direct',
    capabilities: { chat: true, transcription: false, modelListing: true, diarization: false },
    structuredModes: ['json_schema', 'prompt'],
    chatModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], defaultChatModel: 'claude-sonnet-5-5', transcriptionModels: [],
  },
  {
    id: 'gemini', label: 'Google Gemini', family: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/apikey', keyRequired: true, browser: 'direct',
    capabilities: { chat: true, transcription: true, modelListing: true, diarization: false },
    structuredModes: ['json_schema', 'json_object', 'prompt'],
    chatModels: ['gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-3.5-flash-lite'], defaultChatModel: 'gemini-3.8-flash',
    transcriptionModels: ['gemini-3.8-flash', 'gemini-4-hydrogen'],
    // Inline requests are capped at 20 MB including base64 overhead (4/3) and the prompt.
    transcriptionDialect: 'gemini', maxUploadBytes: 14 * MB,
  },
  {
    id: 'openrouter', label: 'OpenRouter', family: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys', keyRequired: true, browser: 'direct',
    capabilities: { chat: true, transcription: false, modelListing: true, diarization: false },
    structuredModes: ['json_schema', 'json_object', 'prompt'], tokenParam: 'max_tokens', requireParameters: true,
    chatModels: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash'], defaultChatModel: 'anthropic/claude-sonnet-5.5', transcriptionModels: [],
  },
  {
    id: 'groq', label: 'Groq', family: 'openai', baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys', keyRequired: true, browser: 'direct',
    capabilities: { chat: true, transcription: true, modelListing: true, diarization: false },
    // Groq rejects json_schema together with streaming.
    structuredModes: ['json_schema', 'json_object', 'prompt'], schemaWithStream: false, tokenParam: 'max_completion_tokens',
    chatModels: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'], defaultChatModel: 'openai/gpt-oss-120b',
    transcriptionModels: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    transcriptionDialect: 'whisper', maxUploadBytes: 25 * MB,
  },
  {
    id: 'mistral', label: 'Mistral', family: 'openai', baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys', keyRequired: true, browser: 'direct',
    capabilities: { chat: true, transcription: true, modelListing: true, diarization: true },
    structuredModes: ['json_schema', 'json_object', 'prompt'], tokenParam: 'max_tokens',
    chatModels: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'], defaultChatModel: 'mistral-medium-latest', transcriptionModels: ['voxtral-mini-latest'],
    transcriptionDialect: 'mistral', maxUploadBytes: 25 * MB,
  },
  {
    id: 'deepgram', label: 'Deepgram', family: 'deepgram', baseUrl: 'https://api.deepgram.com/v1',
    keyUrl: 'https://console.deepgram.com/', keyRequired: true, browser: 'direct',
    // Only POST /v1/listen allows cross-origin calls, so keys cannot be checked or models listed.
    capabilities: { chat: false, transcription: true, modelListing: false, diarization: true },
    chatModels: [], transcriptionModels: ['nova-3-medical', 'nova-3'],
    transcriptionDialect: 'deepgram', maxUploadBytes: 100 * MB,
  },
  {
    id: 'elevenlabs', label: 'ElevenLabs', family: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io/v1',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys', keyRequired: true, browser: 'direct',
    capabilities: { chat: false, transcription: true, modelListing: false, diarization: true },
    chatModels: [], transcriptionModels: ['scribe_v2'],
    transcriptionDialect: 'elevenlabs', maxUploadBytes: 100 * MB,
  },
  {
    id: 'local', label: 'Local model (Ollama / LM Studio)', family: 'openai', baseUrl: 'http://127.0.0.1:11434/v1',
    keyUrl: null, keyRequired: false, customBaseUrl: true, browser: 'local',
    capabilities: { chat: true, transcription: true, modelListing: true, diarization: false },
    structuredModes: ['json_schema', 'json_object', 'prompt'], tokenParam: 'max_tokens',
    chatModels: [], transcriptionModels: [], transcriptionDialect: 'basic', maxUploadBytes: 25 * MB,
  },
  {
    id: 'custom', label: 'Custom OpenAI-compatible endpoint', family: 'openai', baseUrl: null,
    keyUrl: null, keyRequired: false, customBaseUrl: true, browser: 'unknown',
    capabilities: { chat: true, transcription: true, modelListing: true, diarization: false },
    structuredModes: ['json_schema', 'json_object', 'prompt'], tokenParam: 'max_tokens',
    chatModels: [], transcriptionModels: [], transcriptionDialect: 'whisper', maxUploadBytes: 25 * MB,
  },
].map(preset => Object.freeze(preset)));

export function getProvider(id) {
  const preset = PROVIDERS.find(provider => provider.id === id);
  if (!preset) throw invalidInput('Select a supported provider.');
  return preset;
}

export function listProviders(capability) {
  return capability ? PROVIDERS.filter(provider => provider.capabilities[capability]) : [...PROVIDERS];
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Accepts HTTPS, or HTTP on a loopback host, without credentials, query or fragment. */
export function validateBaseUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw invalidInput('Enter a valid endpoint URL, for example https://example.com/v1.'); }
  const loopback = LOOPBACK.has(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw invalidInput('Endpoints must use HTTPS (HTTP is allowed only on localhost) and contain no credentials or query string.');
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * Normalises a user connection `{ provider, apiKey?, baseUrl? }` into
 * `{ preset, baseUrl, apiKey }`. Fixed presets ignore any supplied baseUrl.
 */
export function resolveConnection(connection) {
  if (!connection || typeof connection !== 'object') throw invalidInput('Choose a provider connection.');
  const preset = getProvider(connection.provider);
  const supplied = typeof connection.baseUrl === 'string' && connection.baseUrl.trim() ? connection.baseUrl : null;
  const base = preset.customBaseUrl && supplied ? supplied : preset.baseUrl;
  if (!base) throw invalidInput('Enter the endpoint URL for this provider.');
  const apiKey = typeof connection.apiKey === 'string' ? connection.apiKey.trim() : '';
  if (preset.keyRequired && !apiKey) throw invalidInput(`Enter your ${preset.label} API key.`);
  if (apiKey && (apiKey.length > 1024 || /[\s\u0000-\u001f\u007f]/.test(apiKey))) throw invalidInput('The API key contains invalid characters.');
  return { preset, baseUrl: validateBaseUrl(base), apiKey };
}

/** Provider authentication headers for a resolved connection. */
export function authHeaders({ preset, apiKey }) {
  switch (preset.family) {
    case 'anthropic':
      // Anthropic rejects cross-origin calls unless this opt-in header is present.
      return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
    case 'gemini': return { 'x-goog-api-key': apiKey };
    case 'deepgram': return { Authorization: `Token ${apiKey}` };
    case 'elevenlabs': return { 'xi-api-key': apiKey };
    default: return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }
}

/** Suggested model IDs, used only when live listing is unavailable. */
export function suggestedModels(providerId, purpose = 'chat') {
  const preset = getProvider(providerId);
  return [...(purpose === 'transcription' ? preset.transcriptionModels : preset.chatModels)];
}
