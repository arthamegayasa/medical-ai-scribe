import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from '../lib/handlers.js';
import { LIMITS } from '../lib/config.js';
import { decodeAudio, parseSoap, soapPrompt } from '../lib/providers.js';

const SOAP = {
  chief_complaint: 'Fictional encounter for documentation testing.',
  subjective: 'The synthetic transcript reports a concern.',
  objective: 'Not documented in this encounter.',
  assessment: 'Not documented in this encounter.',
  plan: 'Not documented in this encounter.',
};
const BODY = { transcript: 'A fictional transcript used only for testing.', provider: 'openai', model: 'test-model', language: 'en' };
const AUDIO = { audio: Buffer.from('synthetic audio bytes').toString('base64'), mimeType: 'audio/webm;codecs=opus', language: 'auto' };
const allEnv = { OPENAI_API_KEY: 'test-openai', ANTHROPIC_API_KEY: 'test-anthropic', GEMINI_API_KEY: 'test-gemini', OPENROUTER_API_KEY: 'test-openrouter', COMPATIBLE_BASE_URL: 'http://127.0.0.1:11434/v1', COMPATIBLE_MODEL: 'local-model' };
const noFetch = async () => { assert.fail('Validation must happen before any provider call.'); };

function responseFor(provider, soap = SOAP) {
  const text = JSON.stringify(soap);
  if (provider === 'anthropic') return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
  if (provider === 'gemini') return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] };
  return { choices: [{ finish_reason: 'stop', message: { content: text } }] };
}

