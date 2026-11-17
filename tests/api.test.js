import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from '../lib/handlers.js';
import { LIMITS } from '../lib/config.js';
import { decodeAudio } from '../lib/audio.js';
import { NOTE, openaiReply } from './fixtures.js';

const BODY = { transcript: 'A fictional transcript used only for testing.', provider: 'openai', model: 'test-model', language: 'en' };
const AUDIO = { audio: Buffer.from('synthetic audio bytes').toString('base64'), mimeType: 'audio/webm;codecs=opus', language: 'auto' };
const allEnv = {
  OPENAI_API_KEY: 'test-openai', ANTHROPIC_API_KEY: 'test-anthropic', GEMINI_API_KEY: 'test-gemini', OPENROUTER_API_KEY: 'test-openrouter',
  GROQ_API_KEY: 'test-groq', MISTRAL_API_KEY: 'test-mistral', COMPATIBLE_BASE_URL: 'http://127.0.0.1:11434/v1', COMPATIBLE_MODEL: 'local-model',
};
const noFetch = async () => { assert.fail('Validation must happen before any provider call.'); };

function responseFor(provider, note = NOTE) {
  const text = JSON.stringify(note);
  if (provider === 'anthropic') return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
  if (provider === 'gemini') return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
  return openaiReply(text);
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

test('public config includes availability, defaults and limits but no secrets or endpoint URLs', async () => {
  const res = await call('config', { method: 'GET', env: { ...allEnv, SCRIBE_ACCESS_TOKEN: 'app-secret', TRANSCRIPTION_API_KEY: 'audio-secret' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, 'server');
  assert.deepEqual(res.body.providers.map(p => p.id), ['openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'mistral', 'compatible']);
  assert.ok(res.body.providers.every(p => p.configured));
  assert.equal(res.body.providers.find(p => p.id === 'compatible').default_model, 'local-model');
  assert.deepEqual(res.body.transcription, { configured: true, provider: 'openai', default_model: 'gpt-transcribe', diarization: true });
  assert.equal(res.body.access_token_required, true);
  assert.deepEqual(res.body.limits, LIMITS);
  const serialized = JSON.stringify(res.body);
  for (const secret of [...Object.values(allEnv).filter(x => x.startsWith('test-')), 'app-secret', 'audio-secret', allEnv.COMPATIBLE_BASE_URL]) assert.ok(!serialized.includes(secret));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  const empty = await call('config', { method: 'GET' });
  assert.ok(empty.body.providers.every(p => !p.configured) && !empty.body.transcription.configured && !empty.body.access_token_required);
});

for (const provider of ['openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'mistral', 'compatible']) {
  test(`${provider} sends the requested model and source to its native endpoint and returns the shared note schema`, async () => {
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
          const expected = {
            openai: ['https://api.openai.com/v1', allEnv.OPENAI_API_KEY], openrouter: ['https://openrouter.ai/api/v1', allEnv.OPENROUTER_API_KEY],
            groq: ['https://api.groq.com/openai/v1', allEnv.GROQ_API_KEY], mistral: ['https://api.mistral.ai/v1', allEnv.MISTRAL_API_KEY], compatible: ['http://127.0.0.1:11434/v1', undefined],
          }[provider];
          assert.equal(url, `${expected[0]}/chat/completions`);
          assert.equal(options.headers.Authorization, expected[1] && `Bearer ${expected[1]}`);
          if (provider === 'openai') { assert.equal(request.store, false); assert.ok(request.max_completion_tokens > 0); }
        }
        return responseFor(provider);
      },
    });
    assert.equal(calls, 1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.note, NOTE);
    assert.equal(res.body.meta.provider, provider);
    assert.equal(res.body.meta.model, BODY.model);
    assert.equal(res.body.meta.language, 'id');
    assert.equal(res.body.meta.draft, true);
  });
}

test('public deployments fail closed until an application access token is configured', async () => {
  for (const env of [{ VERCEL: '1' }, { NODE_ENV: 'production' }]) {
    for (const route of ['generateSoap', 'processAudio', 'labelSpeakers']) {
      const res = await call(route, { env });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, 'access_not_configured');
    }
  }
});

test('wrong and absent app tokens are rejected before provider calls; matching token works', async () => {
  const env = { ...allEnv, SCRIBE_ACCESS_TOKEN: 'example-access-token', VERCEL: '1' };
  for (const route of ['generateSoap', 'labelSpeakers', 'processAudio']) {
    for (const authorization of ['', 'Bearer wrong', 'example-access-token']) {
      const res = await call(route, { env, headers: { authorization } });
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, 'unauthorized');
    }
  }
  const res = await call('generateSoap', { env, headers: { authorization: 'Bearer example-access-token', origin: 'http://localhost:3000' }, fetchImpl: async () => responseFor('openai') });
  assert.equal(res.statusCode, 200);
});

