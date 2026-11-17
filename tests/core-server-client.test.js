import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerClient } from '../web/core/server-client.js';
import { ScribeError, ERROR_CODES } from '../web/core/errors.js';
import { NOTE } from './fixtures.js';

test('server client sends the access token and maps server errors to engine codes', async () => {
  const seen = [];
  const client = createServerClient({ accessToken: 'app-token', fetchImpl: async (url, options) => {
    seen.push([url, options.method, options.headers.Authorization, options.body && JSON.parse(options.body)]);
    if (url === '/api/config') return Response.json({ mode: 'server' });
    if (url === '/api/generate-soap') return Response.json({ note: NOTE, meta: { provider: 'openai' } });
    return Response.json({ error: 'nope' }, { status: 500 });
  } });
  assert.deepEqual(await client.config(), { mode: 'server' });
  const result = await client.generateNote({ provider: 'openai', transcript: 'fictional transcript', template: 'neurology', customInstructions: 'brief' });
  assert.deepEqual(result.note, NOTE);
  assert.deepEqual(seen[1], ['/api/generate-soap', 'POST', 'Bearer app-token', { provider: 'openai', transcript: 'fictional transcript', template: 'neurology', custom_instructions: 'brief' }]);

  const failing = (status, body) => createServerClient({ fetchImpl: async () => Response.json(body, { status }) });
  await assert.rejects(failing(401, { error: 'Enter the token.', code: 'unauthorized' }).config(), { code: 'access_denied', message: new ScribeError('access_denied').message });
  await assert.rejects(failing(503, { error: 'Not configured.', code: 'provider_not_configured' }).generateNote({}), { code: 'server_not_configured' });
  await assert.rejects(failing(429, { error: 'Slow down.', code: 'rate_limit' }).generateNote({}), { code: 'rate_limit', message: new ScribeError('rate_limit').message });
  await assert.rejects(failing(500, { error: 'x', code: 'internal_error' }).generateNote({}), { code: 'invalid_response' });
  await assert.rejects(createServerClient({ fetchImpl: async () => { throw new TypeError('offline'); } }).config(), { code: 'network' });
  await assert.rejects(createServerClient({ timeoutMs: 5, fetchImpl: (_u, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('x')))) }).config(), { code: 'timeout' });
});

test('server client uploads audio segments as base64 and merges them like browser mode', async () => {
  const bodies = [];
  const client = createServerClient({ fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return Response.json({ text: atob(body.audio), segments: [], language: null, model: 'm', provider: 'server' });
  } });
  const segments = [{ audio: new Blob(['one'], { type: 'audio/wav' }), start: 0, end: 60 }, { audio: new Blob(['two'], { type: 'audio/wav' }), start: 60, end: 90 }];
  const merged = await client.transcribeSegments({ segments, language: 'id', vocabulary: ['x'] });
  assert.equal(merged.text, 'one\n\ntwo');
  assert.deepEqual(merged.segments.map(s => s.start), [0, 60]);
  assert.deepEqual(bodies.map(b => [b.mimeType, b.language, b.vocabulary]), [['audio/wav', 'id', ['x']], ['audio/wav', 'id', ['x']]]);
  await assert.rejects(client.transcribe({ audio: new Blob([]) }), { code: 'invalid_input' });
});

test('server client never copies response body text into errors, only maps the stable code', async () => {
  const leak = 'Patient reports chest pain; key sk-secret';
  const cases = [[401, 'unauthorized'], [503, 'provider_not_configured'], [429, 'rate_limit'], [400, 'invalid_input'], [502, 'provider_unavailable'], [500, 'internal_error'], [500, undefined]];
  for (const [status, code] of cases) {
    const client = createServerClient({ fetchImpl: async () => Response.json({ error: leak, code }, { status }) });
    const error = await client.generateNote({}).then(() => null, (e) => e);
    assert.ok(error instanceof ScribeError, `${status} ${code} rejects with a ScribeError`);
    assert.ok(ERROR_CODES.includes(error.code));
    assert.equal(error.message, new ScribeError(error.code).message, `${code} uses the fixed message`);
    assert.ok(!error.message.includes('chest pain') && !error.message.includes('sk-secret'));
  }
});
