import { ApiError } from './errors.js';
import { getProvider, validateBaseUrl } from '../web/core/providers.js';
import { TRANSCRIPT_LIMITS } from '../web/core/soap/generate.js';

// Base64 inflates by 4/3; 3 MB of audio stays below Vercel's 4.5 MB request-body limit.
export const LIMITS = Object.freeze({ transcript_chars: TRANSCRIPT_LIMITS.maxChars, audio_bytes: 3_000_000 });

// [server id, engine preset, key variable, model variable]
const TEXT_PROVIDERS = [
  ['openai', 'openai', 'OPENAI_API_KEY', 'OPENAI_MODEL'],
  ['anthropic', 'anthropic', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'],
  ['gemini', 'gemini', 'GEMINI_API_KEY', 'GEMINI_MODEL'],
  ['openrouter', 'openrouter', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL'],
  ['groq', 'groq', 'GROQ_API_KEY', 'GROQ_MODEL'],
  ['mistral', 'mistral', 'MISTRAL_API_KEY', 'MISTRAL_MODEL'],
  ['compatible', 'custom', 'COMPATIBLE_API_KEY', 'COMPATIBLE_MODEL'],
];
const TRANSCRIPTION_PROVIDERS = { openai: 'OPENAI_API_KEY', groq: 'GROQ_API_KEY', mistral: 'MISTRAL_API_KEY', gemini: 'GEMINI_API_KEY', deepgram: 'DEEPGRAM_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY' };

export function requiresToken(env) {
  return Boolean(env.SCRIBE_ACCESS_TOKEN || env.VERCEL || env.NODE_ENV === 'production');
}

function serverBase(value) {
  try { return validateBaseUrl(value); } catch {
    throw new ApiError(503, 'invalid_server_configuration', 'API endpoints require HTTPS, or HTTP on localhost, without credentials or query parameters.');
  }
}

function transcriptionSetup(env) {
  if (env.TRANSCRIPTION_BASE_URL) {
    // A custom transcription service never receives another provider's key by implicit fallback.
    return { connection: { provider: 'custom', baseUrl: env.TRANSCRIPTION_BASE_URL, apiKey: env.TRANSCRIPTION_API_KEY || '' }, preset: getProvider('custom'), configured: true };
  }
  const id = env.TRANSCRIPTION_PROVIDER || 'openai';
  if (!Object.hasOwn(TRANSCRIPTION_PROVIDERS, id)) return { configured: false, invalid: true };
  const apiKey = env.TRANSCRIPTION_API_KEY || env[TRANSCRIPTION_PROVIDERS[id]] || '';
  return { connection: { provider: id, apiKey }, preset: getProvider(id), configured: Boolean(apiKey) };
}

/** What the browser may know: availability and defaults, never keys or endpoint URLs. */
export function publicConfig(env) {
  const transcription = transcriptionSetup(env);
  return {
    mode: 'server',
    providers: TEXT_PROVIDERS.map(([id, presetId, key, modelKey]) => {
      const preset = getProvider(presetId);
      return {
        id, label: id === 'compatible' ? 'OpenAI-compatible (server)' : preset.label,
        configured: id === 'compatible' ? Boolean(env.COMPATIBLE_BASE_URL) : Boolean(env[key]),
        default_model: env[modelKey] || preset.defaultChatModel || preset.chatModels[0] || '',
        suggested_models: [...preset.chatModels],
      };
    }),
    transcription: {
      configured: transcription.configured,
      provider: transcription.preset?.id ?? null,
      default_model: env.TRANSCRIPTION_MODEL || transcription.preset?.transcriptionModels[0] || '',
      diarization: Boolean(transcription.preset?.capabilities.diarization),
    },
    access_token_required: requiresToken(env),
    limits: LIMITS,
  };
}

/** The engine connection for a server-held text provider. Browser input never selects an endpoint. */
export function serverTextConnection(id, env) {
  const definition = TEXT_PROVIDERS.find(([provider]) => provider === id);
  if (!definition) throw new ApiError(400, 'invalid_provider', 'Select a supported AI provider.');
  const [, presetId, key, modelKey] = definition;
  const configured = id === 'compatible' ? env.COMPATIBLE_BASE_URL : env[key];
  if (!configured) throw new ApiError(503, 'provider_not_configured', 'This AI provider is not configured on the server.');
  const connection = { provider: presetId, apiKey: env[key] || '' };
  if (id === 'compatible') connection.baseUrl = serverBase(env.COMPATIBLE_BASE_URL);
  const preset = getProvider(presetId);
  return { connection, defaultModel: env[modelKey] || preset.defaultChatModel || preset.chatModels[0] || '' };
}

export function serverTranscriptionConnection(env) {
  const setup = transcriptionSetup(env);
  if (setup.invalid) throw new ApiError(503, 'invalid_server_configuration', 'TRANSCRIPTION_PROVIDER names an unsupported provider.');
  if (!setup.configured) throw new ApiError(503, 'transcription_not_configured', 'Audio transcription is not configured on the server. You can paste a transcript instead.');
  if (setup.connection.baseUrl) setup.connection.baseUrl = serverBase(setup.connection.baseUrl);
  return { connection: setup.connection, defaultModel: env.TRANSCRIPTION_MODEL || setup.preset.transcriptionModels[0] || '' };
}

export function modelId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(value)) {
    throw new ApiError(400, 'invalid_model', 'Enter a valid model ID for the selected provider (maximum 200 characters).');
  }
  return value;
}
