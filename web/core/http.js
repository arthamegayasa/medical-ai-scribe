import { ScribeError } from './errors.js';

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;

const CONTEXT_PATTERN = /context[\s_-]*(length|window)|maximum context|too many (input )?tokens|prompt is too long|input (is )?too long|exceeds? (the )?(maximum|max|context|token)|token limit/i;
const MODEL_PATTERN = /model[\s\S]{0,60}(not found|does not exist|not exist|is not available|not supported for)|model_not_found|unknown model|no such model/i;
const QUOTA_PATTERN = /insufficient_quota|quota|billing|credit|payment/i;

// The body is inspected only to pick a code; it is never copied into the error.
export function classifyHttpError(status, bodyText = '', retryAfter = null) {
  const seconds = Number(retryAfter);
  const retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 600) * 1000 : undefined;
  const options = { status, retryAfterMs };
  if (status === 401 || status === 403) return new ScribeError('auth', undefined, options);
  if (status === 402) return new ScribeError('quota', undefined, options);
  if (status === 429) return new ScribeError(QUOTA_PATTERN.test(bodyText) ? 'quota' : 'rate_limit', undefined, options);
  if (status === 404) return new ScribeError('model_not_found', undefined, options);
  if (status === 413) return new ScribeError(CONTEXT_PATTERN.test(bodyText) ? 'context_too_long' : 'too_large', undefined, options);
  if (status === 408) return new ScribeError('timeout', undefined, options);
  if (status >= 500) return new ScribeError('provider_unavailable', undefined, options);
  if (CONTEXT_PATTERN.test(bodyText)) return new ScribeError('context_too_long', undefined, options);
  if (MODEL_PATTERN.test(bodyText)) return new ScribeError('model_not_found', undefined, options);
  return new ScribeError('bad_request', undefined, options);
}

async function readBytes(response, limit) {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function readJson(response, limit = MAX_JSON_BYTES) {
  const bytes = await readBytes(response, limit);
  if (!bytes) throw new ScribeError('invalid_response', 'The provider returned an unexpectedly large response.');
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch { /* reported below */ }
  throw new ScribeError('invalid_response', 'The provider returned a response that is not valid JSON.');
}

export async function readText(response, limit = MAX_JSON_BYTES) {
  const bytes = await readBytes(response, limit);
  if (!bytes) throw new ScribeError('invalid_response', 'The provider returned an unexpectedly large response.');
  return new TextDecoder().decode(bytes);
}

/**
 * Performs one provider call with a deadline. `consume(response)` reads the body while the
 * deadline is still armed, so slow streams time out too.
 */
export async function request(url, { method = 'GET', headers = {}, body, signal, timeoutMs = 120000, fetchImpl = globalThis.fetch } = {}, consume = readJson) {
  if (signal?.aborted) throw new ScribeError('aborted');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { method, headers, body, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      const text = await readText(response, MAX_ERROR_BYTES).catch(() => '');
      throw classifyHttpError(response.status, text, response.headers.get('retry-after'));
    }
    return await consume(response);
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

/** Yields `{ event, data }` for each Server-Sent Event in a streamed response body. */
export async function* sseEvents(response, limit = MAX_JSON_BYTES) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  const parse = block => {
    let event = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return data.length ? { event, data: data.join('\n') } : null;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new ScribeError('invalid_response', 'The provider stream exceeded the size limit.');
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = parse(block);
        if (event) yield event;
      }
    }
    const tail = parse(buffer + decoder.decode());
    if (tail) yield tail;
  } finally {
    reader.releaseLock?.();
  }
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new ScribeError('aborted')); }, { once: true });
});

/** Retries `fn` on rate-limit, 5xx, network and timeout errors with exponential backoff. */
export async function withRetry(fn, { retries = 3, baseDelayMs = 1000, signal, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new ScribeError('aborted');
    try {
      return await fn(attempt);
    } catch (error) {
      if (!(error instanceof ScribeError) || !error.retryable || attempt >= retries) throw error;
      const backoff = baseDelayMs * 2 ** attempt;
      await sleep(error.retryAfterMs ?? backoff + Math.random() * baseDelayMs * 0.5, signal);
    }
  }
}