test('methods, cross-origin requests and non-JSON requests are rejected', async () => {
  assert.equal((await call('generateSoap', { method: 'GET' })).statusCode, 405);
  assert.equal((await call('generateSoap', { method: 'OPTIONS' })).statusCode, 405);
  assert.equal((await call('config', { method: 'POST' })).statusCode, 405);
  for (const route of ['generateSoap', 'labelSpeakers', 'processAudio']) {
    assert.equal((await call(route, { headers: { origin: 'https://attacker.invalid' } })).statusCode, 403);
    assert.equal((await call(route, { headers: { origin: 'null' } })).statusCode, 403);
    assert.equal((await call(route, { headers: { 'content-type': 'text/plain' } })).statusCode, 415);
  }
});

test('input and provider configuration errors never masquerade as successful notes', async () => {
  const cases = [
    [null, 400], [[], 400], ['not JSON', 400], [{ ...BODY, transcript: 'small' }, 400],
    [{ ...BODY, transcript: 'a'.repeat(LIMITS.transcript_chars + 1) }, 413], [{ ...BODY, transcript: {} }, 400],
    [{ ...BODY, language: 'invalid' }, 400], [{ ...BODY, template: 'invalid' }, 400], [{ ...BODY, provider: 'unknown' }, 400],
    [{ ...BODY, model: 'https://example.invalid/?key=secret' }, 400], [{ ...BODY, model: '' }, 400],
    [{ ...BODY, custom_instructions: 'x'.repeat(2001) }, 400], [{ ...BODY, section: 'billing', note: NOTE }, 400],
  ];
  for (const [body, expected] of cases) {
    const res = await call('generateSoap', { env: allEnv, body });
    assert.equal(res.statusCode, expected, JSON.stringify(body)?.slice(0, 80));
    assert.equal(res.body.note, undefined);
  }
  const absent = await call('generateSoap');
  assert.equal(absent.statusCode, 503);
  assert.equal(absent.body.code, 'provider_not_configured');
  assert.equal(absent.body.note, undefined);
  const malformed = await call('generateSoap', { env: allEnv, fetchImpl: async () => openaiReply({ ...NOTE, extra: [] }) });
  assert.equal(malformed.statusCode, 502);
  assert.equal(malformed.body.code, 'invalid_output');
  assert.equal(malformed.body.note, undefined);
});

