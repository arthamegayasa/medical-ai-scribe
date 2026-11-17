// Maps engine errors to specific, translated recovery messages.
// Only the stable `code` (and app-supplied context) is used: `error.message` is never shown in
// the UI, so provider bodies, keys or transcript text cannot leak through an error.

/** i18n key for each engine error code. Every code must have one (tests enforce it). */
export const ERROR_KEYS = Object.freeze({
  auth: 'app.err.auth',
  rate_limit: 'app.err.rate_limit',
  quota: 'app.err.quota',
  model_not_found: 'app.err.model_not_found',
  context_too_long: 'app.err.context_too_long',
  too_large: 'app.err.too_large',
  bad_request: 'app.err.bad_request',
  refusal: 'app.err.refusal',
  truncated: 'app.err.truncated',
  invalid_output: 'app.err.invalid_output',
  invalid_response: 'app.err.invalid_response',
  provider_unavailable: 'app.err.provider_unavailable',
  network: 'app.err.network',
  timeout: 'app.err.timeout',
  aborted: 'app.err.aborted',
  invalid_input: 'app.err.invalid_input',
  unsupported: 'app.err.unsupported',
  verification_failed: 'app.err.verification_failed',
  access_denied: 'app.err.access_denied',
  server_not_configured: 'app.err.server_not_configured',
});

// App-level problems that are not engine errors.
export const APP_ERROR_KEYS = Object.freeze({
  noConnection: 'app.err.noConnection',
  noModel: 'app.err.noModel',
  noKey: 'app.err.noKey',
  noTranscriptionConnection: 'app.err.noTranscriptionConnection',
  micNotFound: 'app.err.micNotFound',
  micBusy: 'app.err.micBusy',
  recorderUnsupported: 'app.err.recorderUnsupported',
  decode: 'app.err.decode',
  emptyAudio: 'app.err.emptyAudio',
  unexpected: 'app.err.unexpected',
  shortTranscript: 'app.err.shortTranscript',
  storage: 'app.err.storage',
});

/**
 * @param {unknown} error a ScribeError, an AppError ({ appCode }) or anything else
 * @param {{ browser?: 'direct'|'local'|'unknown'|null, providerLabel?: string, origin?: string, operation?: 'test' }} [context]
 * @returns {{ key: string, vars: Record<string, string|number>, code: string, retryable: boolean }}
 */
export function describeError(error, context = {}) {
  const vars = { provider: context.providerLabel || '', origin: context.origin || '' };
  if (error && typeof error === 'object' && typeof error.appCode === 'string' && APP_ERROR_KEYS[error.appCode]) {
    return { key: APP_ERROR_KEYS[error.appCode], vars, code: error.appCode, retryable: false };
  }
  const code = error && typeof error === 'object' && typeof error.code === 'string' && ERROR_KEYS[error.code] ? error.code : null;
  if (!code) return { key: APP_ERROR_KEYS.unexpected, vars, code: 'unexpected', retryable: false };
  // The engine decides what is worth retrying (ScribeError#retryable); no second list here.
  const retryable = Boolean(error.retryable);
  // Browsers cannot tell "offline", "wrong URL" and "CORS blocked" apart; local and custom
  // endpoints most often fail because CORS is not enabled, so say exactly how to enable it.
  if (code === 'network' && context.browser === 'local') return { key: 'app.err.corsLocal', vars, code, retryable };
  if (code === 'network' && context.browser === 'unknown') return { key: 'app.err.corsCustom', vars, code, retryable };
  // A 404 while testing a connection means the model list was not found: usually a base URL
  // without the API prefix (/v1), not a missing model.
  if (code === 'model_not_found' && context.operation === 'test') return { key: 'app.err.endpointNotFound', vars, code, retryable };
  if (code === 'rate_limit' && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
    return { key: 'app.err.rate_limit_wait', vars: { ...vars, seconds: Math.ceil(error.retryAfterMs / 1000) }, code, retryable };
  }
  return { key: ERROR_KEYS[code], vars, code, retryable };
}

export class AppError extends Error {
  constructor(appCode) {
    super(appCode);
    this.name = 'AppError';
    this.appCode = appCode;
  }
}
