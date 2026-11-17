import test from 'node:test';
import assert from 'node:assert/strict';
import { request, readJson, sseEvents, withRetry, classifyHttpError } from '../web/core/http.js';
import { ScribeError } from '../web/core/errors.js';
import { sseResponse } from './fixtures.js';

const SECRET = 'sk-secret-key and patient transcript';

test('HTTP failures map to stable codes without leaking upstream bodies', async () => {
  const cases = [
    [401, '', 'auth'], [403, '', 'auth'], [402, '', 'quota'], [429, '{"error":{"code":"rate_limit_exceeded"}}', 'rate_limit'],
    [429, '{"error":{"code":"insufficient_quota"}}', 'quota'], [404, '', 'model_not_found'], [413, '', 'too_large'],
    [400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}', 'context_too_long'],
    [400, '{"error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}', 'context_too_long'],
    [400, '{"error":{"message":"The model `x` does not exist"}}', 'model_not_found'],
    [400, '{"error":{"message":"response_format json_schema is not supported"}}', 'bad_request'],
    [422, '', 'bad_request'], [500, '', 'provider_unavailable'], [529, '', 'provider_unavailable'], [408, '', 'timeout'],
  ];
  for (const [status, body, code] of cases) {
    await assert.rejects(
      request('https://provider.test/x', { fetchImpl: async () => new Response(body + SECRET, { status }) }),
      error => {
        assert.ok(error instanceof ScribeError);
        assert.equal(error.code, code, `status ${status}`);
        assert.equal(error.status, status);
        assert.ok(!error.message.includes('secret') && !error.message.includes('patient'));
        return true;
      },
    );
  }
  assert.equal(classifyHttpError(429, '', '12').retryAfterMs, 12000);
});

test('requests refuse redirects, pass the caller signal, and return parsed JSON', async () => {
  const data = await request('https://provider.test/ok', {
    method: 'POST', headers: { a: 'b' }, body: '{}',
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers.a, 'b');
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(data, { ok: true });
});

test('timeouts, cancellations and network failures are distinguished', async () => {
  const hang = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(request('https://p.test', { fetchImpl: hang, timeoutMs: 5 }), { code: 'timeout' });
  const controller = new AbortController();
  const pending = request('https://p.test', { fetchImpl: hang, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(request('https://p.test', { fetchImpl: hang, signal: aborted.signal }), { code: 'aborted' });
  await assert.rejects(request('https://p.test', { fetchImpl: async () => { throw new TypeError('Failed to fetch ' + SECRET); } }), error => {
    assert.equal(error.code, 'network');
    assert.ok(!error.message.includes('secret'));
    return true;
  });
});

test('JSON bodies are size-capped and must be objects', async () => {
  await assert.rejects(readJson(new Response('x'.repeat(100)), 10), { code: 'invalid_response' });
  await assert.rejects(readJson(new Response('<html>')), { code: 'invalid_response' });
  await assert.rejects(readJson(new Response('[1]')), { code: 'invalid_response' });
  assert.deepEqual(await readJson(new Response('{"a":1}')), { a: 1 });
});

test('SSE parsing handles split chunks, CRLF, comments, event names and multi-line data', async () => {
  const response = sseResponse([': ping\r\n\r\nevent: delta\r\ndata: {"a"', ':1}\r\n\r\ndata: line1\ndata: line2\n\n', 'data: [DONE]\n\n']);
  const events = [];
  for await (const event of sseEvents(response)) events.push(event);
  assert.deepEqual(events, [{ event: 'delta', data: '{"a":1}' }, { event: 'message', data: 'line1\nline2' }, { event: 'message', data: '[DONE]' }]);
});

test('retry backs off on retryable errors only and honours Retry-After and abort', async () => {
  const delays = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new ScribeError('rate_limit', undefined, { retryAfterMs: 3000 });
    if (calls === 2) throw new ScribeError('provider_unavailable');
    return 'done';
  }, { retries: 3, baseDelayMs: 100, sleep: async ms => { delays.push(ms); } });
  assert.equal(result, 'done');
  assert.equal(delays[0], 3000);
  assert.ok(delays[1] >= 200 && delays[1] < 300);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new ScribeError('auth'); }, { sleep: async () => {} }), { code: 'auth' });
  assert.equal(calls, 1);
  await assert.rejects(withRetry(async () => { throw new ScribeError('network'); }, { retries: 2, sleep: async () => {} }), { code: 'network' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withRetry(async () => 'x', { signal: controller.signal }), { code: 'aborted' });
});
