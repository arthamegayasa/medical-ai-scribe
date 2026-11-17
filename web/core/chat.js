import { ScribeError, invalidInput } from './errors.js';
import { readJson, request, sseEvents } from './http.js';
import { authHeaders, resolveConnection } from './providers.js';

const STOP = 'stop';

// Normalised finish states: 'stop' | 'length' | 'refusal' | 'error' | null (unknown / missing).
const OPENAI_FINISH = { stop: STOP, length: 'length', content_filter: 'refusal' };
const ANTHROPIC_FINISH = { end_turn: STOP, stop_sequence: STOP, max_tokens: 'length', refusal: 'refusal', model_context_window_exceeded: 'length' };
const GEMINI_REFUSALS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);
const geminiFinish = reason => (reason === 'STOP' ? STOP : reason === 'MAX_TOKENS' ? 'length' : GEMINI_REFUSALS.has(reason) ? 'refusal' : reason ? 'error' : null);

function buildRequest({ preset, baseUrl, apiKey }, { model, system, user, attachments, schema, schemaName, mode, maxOutputTokens, stream }) {
  const headers = { 'Content-Type': 'application/json', ...authHeaders({ preset, apiKey }) };
  if (preset.family === 'anthropic') {
    const body = { model, max_tokens: maxOutputTokens, system, messages: [{ role: 'user', content: user }] };
    if (mode === 'json_schema') body.output_config = { format: { type: 'json_schema', schema } };
    if (stream) body.stream = true;
    return { url: `${baseUrl}/messages`, headers, body };
  }
  if (preset.family === 'gemini') {
    const generationConfig = { maxOutputTokens };
    if (mode !== 'prompt') generationConfig.responseMimeType = 'application/json';
    if (mode === 'json_schema') generationConfig.responseJsonSchema = schema;
    const parts = [...attachments.map(({ mimeType, data }) => ({ inlineData: { mimeType, data } })), { text: user }];
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return {
      url: `${baseUrl}/models/${encodeURIComponent(model)}:${action}`, headers,
      body: { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig },
    };
  }
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], [preset.tokenParam || 'max_tokens']: maxOutputTokens };
  if (preset.sendStore) body.store = false;
  if (mode === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } };
    if (preset.requireParameters) body.provider = { require_parameters: true };
  } else if (mode === 'json_object') body.response_format = { type: 'json_object' };
  if (stream) body.stream = true;
  return { url: `${baseUrl}/chat/completions`, headers, body };
}

function textParts(parts) {
  return Array.isArray(parts) ? parts.filter(p => typeof p?.text === 'string' && !p.thought).map(p => p.text).join('') : '';
}

function parseComplete(family, data) {
  if (family === 'anthropic') {
    const text = Array.isArray(data.content) ? data.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('') : '';
    return { text, finish: ANTHROPIC_FINISH[data.stop_reason] ?? (data.stop_reason ? 'error' : null) };
  }
  if (family === 'gemini') {
    if (data.promptFeedback?.blockReason) return { text: '', finish: 'refusal' };
    const candidate = data.candidates?.[0];
    return { text: textParts(candidate?.content?.parts), finish: geminiFinish(candidate?.finishReason) };
  }
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content : textParts(content);
  if (choice?.message?.refusal) return { text, finish: 'refusal' };
  return { text, finish: OPENAI_FINISH[choice?.finish_reason] ?? (choice?.finish_reason ? 'error' : null) };
}

function streamError(errorType) {
  if (errorType === 'overloaded_error' || errorType === 'api_error') return new ScribeError('provider_unavailable');
  if (errorType === 'rate_limit_error') return new ScribeError('rate_limit');
  return new ScribeError('invalid_response', 'The provider reported an error while streaming.');
}

async function consumeStream(family, response, onChunk) {
  let finish = null;
  for await (const { event, data } of sseEvents(response)) {
    if (data === '[DONE]') break;
    let json;
    try { json = JSON.parse(data); } catch { throw new ScribeError('invalid_response', 'The provider sent a malformed stream event.'); }
    if (family === 'anthropic') {
      if (event === 'error' || json.type === 'error') throw streamError(json.error?.type);
      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') onChunk(json.delta.text);
      if (json.type === 'message_delta' && json.delta?.stop_reason) finish = ANTHROPIC_FINISH[json.delta.stop_reason] ?? 'error';
    } else if (family === 'gemini') {
      const parsed = parseComplete('gemini', json);
      if (parsed.text) onChunk(parsed.text);
      if (parsed.finish) finish = parsed.finish;
    } else {
      if (json.error) throw streamError();
      const choice = json.choices?.[0];
      if (typeof choice?.delta?.content === 'string' && choice.delta.content) onChunk(choice.delta.content);
      if (choice?.delta?.refusal) finish = 'refusal';
      else if (choice?.finish_reason) finish = OPENAI_FINISH[choice.finish_reason] ?? 'error';
    }
  }
  return finish;
}

function checkFinish(finish) {
  if (finish === STOP) return;
  if (finish === 'refusal') throw new ScribeError('refusal');
  if (finish === 'length' || finish === null) throw new ScribeError('truncated');
  throw new ScribeError('invalid_output', 'The model stopped for an unexpected reason. Try again or choose another model.');
}

function modesFor(preset, structured, stream) {
  if (structured !== 'auto') {
    if (!preset.structuredModes.includes(structured)) throw invalidInput(`${preset.label} does not support ${structured} output.`);
    return [structured];
  }
  return preset.structuredModes.filter(mode => !(mode === 'json_schema' && stream && preset.schemaWithStream === false));
}

/**
 * Runs one chat generation and returns the complete model text.
 * Tries the provider's native JSON-schema mode first, then JSON mode, then prompt-only, moving
 * down only when the provider rejects the request format (`bad_request`).
 *
 * @returns {Promise<{ text: string, mode: 'json_schema' | 'json_object' | 'prompt' }>}
 */
export async function generateText({
  connection, model, system, user, attachments = [], schema, schemaName = 'result', structured = 'auto',
  maxOutputTokens = 16000, stream = false, onDelta, signal, timeoutMs = 300000, fetchImpl,
}) {
  const resolved = resolveConnection(connection);
  const { preset } = resolved;
  if (!preset.capabilities.chat) throw new ScribeError('unsupported', `${preset.label} does not offer text generation.`);
  if (attachments.length && preset.family !== 'gemini') throw new ScribeError('unsupported', `${preset.label} does not accept audio in text generation.`);
  if (typeof model !== 'string' || !model.trim()) throw invalidInput('Choose a model.');
  const modes = modesFor(preset, schema ? structured : 'prompt', stream);

  for (let index = 0; index < modes.length; index++) {
    const mode = modes[index];
    const { url, headers, body } = buildRequest(resolved, { model: model.trim(), system, user, attachments, schema, schemaName, mode, maxOutputTokens, stream });
    try {
      return await request(url, { method: 'POST', headers, body: JSON.stringify(body), signal, timeoutMs, fetchImpl }, async response => {
        if (!stream) {
          const { text, finish } = parseComplete(preset.family, await readJson(response));
          checkFinish(finish);
          return { text, mode };
        }
        let text = '';
        const finish = await consumeStream(preset.family, response, delta => {
          text += delta;
          onDelta?.({ text, delta, mode });
        });
        checkFinish(finish);
        return { text, mode };
      });
    } catch (error) {
      if (!(error instanceof ScribeError) || error.code !== 'bad_request' || index === modes.length - 1) throw error;
    }
  }
  throw new ScribeError('invalid_output');
}
