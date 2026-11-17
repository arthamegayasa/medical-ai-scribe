import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from '../web/core/chat.js';
import { sseResponse as sse } from './fixtures.js';

const SCHEMA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
const base = { model: 'm-1', system: 'SYSTEM', user: 'USER', schema: SCHEMA, schemaName: 'note' };

const openaiOk = text => Response.json({ choices: [{ finish_reason: 'stop', message: { content: text } }] });

test('OpenAI-family requests use strict json_schema, the preset token parameter and store:false', async () => {
  for (const [provider, tokenParam, store] of [['openai', 'max_completion_tokens', true], ['groq', 'max_completion_tokens', false], ['mistral', 'max_tokens', false], ['local', 'max_tokens', false]]) {
    const result = await generateText({
      ...base, connection: { provider, apiKey: 'key-1' }, maxOutputTokens: 1234,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        assert.ok(url.endsWith('/chat/completions'));
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['Content-Type'], 'application/json');
        assert.deepEqual(body.messages, [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'USER' }]);
        assert.equal(body.model, 'm-1');
        assert.equal(body[tokenParam], 1234);
        assert.equal(body.store, store ? false : undefined);
        assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'note', strict: true, schema: SCHEMA } });
        return openaiOk('{"a":"x"}');
      },
    });
    assert.deepEqual(result, { text: '{"a":"x"}', mode: 'json_schema' });
  }
});

test('OpenRouter requires providers that honour the schema', async () => {
  await generateText({ ...base, connection: { provider: 'openrouter', apiKey: 'k' }, fetchImpl: async (_u, o) => {
    assert.deepEqual(JSON.parse(o.body).provider, { require_parameters: true });
    return openaiOk('{}');
  } });
});

test('structured output falls back json_schema -> json_object -> prompt only on request rejections', async () => {
  const modes = [];
  const result = await generateText({ ...base, connection: { provider: 'openai', apiKey: 'k' }, fetchImpl: async (_u, o) => {
    const body = JSON.parse(o.body);
    modes.push(body.response_format?.type ?? 'prompt');
    if (body.response_format) return new Response('{"error":"unsupported response_format"}', { status: 400 });
    return openaiOk('{"a":"x"}');
  } });
  assert.deepEqual(modes, ['json_schema', 'json_object', 'prompt']);
  assert.equal(result.mode, 'prompt');
  let calls = 0;
  await assert.rejects(generateText({ ...base, connection: { provider: 'openai', apiKey: 'k' }, fetchImpl: async () => { calls++; return new Response('maximum context length exceeded', { status: 400 }); } }), { code: 'context_too_long' });
  assert.equal(calls, 1);
  await assert.rejects(generateText({ ...base, connection: { provider: 'openai', apiKey: 'k' }, fetchImpl: async () => new Response('', { status: 401 }) }), { code: 'auth' });
  const explicit = [];
  await generateText({ ...base, structured: 'prompt', connection: { provider: 'openai', apiKey: 'k' }, fetchImpl: async (_u, o) => { explicit.push(JSON.parse(o.body).response_format); return openaiOk('{}'); } });
  assert.deepEqual(explicit, [undefined]);
});

test('Anthropic uses output_config.format and Messages API stop reasons', async () => {
  const result = await generateText({ ...base, connection: { provider: 'anthropic', apiKey: 'k' }, maxOutputTokens: 900, fetchImpl: async (url, o) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(o.body);
    assert.equal(o.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.deepEqual(body, { model: 'm-1', max_tokens: 900, system: 'SYSTEM', messages: [{ role: 'user', content: 'USER' }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } });
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '"x"}' }] });
  } });
  assert.deepEqual(result, { text: '{"a":"x"}', mode: 'json_schema' });
  for (const [stop_reason, code] of [['max_tokens', 'truncated'], ['refusal', 'refusal']]) {
    await assert.rejects(generateText({ ...base, connection: { provider: 'anthropic', apiKey: 'k' }, fetchImpl: async () => Response.json({ stop_reason, content: [{ type: 'text', text: '{}' }] }) }), { code });
  }
});