test('provider failures are redacted, explicit errors with no fake note or upstream body', async () => {
  for (const [status, expectedCode, expectedStatus] of [[401, 'auth', 502], [429, 'rate_limit', 429], [404, 'model_not_found', 502], [500, 'provider_unavailable', 502]]) {
    const res = await call('generateSoap', { env: allEnv, fetchImpl: async () => Response.json({ error: 'secret-key and sensitive transcript' }, { status }) });
    assert.equal(res.statusCode, expectedStatus);
    assert.equal(res.body.code, expectedCode);
    assert.equal(res.body.note, undefined);
    assert.ok(!JSON.stringify(res.body).includes('secret-key'));
  }
  const auth = await call('generateSoap', { env: allEnv, fetchImpl: async () => new Response('', { status: 401 }) });
  assert.match(auth.body.error, /server credentials/);
  const invalid = await call('generateSoap', { env: allEnv, fetchImpl: async () => new Response('<html>server error with secrets</html>') });
  assert.equal(invalid.body.code, 'invalid_response');
  const connection = await call('generateSoap', { env: allEnv, fetchImpl: async () => { throw new Error('secret connection detail'); } });
  assert.equal(connection.body.code, 'network');
  assert.ok(!connection.body.error.includes('secret'));
  const tooLong = await call('generateSoap', { env: allEnv, fetchImpl: async () => new Response('{"error":{"code":"context_length_exceeded"}}', { status: 400 }) });
  assert.equal(tooLong.statusCode, 413);
  assert.equal(tooLong.body.code, 'context_too_long');
});

test('provider response timeouts abort rather than return a substitute draft', async () => {
  const res = await call('generateSoap', {
    env: allEnv, soapTimeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.code, 'timeout');
});

test('truncated or refused generations are rejected even when their JSON happens to parse', async () => {
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    const payload = await responseFor(provider).json();
    if (provider === 'openai') payload.choices[0].finish_reason = 'length';
    else if (provider === 'anthropic') payload.stop_reason = 'max_tokens';
    else payload.candidates[0].finishReason = 'MAX_TOKENS';
    const res = await call('generateSoap', { env: allEnv, body: { ...BODY, provider }, fetchImpl: async () => Response.json(payload) });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'truncated');
    assert.equal(res.body.note, undefined);
  }
  const refused = await call('generateSoap', { env: allEnv, body: { ...BODY, provider: 'anthropic' }, fetchImpl: async () => Response.json({ stop_reason: 'refusal', content: [] }) });
  assert.equal(refused.statusCode, 422);
  assert.equal(refused.body.code, 'refusal');
});

test('section regeneration and speaker labelling run through the same server-held provider', async () => {
  const items = [{ text: 'Rest.', evidence: ['rest'] }];
  const section = await call('generateSoap', { env: allEnv, body: { ...BODY, note: NOTE, section: 'plan' }, fetchImpl: async () => openaiReply({ items }) });
  assert.equal(section.statusCode, 200);
  assert.deepEqual(section.body.note.plan, items);
  assert.equal(section.body.section, 'plan');
  const source = 'How are you today? I am fine thanks.';
  const labelled = await call('labelSpeakers', { env: allEnv, body: { provider: 'openai', transcript: source }, fetchImpl: async (_u, o) => {
    assert.equal(JSON.parse(o.body).model, 'gpt-6.1-terra');
    return openaiReply({ turns: [{ speaker: 'Doctor', text: 'How are you today?' }, { speaker: 'Patient', text: 'I am fine thanks.' }] });
  } });
  assert.equal(labelled.statusCode, 200);
  assert.equal(labelled.body.text, 'Doctor: How are you today?\nPatient: I am fine thanks.');
  const changed = await call('labelSpeakers', { env: allEnv, body: { provider: 'openai', transcript: source }, fetchImpl: async () => openaiReply({ turns: [{ speaker: 'Doctor', text: 'How are you?' }] }) });
  assert.equal(changed.statusCode, 422);
  assert.equal(changed.body.code, 'verification_failed');
});

