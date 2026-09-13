export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendError(res, error) {
  // Provider bodies, credentials and transcripts must never become logs or responses.
  const safe = error instanceof ApiError;
  return res.status(safe ? error.status : 500).json({
    error: safe ? error.message : 'The server could not process this request.',
    code: safe ? error.code : 'internal_error',
  });
}