async function call(route, { env = {}, body = BODY, method = 'POST', headers = {}, fetchImpl = noFetch, ...options } = {}) {
  const handler = createHandlers({ env, fetchImpl, ...options });
  const req = { method, headers: { host: 'localhost:3000', 'content-type': 'application/json', ...headers }, body };
  const res = {
    headers: {}, statusCode: 200, body: undefined,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler[route](req, res);
  return res;
}

test('public config includes selectable defaults and limits but no secrets or endpoint URLs', async () => {
  const res = await call('config', { method: 'GET', env: { ...allEnv, SCRIBE_ACCESS_TOKEN: 'app-secret', TRANSCRIPTION_API_KEY: 'audio-secret' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.providers.length, 5);
  assert.ok(res.body.providers.every(p => p.configured));
  assert.equal(res.body.access_token_required, true);
  assert.deepEqual(res.body.limits, LIMITS);
  const serialized = JSON.stringify(res.body);
  for (const secret of [...Object.values(allEnv).filter(x => x.startsWith('test-')), 'app-secret', 'audio-secret', allEnv.COMPATIBLE_BASE_URL]) assert.ok(!serialized.includes(secret));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

for (const provider of ['openai', 'anthropic', 'gemini', 'openrouter', 'compatible']) {
  test(`${provider} sends the requested model and source to its correct native endpoint`, async () => {
    let calls = 0;
    const res = await call('generateSoap', {
      env: allEnv, body: { ...BODY, provider, language: 'id' },
      fetchImpl: async (url, options) => {
        calls++;
        const request = JSON.parse(options.body);
        assert.equal(options.method, 'POST');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        const serialized = JSON.stringify(request);
        assert.ok(serialized.includes(BODY.transcript));
        assert.ok(serialized.includes('Bahasa Indonesia'));
        assert.ok(serialized.includes('Tidak didokumentasikan'));
        if (provider === 'anthropic') {
          assert.equal(url, 'https://api.anthropic.com/v1/messages');
          assert.equal(options.headers['x-api-key'], allEnv.ANTHROPIC_API_KEY);
          assert.equal(options.headers['anthropic-version'], '2023-06-01');
          assert.equal(request.model, BODY.model);
          assert.equal(request.messages.length, 1);
        } else if (provider === 'gemini') {
          assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
          assert.equal(options.headers['x-goog-api-key'], allEnv.GEMINI_API_KEY);
          assert.equal(request.generationConfig.responseMimeType, 'application/json');
        } else {
          assert.equal(request.model, BODY.model);
          assert.equal(request.messages[0].role, 'system');
          if (provider === 'compatible') {
            assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions');
            assert.equal(options.headers.Authorization, undefined);
          } else if (provider === 'openrouter') {
            assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
            assert.equal(options.headers.Authorization, `Bearer ${allEnv.OPENROUTER_API_KEY}`);
          } else {
            assert.equal(url, 'https://api.openai.com/v1/chat/completions');
            assert.equal(options.headers.Authorization, `Bearer ${allEnv.OPENAI_API_KEY}`);
            assert.equal(request.store, false);
            assert.ok(request.max_completion_tokens > 0);
          }
        }
        return Response.json(responseFor(provider));
      },
    });
    assert.equal(calls, 1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { soap: SOAP, provider, model: BODY.model, language: 'id', draft: true });
  });
}

test('public deployments fail closed until an application access token is configured', async () => {
  for (const env of [{ VERCEL: '1' }, { NODE_ENV: 'production' }]) {
    for (const route of ['generateSoap', 'processAudio']) {
      const res = await call(route, { env });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, 'access_not_configured');
    }
  }
});

test('wrong and absent app tokens are rejected before provider calls; matching token works', async () => {
  const env = { ...allEnv, SCRIBE_ACCESS_TOKEN: 'example-access-token', VERCEL: '1' };
  for (const authorization of ['', 'Bearer wrong', 'example-access-token']) {
    const res = await call('generateSoap', { env, headers: { authorization } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'unauthorized');
  }
  const res = await call('generateSoap', { env, headers: { authorization: 'Bearer example-access-token', origin: 'http://localhost:3000' }, fetchImpl: async () => Response.json(responseFor('openai')) });
  assert.equal(res.statusCode, 200);
});

test('methods, cross-origin requests and non-JSON requests are rejected', async () => {
  assert.equal((await call('generateSoap', { method: 'GET' })).statusCode, 405);
  assert.equal((await call('generateSoap', { method: 'OPTIONS' })).statusCode, 405);
  assert.equal((await call('generateSoap', { headers: { origin: 'https://attacker.invalid' } })).statusCode, 403);
  assert.equal((await call('generateSoap', { headers: { origin: 'null' } })).statusCode, 403);
  assert.equal((await call('generateSoap', { headers: { 'content-type': 'text/plain' } })).statusCode, 415);
});

test('input and provider configuration errors never masquerade as successful SOAP notes', async () => {
  const cases = [
    [null, 400], [[], 400], ['not JSON', 400], [{ ...BODY, transcript: 'small' }, 400],
    [{ ...BODY, transcript: 'a'.repeat(30001) }, 413], [{ ...BODY, transcript: {} }, 400],
    [{ ...BODY, language: 'invalid' }, 400], [{ ...BODY, provider: 'unknown' }, 400],
    [{ ...BODY, model: 'https://example.invalid/?key=secret' }, 400], [{ ...BODY, model: '' }, 400],
  ];
  for (const [body, expected] of cases) assert.equal((await call('generateSoap', { env: allEnv, body })).statusCode, expected);
  const absent = await call('generateSoap');
  assert.equal(absent.statusCode, 503);
  assert.equal(absent.body.code, 'provider_not_configured');
  assert.equal(absent.body.soap, undefined);
});

test('schema parsing rejects incomplete, non-string, blank, extra and oversized fields', () => {
  assert.deepEqual(parseSoap('```json\n' + JSON.stringify(SOAP) + '\n```'), SOAP);
  for (const value of [null, [], { subjective: 'only one' }, { ...SOAP, plan: [] }, { ...SOAP, plan: '' }, { ...SOAP, extra: 'invented' }, { ...SOAP, plan: 'x'.repeat(12001) }]) {
    assert.throws(() => parseSoap(JSON.stringify(value)), { code: 'invalid_soap_response' });
  }
  assert.throws(() => parseSoap('Here is your note: ' + JSON.stringify(SOAP)));
  assert.match(soapPrompt('en'), /not explicitly documented/);
  assert.match(soapPrompt('en'), /Do not infer a speaker/);
});

test('provider failures are redacted, explicit errors with no fake note or upstream body', async () => {
  for (const [status, expectedCode, expectedStatus] of [[401, 'provider_authentication_failed', 502], [429, 'provider_rate_limited', 429], [404, 'provider_request_rejected', 502], [500, 'provider_unavailable', 502]]) {
    const res = await call('generateSoap', { env: allEnv, fetchImpl: async () => Response.json({ error: 'secret-key and sensitive transcript' }, { status }) });
    assert.equal(res.statusCode, expectedStatus);
    assert.equal(res.body.code, expectedCode);
    assert.equal(res.body.soap, undefined);
    assert.ok(!JSON.stringify(res.body).includes('secret-key'));
  }
  const invalid = await call('generateSoap', { env: allEnv, fetchImpl: async () => new Response('<html>server error with secrets</html>') });
  assert.equal(invalid.body.code, 'invalid_provider_response');
  const connection = await call('generateSoap', { env: allEnv, fetchImpl: async () => { throw new Error('secret connection detail'); } });
  assert.equal(connection.body.code, 'provider_connection_failed');
  assert.ok(!connection.body.error.includes('secret'));
});

test('provider response timeouts abort rather than return a substitute draft', async () => {
  const res = await call('generateSoap', {
    env: allEnv, soapTimeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.code, 'provider_timeout');
});

test('truncated or refused generations are rejected even when their JSON happens to parse', async () => {
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    const payload = responseFor(provider);
    if (provider === 'openai') payload.choices[0].finish_reason = 'length';
    else if (provider === 'anthropic') payload.stop_reason = 'max_tokens';
    else payload.candidates[0].finishReason = 'MAX_TOKENS';
    const res = await call('generateSoap', { env: allEnv, body: { ...BODY, provider }, fetchImpl: async () => Response.json(payload) });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'invalid_soap_response');
  }
});

test('audio transcription sends multipart bytes and returns editable raw text without invented speaker labels', async () => {
  const res = await call('processAudio', {
    env: allEnv, body: { ...AUDIO, language: 'id', model: 'test-transcriber' },
    fetchImpl: async (url, { body, headers }) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(headers.Authorization, `Bearer ${allEnv.OPENAI_API_KEY}`);
      assert.ok(body instanceof FormData);
      assert.equal(body.get('model'), 'test-transcriber');
      assert.equal(body.get('language'), 'id');
      assert.equal(body.get('response_format'), 'json');
      assert.equal(body.get('file').name, 'encounter.webm');
      assert.equal(await body.get('file').text(), 'synthetic audio bytes');
      return Response.json({ text: '  Fictional spoken source text.  ' });
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { raw_transcript: 'Fictional spoken source text.', detected_language: null, model: 'test-transcriber' });
  assert.equal(res.body.soap, undefined);
  assert.equal(res.body.labeled_transcript, undefined);
});

test('custom transcription is independent from text keys and does not leak an OpenAI key', async () => {
  const res = await call('processAudio', {
    env: { ...allEnv, TRANSCRIPTION_BASE_URL: 'http://localhost:8080/v1' }, body: AUDIO,
    fetchImpl: async (url, { headers, body }) => {
      assert.equal(url, 'http://localhost:8080/v1/audio/transcriptions');
      assert.equal(headers.Authorization, undefined);
      assert.equal(body.get('language'), null);
      return Response.json({ text: '' });
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.raw_transcript, '');
  const absent = await call('processAudio', { body: AUDIO });
  assert.equal(absent.statusCode, 503);
  assert.equal(absent.body.code, 'transcription_not_configured');
});

test('audio validation enforces supported formats and a full 2.5 MB decoded boundary', async () => {
  const largest = Buffer.alloc(LIMITS.audio_bytes, 1).toString('base64');
  assert.equal(decodeAudio(largest, 'audio/wav', LIMITS.audio_bytes).buffer.length, LIMITS.audio_bytes);
  for (const [body, status] of [
    [{ ...AUDIO, audio: 'not base64' }, 400], [{ ...AUDIO, audio: '' }, 400],
    [{ ...AUDIO, audio: 'AB==' }, 400], [{ ...AUDIO, mimeType: 'text/plain' }, 415],
    [{ ...AUDIO, audio: Buffer.alloc(LIMITS.audio_bytes + 1).toString('base64') }, 413],
  ]) assert.equal((await call('processAudio', { env: allEnv, body })).statusCode, status);
});

test('browser input cannot select a network endpoint; insecure server endpoints are rejected', async () => {
  const body = { ...BODY, provider: 'compatible', base_url: 'http://attacker.invalid', apiKey: 'injected-key' };
  const res = await call('generateSoap', {
    env: allEnv, body,
    fetchImpl: async (url, { headers }) => {
      assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions');
      assert.equal(headers.Authorization, undefined);
      return Response.json(responseFor('compatible'));
    },
  });
  assert.equal(res.statusCode, 200);
  const insecure = await call('generateSoap', { env: { ...allEnv, COMPATIBLE_BASE_URL: 'http://remote.example/v1' }, body });
  assert.equal(insecure.statusCode, 503);
  assert.equal(insecure.body.code, 'invalid_server_configuration');
});
