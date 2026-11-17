import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, authHeaders, getProvider, listProviders, resolveConnection, suggestedModels, validateBaseUrl } from '../web/core/providers.js';
import { listModels, testConnection } from '../web/core/models.js';

test('catalog covers the required presets with complete, honest metadata', () => {
  const ids = PROVIDERS.map(p => p.id);
  for (const id of ['openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'mistral', 'local', 'custom', 'deepgram', 'elevenlabs']) assert.ok(ids.includes(id), id);
  for (const preset of PROVIDERS) {
    assert.ok(['openai', 'anthropic', 'gemini', 'deepgram', 'elevenlabs'].includes(preset.family));
    assert.ok(['direct', 'local', 'unknown'].includes(preset.browser));
    assert.equal(typeof preset.capabilities.chat, 'boolean');
    if (preset.capabilities.chat) assert.ok(preset.structuredModes.includes('prompt'), preset.id);
    if (preset.capabilities.transcription) assert.ok(preset.maxUploadBytes > 0 && preset.transcriptionDialect, preset.id);
    if (preset.baseUrl) assert.equal(validateBaseUrl(preset.baseUrl), preset.baseUrl);
  }
  assert.deepEqual(listProviders('transcription').map(p => p.id).sort(), ['custom', 'deepgram', 'elevenlabs', 'gemini', 'groq', 'local', 'mistral', 'openai']);
  assert.ok(suggestedModels('anthropic').includes('claude-opus-5-5'));
  assert.throws(() => getProvider('nope'), { code: 'invalid_input' });
});

test('connections validate keys and endpoints; fixed presets ignore a supplied base URL', () => {
  assert.deepEqual(resolveConnection({ provider: 'openai', apiKey: ' sk-1 ', baseUrl: 'https://attacker.example' }).baseUrl, 'https://api.openai.com/v1');
  assert.equal(resolveConnection({ provider: 'openai', apiKey: ' sk-1 ' }).apiKey, 'sk-1');
  assert.equal(resolveConnection({ provider: 'local' }).baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(resolveConnection({ provider: 'local', baseUrl: 'http://localhost:1234/v1/' }).baseUrl, 'http://localhost:1234/v1');
  assert.equal(resolveConnection({ provider: 'custom', baseUrl: 'https://llm.example.org/v1' }).apiKey, '');
  for (const bad of [
    { provider: 'openai' }, { provider: 'openai', apiKey: 'a\nb' }, { provider: 'custom' },
    { provider: 'custom', baseUrl: 'http://remote.example/v1' }, { provider: 'custom', baseUrl: 'https://u:p@x.example' },
    { provider: 'custom', baseUrl: 'https://x.example/v1?key=1' }, { provider: 'custom', baseUrl: 'ftp://x.example' }, null,
  ]) assert.throws(() => resolveConnection(bad), { code: 'invalid_input' });
});

test('each family authenticates with its documented header', () => {
  const headers = id => authHeaders(resolveConnection({ provider: id, apiKey: 'k', baseUrl: 'https://x.example' }));
  assert.deepEqual(headers('openai'), { Authorization: 'Bearer k' });
  assert.deepEqual(headers('anthropic'), { 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
  assert.deepEqual(headers('gemini'), { 'x-goog-api-key': 'k' });
  assert.deepEqual(headers('deepgram'), { Authorization: 'Token k' });
  assert.deepEqual(headers('elevenlabs'), { 'xi-api-key': 'k' });
  assert.deepEqual(authHeaders(resolveConnection({ provider: 'local' })), {});
});

test('model listing uses each provider endpoint and normalises results', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push([url, options.method, options.headers]);
    if (url.startsWith('https://api.openai.com')) return Response.json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'text-embedding-3-large' }, { id: 'gpt-transcribe' }, { id: 'tts-1' }] });
    if (url.startsWith('https://api.anthropic.com')) return Response.json({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000 }] });
    if (url.includes('generativelanguage')) {
      return Response.json(url.includes('pageToken')
        ? { models: [{ name: 'models/gemini-4-hydrogen', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 }] }
        : { models: [{ name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'p2' });
    }
    if (url.startsWith('https://openrouter.ai')) return Response.json({ data: [{ id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', context_length: 1000000, supported_parameters: ['structured_outputs'] }] });
    return Response.json({ data: [] });
  };
  assert.deepEqual((await listModels({ provider: 'openai', apiKey: 'k' }, { fetchImpl })).map(m => m.id), ['gpt-6.1-sol']);
  assert.deepEqual((await listModels({ provider: 'openai', apiKey: 'k' }, { fetchImpl, purpose: 'transcription' })).map(m => m.id), ['gpt-transcribe']);
  assert.deepEqual(await listModels({ provider: 'anthropic', apiKey: 'k' }, { fetchImpl }), [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextTokens: 1000000 }]);
  assert.deepEqual((await listModels({ provider: 'gemini', apiKey: 'k' }, { fetchImpl })).map(m => m.id), ['gemini-3.8-flash', 'gemini-4-hydrogen']);
  assert.deepEqual(await listModels({ provider: 'openrouter', apiKey: 'k' }, { fetchImpl }), [{ id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', contextTokens: 1000000, structuredOutputs: true }]);
  assert.ok(seen.every(([url, method]) => method === 'GET' && !url.includes('k=')));
  assert.equal(seen.find(([url]) => url.includes('anthropic'))[2]['anthropic-dangerous-direct-browser-access'], 'true');
  await assert.rejects(listModels({ provider: 'deepgram', apiKey: 'k' }, { fetchImpl }), { code: 'unsupported' });
});

test('testConnection doubles as key validation', async () => {
  const ok = await testConnection({ provider: 'groq', apiKey: 'k' }, { fetchImpl: async () => Response.json({ data: [{ id: 'llama-3.3-70b-versatile', context_window: 131072 }] }) });
  assert.deepEqual(ok, { ok: true, models: [{ id: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile', contextTokens: 131072 }] });
  await assert.rejects(testConnection({ provider: 'groq', apiKey: 'bad' }, { fetchImpl: async () => new Response('{"error":"bad key bad"}', { status: 401 }) }), { code: 'auth' });
  const eleven = await testConnection({ provider: 'elevenlabs', apiKey: 'k' }, {
    fetchImpl: async (url, { headers }) => { assert.equal(url, 'https://api.elevenlabs.io/v1/user'); assert.equal(headers['xi-api-key'], 'k'); return Response.json({}); },
  });
  assert.deepEqual(eleven, { ok: true, models: [{ id: 'scribe_v2', label: 'scribe_v2' }] });
  await assert.rejects(testConnection({ provider: 'deepgram', apiKey: 'k' }, { fetchImpl: async () => assert.fail('no call') }), { code: 'unsupported' });
});
