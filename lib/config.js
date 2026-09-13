import { ApiError } from './errors.js';

export const LIMITS = Object.freeze({ transcript_chars: 30000, audio_bytes: 2500000 });

const DEFINITIONS = [
  ['openai', 'OpenAI', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'gpt-4.1-mini'],
  ['anthropic', 'Anthropic', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001'],
  ['gemini', 'Google Gemini', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'gemini-2.5-flash'],
  ['openrouter', 'OpenRouter', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'openai/gpt-4.1-mini'],
  ['compatible', 'OpenAI-compatible', 'COMPATIBLE_API_KEY', 'COMPATIBLE_MODEL', ''],
];

export function requiresToken(env) {
  return Boolean(env.SCRIBE_ACCESS_TOKEN || env.VERCEL || env.NODE_ENV === 'production');
}

export function publicConfig(env) {
  return {
    providers: DEFINITIONS.map(([id, label, key, modelKey, fallback]) => ({
      id, label,
      configured: id === 'compatible' ? Boolean(env.COMPATIBLE_BASE_URL) : Boolean(env[key]),
      default_model: env[modelKey] || fallback,
    })),
    transcription: {
      configured: Boolean(env.TRANSCRIPTION_BASE_URL || env.TRANSCRIPTION_API_KEY || env.OPENAI_API_KEY),
      default_model: env.TRANSCRIPTION_MODEL || 'whisper-1',
    },
    access_token_required: requiresToken(env),
    limits: LIMITS,
  };
}

export function providerConfig(id, env) {
  const definition = DEFINITIONS.find(([provider]) => provider === id);
  if (!definition) throw new ApiError(400, 'invalid_provider', 'Select a supported AI provider.');
  const [provider, , key, modelKey, fallback] = definition;
  const configured = provider === 'compatible' ? env.COMPATIBLE_BASE_URL : env[key];
  if (!configured) throw new ApiError(503, 'provider_not_configured', 'This AI provider is not configured on the server.');
  return { id: provider, apiKey: env[key] || '', model: env[modelKey] || fallback };
}

export function apiBase(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new ApiError(503, 'invalid_server_configuration', 'The server API endpoint is not configured correctly.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new ApiError(503, 'invalid_server_configuration', 'API endpoints require HTTPS, or HTTP on localhost, without credentials or query parameters.');
  }
  return url.href.replace(/\/+$/, '');
}

export function modelId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(value)) {
    throw new ApiError(400, 'invalid_model', 'Enter a valid model ID for the selected provider (maximum 200 characters).');
  }
  return value;
}
