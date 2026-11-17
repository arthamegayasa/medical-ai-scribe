import { ScribeError } from '../web/core/errors.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const STATUS = {
  invalid_input: 400, unsupported: 400, rate_limit: 429, quota: 429, context_too_long: 413, too_large: 413,
  refusal: 422, verification_failed: 422, timeout: 504, aborted: 504,
};
// Engine messages describe the user's own key; on the server the key belongs to the deployment.
const SERVER_MESSAGES = {
  auth: 'The AI provider rejected the server credentials. Ask the deployment owner to check them.',
  network: 'The server could not connect to the configured AI provider.',
  quota: 'The server AI provider account has reached its quota. Ask the deployment owner to check billing.',
};

export function sendError(res, error) {
  // Provider bodies, credentials and transcripts must never become logs or responses.
  if (error instanceof ScribeError) {
    return res.status(STATUS[error.code] ?? 502).json({ error: SERVER_MESSAGES[error.code] ?? error.message, code: error.code });
  }
  const safe = error instanceof ApiError;
  return res.status(safe ? error.status : 500).json({
    error: safe ? error.message : 'The server could not process this request.',
    code: safe ? error.code : 'internal_error',
  });
}
