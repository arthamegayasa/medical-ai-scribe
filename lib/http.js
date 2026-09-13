import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';
import { requiresToken } from './config.js';

export function guard(req, res, method, env, costly = false) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== method) {
    res.setHeader('Allow', method);
    throw new ApiError(405, 'method_not_allowed', `Use ${method} for this endpoint.`);
  }
  if (!costly) return;
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch {
      throw new ApiError(403, 'origin_rejected', 'This request must come from the same application.');
    }
    if (origin.host !== req.headers.host) {
      throw new ApiError(403, 'origin_rejected', 'This request must come from the same application.');
    }
  }
  if (requiresToken(env)) {
    if (!env.SCRIBE_ACCESS_TOKEN) {
      throw new ApiError(503, 'access_not_configured', 'The deployment owner must configure SCRIBE_ACCESS_TOKEN before AI requests are enabled.');
    }
    const presented = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const digest = value => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(presented), digest(`Bearer ${env.SCRIBE_ACCESS_TOKEN}`))) {
      throw new ApiError(401, 'unauthorized', 'Enter the application access token supplied by the deployment owner.');
    }
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new ApiError(415, 'unsupported_content_type', 'Send this request as application/json.');
  }
}

export async function readJson(req, limit) {
  let body = req.body;
  if (body === undefined) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new ApiError(413, 'payload_too_large', 'The request is too large.');
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > limit) throw new ApiError(413, 'payload_too_large', 'The request is too large.');
    try { body = JSON.parse(body); } catch {
      throw new ApiError(400, 'invalid_json', 'The request body must be valid JSON.');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_json', 'The request body must be a JSON object.');
  }
  if (Buffer.byteLength(JSON.stringify(body)) > limit) throw new ApiError(413, 'payload_too_large', 'The request is too large.');
  return body;
}

export async function providerRequest(url, options, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      // Never forward upstream error bodies: they can echo patient text and API keys.
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new ApiError(502, 'provider_authentication_failed', 'The AI provider rejected its server credentials. Ask the deployment owner to check them.');
      if (response.status === 429) throw new ApiError(429, 'provider_rate_limited', 'The AI provider has reached a rate or quota limit. Check its quota or try again later.');
      if ([400, 404, 422].includes(response.status)) throw new ApiError(502, 'provider_request_rejected', 'The provider rejected this request. Check the model ID and its support for this endpoint.');
      throw new ApiError(502, 'provider_unavailable', 'The AI provider could not complete this request. Try again later.');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1048576) {
        await reader.cancel();
        throw new ApiError(502, 'invalid_provider_response', 'The provider returned an unexpectedly large response.');
      }
      chunks.push(value);
    }
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response envelope');
      return data;
    } catch {
      throw new ApiError(502, 'invalid_provider_response', 'The provider returned invalid JSON. Try a model that supports this endpoint.');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError(504, 'provider_timeout', 'The AI provider took too long. Try a shorter transcript or audio clip.');
    throw new ApiError(502, 'provider_connection_failed', 'The server could not connect to the configured AI provider.');
  } finally {
    clearTimeout(timer);
  }
}
