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
