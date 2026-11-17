// Stable error codes shared by the browser engine and the server handlers.
// Messages are fixed strings: upstream bodies, keys and transcript text never enter them.
const MESSAGES = Object.freeze({
  auth: 'The provider rejected the API key. Check the key and its permissions.',
  rate_limit: 'The provider rate limit was reached. Wait a moment and try again.',
  quota: 'The provider account has no remaining quota or credit. Check billing with the provider.',
  model_not_found: 'The provider does not offer this model to this key. Choose another model.',
  context_too_long: 'The transcript is too long for this model. Choose a model with a larger context window.',
  too_large: 'The upload is larger than the provider accepts. Use shorter audio segments.',
  bad_request: 'The provider rejected the request. Check the model and its support for this feature.',
  refusal: 'The model declined to produce this output. Review the transcript or try another model.',
  truncated: 'The model stopped before finishing. Try a model with a larger output limit.',
  invalid_output: 'The model output was not a complete, valid result. Try again or choose another model.',
  invalid_response: 'The provider returned an unexpected response.',
  provider_unavailable: 'The provider could not complete the request. Try again later.',
  network: 'Could not reach the provider. Check the connection, the endpoint URL, and whether it allows browser (CORS) access.',
  timeout: 'The provider took too long to respond.',
  aborted: 'The request was cancelled.',
  invalid_input: 'The input is not valid.',
  unsupported: 'This provider does not support the requested operation.',
  verification_failed: 'The model changed the transcript wording, so its result was rejected.',
  access_denied: 'The application access token was rejected. Enter the token supplied by the deployment owner.',
  server_not_configured: 'This server is not configured for that operation.',
});

export const ERROR_CODES = Object.freeze(Object.keys(MESSAGES));
const RETRYABLE = new Set(['rate_limit', 'provider_unavailable', 'network', 'timeout']);

export class ScribeError extends Error {
  constructor(code, message = MESSAGES[code] ?? MESSAGES.invalid_response, { status, retryAfterMs } = {}) {
    super(message);
    this.name = 'ScribeError';
    this.code = MESSAGES[code] ? code : 'invalid_response';
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }

  get retryable() {
    return RETRYABLE.has(this.code);
  }
}

export function invalidInput(message) {
  return new ScribeError('invalid_input', message);
}