test('audio transcription sends multipart bytes and returns editable raw text without invented speaker labels', async () => {
  const res = await call('processAudio', {
    env: allEnv, body: { ...AUDIO, language: 'id', model: 'gpt-transcribe', vocabulary: ['levetiracetam'] },
    fetchImpl: async (url, { body, headers }) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(headers.Authorization, `Bearer ${allEnv.OPENAI_API_KEY}`);
      assert.ok(body instanceof FormData);
      assert.equal(body.get('model'), 'gpt-transcribe');
      assert.deepEqual(body.getAll('languages[]'), ['id']);
      assert.deepEqual(body.getAll('keywords[]'), ['levetiracetam']);
      assert.equal(body.get('file').name, 'audio.webm');
      assert.equal(await body.get('file').text(), 'synthetic audio bytes');
      return Response.json({ text: '  Fictional spoken source text.  ' });
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { text: 'Fictional spoken source text.', segments: [], language: null, model: 'gpt-transcribe', provider: 'server' });
  assert.equal(res.body.note, undefined);
});

test('custom transcription is independent from text keys and does not leak an OpenAI key', async () => {
  const res = await call('processAudio', {
    env: { ...allEnv, TRANSCRIPTION_BASE_URL: 'http://localhost:8080/v1', TRANSCRIPTION_MODEL: 'local-whisper' }, body: AUDIO,
    fetchImpl: async (url, { headers, body }) => {
      assert.equal(url, 'http://localhost:8080/v1/audio/transcriptions');
      assert.equal(headers.Authorization, undefined);
      assert.equal(body.get('model'), 'local-whisper');
      assert.equal(body.get('language'), null);
      return Response.json({ text: '' });
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.text, '');
  const groq = await call('processAudio', { env: { GROQ_API_KEY: 'test-groq', TRANSCRIPTION_PROVIDER: 'groq' }, body: AUDIO, fetchImpl: async (url, { headers, body }) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(headers.Authorization, 'Bearer test-groq');
    assert.equal(body.get('model'), 'whisper-large-v3-turbo');
    return Response.json({ text: 'ok' });
  } });
  assert.equal(groq.statusCode, 200);
  const absent = await call('processAudio', { body: AUDIO });
  assert.equal(absent.statusCode, 503);
  assert.equal(absent.body.code, 'transcription_not_configured');
  const unknown = await call('processAudio', { env: { TRANSCRIPTION_PROVIDER: 'nope', OPENAI_API_KEY: 'x' }, body: AUDIO });
  assert.equal(unknown.body.code, 'invalid_server_configuration');
});

test('audio validation enforces supported formats and the full decoded size boundary', async () => {
  const largest = Buffer.alloc(LIMITS.audio_bytes, 1).toString('base64');
  assert.equal(decodeAudio(largest, 'audio/wav', LIMITS.audio_bytes).size, LIMITS.audio_bytes);
  for (const [body, status] of [
    [{ ...AUDIO, audio: 'not base64' }, 400], [{ ...AUDIO, audio: '' }, 400],
    [{ ...AUDIO, audio: 'AB==' }, 400], [{ ...AUDIO, mimeType: 'text/plain' }, 415],
    [{ ...AUDIO, audio: Buffer.alloc(LIMITS.audio_bytes + 1).toString('base64') }, 413],
    [{ ...AUDIO, language: 'english' }, 400], [{ ...AUDIO, vocabulary: 'a,b' }, 400],
  ]) assert.equal((await call('processAudio', { env: allEnv, body })).statusCode, status);
});

test('browser input cannot select a network endpoint or key; insecure server endpoints are rejected', async () => {
  const body = { ...BODY, provider: 'compatible', base_url: 'http://attacker.invalid', baseUrl: 'http://attacker.invalid', apiKey: 'injected-key' };
  const res = await call('generateSoap', {
    env: allEnv, body,
    fetchImpl: async (url, { headers }) => {
      assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions');
      assert.equal(headers.Authorization, undefined);
      return responseFor('compatible');
    },
  });
  assert.equal(res.statusCode, 200);
  const insecure = await call('generateSoap', { env: { ...allEnv, COMPATIBLE_BASE_URL: 'http://remote.example/v1' }, body });
  assert.equal(insecure.statusCode, 503);
  assert.equal(insecure.body.code, 'invalid_server_configuration');
  const insecureAudio = await call('processAudio', { env: { TRANSCRIPTION_BASE_URL: 'http://remote.example/v1' }, body: AUDIO });
  assert.equal(insecureAudio.body.code, 'invalid_server_configuration');
});