test('Gemini uses responseJsonSchema, header auth, and maps finish and block reasons', async () => {
  const result = await generateText({ ...base, connection: { provider: 'gemini', apiKey: 'k' }, attachments: [{ mimeType: 'audio/wav', data: 'QUJD' }], fetchImpl: async (url, o) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/m-1:generateContent');
    assert.equal(o.headers['x-goog-api-key'], 'k');
    const body = JSON.parse(o.body);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'SYSTEM' }] });
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'QUJD' } }, { text: 'USER' }] }]);
    assert.deepEqual(body.generationConfig, { maxOutputTokens: 16000, responseMimeType: 'application/json', responseJsonSchema: SCHEMA });
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hidden', thought: true }, { text: '{"a":"x"}' }] } }] });
  } });
  assert.equal(result.text, '{"a":"x"}');
  for (const [payload, code] of [
    [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] }, 'truncated'],
    [{ candidates: [{ finishReason: 'SAFETY' }] }, 'refusal'],
    [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }, 'refusal'],
  ]) await assert.rejects(generateText({ ...base, connection: { provider: 'gemini', apiKey: 'k' }, fetchImpl: async () => Response.json(payload) }), { code });
  await assert.rejects(generateText({ ...base, attachments: [{ mimeType: 'audio/wav', data: 'x' }], connection: { provider: 'openai', apiKey: 'k' }, fetchImpl: async () => assert.fail() }), { code: 'unsupported' });
});

test('OpenAI-family finish reasons: length truncates, refusals and content filters refuse', async () => {
  for (const [choice, code] of [
    [{ finish_reason: 'length', message: { content: '{"a":' } }, 'truncated'],
    [{ finish_reason: 'content_filter', message: { content: '' } }, 'refusal'],
    [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help' } }, 'refusal'],
    [{ message: { content: '{}' } }, 'truncated'],
  ]) await assert.rejects(generateText({ ...base, connection: { provider: 'openai', apiKey: 'k' }, fetchImpl: async () => Response.json({ choices: [choice] }) }), { code });
});

test('streaming reports accumulated text per family through onDelta', async () => {
  const streams = {
    openai: ['data: {"choices":[{"delta":{"content":"{\\"a\\""}}]}\n\n', 'data: {"choices":[{"delta":{"content":":\\"x\\"}"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'],
    anthropic: ['event: message_start\ndata: {"type":"message_start"}\n\n', 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"zz"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"a\\""}}\n\n', 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":":\\"x\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', 'event: message_stop\ndata: {"type":"message_stop"}\n\n'],
    gemini: ['data: {"candidates":[{"content":{"parts":[{"text":"{\\"a\\""}]}}]}\n\n', 'data: {"candidates":[{"content":{"parts":[{"text":":\\"x\\"}"}]},"finishReason":"STOP"}]}\n\n'],
  };
  for (const [provider, lines] of Object.entries(streams)) {
    const deltas = [];
    const result = await generateText({ ...base, stream: true, connection: { provider, apiKey: 'k' }, onDelta: d => deltas.push(d), fetchImpl: async (url, o) => {
      const body = JSON.parse(o.body);
      if (provider === 'gemini') assert.ok(url.endsWith(':streamGenerateContent?alt=sse'));
      else assert.equal(body.stream, true);
      return sse(lines);
    } });
    assert.equal(result.text, '{"a":"x"}', provider);
    assert.deepEqual(deltas.map(d => d.text), ['{"a"', '{"a":"x"}'], provider);
    assert.equal(deltas[0].mode, 'json_schema');
  }
  await assert.rejects(generateText({ ...base, stream: true, connection: { provider: 'anthropic', apiKey: 'k' }, fetchImpl: async () => sse(['event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"secret"}}\n\n']) }), { code: 'provider_unavailable' });
  await assert.rejects(generateText({ ...base, stream: true, connection: { provider: 'openai', apiKey: 'k' }, fetchImpl: async () => sse(['data: {"choices":[{"delta":{"content":"{"}}]}\n\n']) }), { code: 'truncated' });
});

test('Groq skips json_schema when streaming because it rejects that combination', async () => {
  const formats = [];
  await generateText({ ...base, stream: true, connection: { provider: 'groq', apiKey: 'k' }, fetchImpl: async (_u, o) => {
    formats.push(JSON.parse(o.body).response_format?.type);
    return sse(['data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']);
  } });
  assert.deepEqual(formats, ['json_object']);
});

test('generation can be cancelled mid-stream', async () => {
  const controller = new AbortController();
  const pending = generateText({ ...base, stream: true, signal: controller.signal, connection: { provider: 'openai', apiKey: 'k' }, fetchImpl: async (_u, { signal }) => new Response(new ReadableStream({
    start(c) { signal.addEventListener('abort', () => c.error(new Error('aborted'))); c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{"}}]}\n\n')); },
  })) });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, { code: 'aborted' });
});
