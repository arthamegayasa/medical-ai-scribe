import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTranscripts, transcribe, transcribeSegments, transcriptToText } from '../web/core/transcribe.js';

const AUDIO = new Blob(['synthetic audio bytes'], { type: 'audio/webm;codecs=opus' });
const fields = form => [...form.keys()].filter((k, i, a) => a.indexOf(k) === i).sort();

test('gpt-transcribe sends keywords and languages arrays and reads detected languages', async () => {
  const result = await transcribe({
    connection: { provider: 'openai', apiKey: 'k' }, model: 'gpt-transcribe', audio: AUDIO, language: 'id', vocabulary: ['amlodipine', ' levetiracetam ', 'amlodipine', ''],
    fetchImpl: async (url, { method, headers, body }) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(method, 'POST');
      assert.equal(headers.Authorization, 'Bearer k');
      assert.equal(headers['Content-Type'], undefined, 'multipart boundary must be set by fetch');
      assert.equal(body.get('model'), 'gpt-transcribe');
      assert.equal(body.get('file').name, 'audio.webm');
      assert.equal(await body.get('file').text(), 'synthetic audio bytes');
      assert.deepEqual(body.getAll('keywords[]'), ['amlodipine', 'levetiracetam']);
      assert.deepEqual(body.getAll('languages[]'), ['id']);
      assert.equal(body.get('language'), null);
      assert.equal(body.get('response_format'), 'json');
      return Response.json({ text: '  Fictional spoken text.  ', languages: [{ code: 'id' }] });
    },
  });
  assert.deepEqual(result, { text: 'Fictional spoken text.', segments: [], language: 'id', model: 'gpt-transcribe', provider: 'openai' });
});

test('the diarizing model requests diarized_json with chunking and returns speaker segments', async () => {
  const result = await transcribe({
    connection: { provider: 'openai', apiKey: 'k' }, model: 'gpt-4o-transcribe-diarize', audio: AUDIO, vocabulary: ['x'], prompt: 'context',
    fetchImpl: async (_u, { body }) => {
      assert.deepEqual(fields(body), ['chunking_strategy', 'file', 'model', 'response_format']);
      assert.equal(body.get('response_format'), 'diarized_json');
      assert.equal(body.get('chunking_strategy'), 'auto');
      return Response.json({ text: 'Hi. Hello.', segments: [{ id: 'a', speaker: 'A', start: 0, end: 1.2, text: 'Hi.' }, { id: 'b', speaker: 'B', start: 1.2, end: 2, text: 'Hello.' }] });
    },
  });
  assert.deepEqual(result.segments, [{ start: 0, end: 1.2, text: 'Hi.', speaker: 'A' }, { start: 1.2, end: 2, text: 'Hello.', speaker: 'B' }]);
});

test('whisper-style providers send verbose_json segments, a 224-token-safe vocabulary prompt and language', async () => {
  for (const [provider, model, url] of [['groq', 'whisper-large-v3-turbo', 'https://api.groq.com/openai/v1/audio/transcriptions'], ['openai', 'whisper-1', 'https://api.openai.com/v1/audio/transcriptions'], ['custom', 'my-asr', 'https://asr.example/v1/audio/transcriptions']]) {
    const result = await transcribe({
      connection: { provider, apiKey: 'k', baseUrl: 'https://asr.example/v1' }, model, audio: AUDIO, language: 'en', vocabulary: Array.from({ length: 200 }, (_, i) => `term${i}`),
      fetchImpl: async (u, { body }) => {
        assert.equal(u, url);
        assert.equal(body.get('response_format'), 'verbose_json');
        assert.deepEqual(body.getAll('timestamp_granularities[]'), ['segment']);
        assert.equal(body.get('language'), 'en');
        assert.ok(body.get('prompt').startsWith('term0, term1') && body.get('prompt').length <= 800);
        return Response.json({ text: 'One. Two.', language: 'english', segments: [{ id: 0, start: 0, end: 1, text: ' One.' }, { id: 1, start: 1, end: 2, text: ' Two.' }] });
      },
    });
    assert.deepEqual(result.segments, [{ start: 0, end: 1, text: 'One.' }, { start: 1, end: 2, text: 'Two.' }]);
    assert.equal(result.language, 'english');
  }
  await transcribe({ connection: { provider: 'local' }, model: 'whisper', audio: AUDIO, fetchImpl: async (u, { headers, body }) => {
    assert.equal(u, 'http://127.0.0.1:11434/v1/audio/transcriptions');
    assert.equal(headers.Authorization, undefined);
    assert.equal(body.get('response_format'), 'verbose_json');
    assert.equal(body.get('timestamp_granularities[]'), null);
    return Response.json({ text: 'x' });
  } });
});

test('Mistral Voxtral sends diarize and context bias, and never language with timestamps', async () => {
  for (const language of [undefined, 'fr']) {
    const result = await transcribe({ connection: { provider: 'mistral', apiKey: 'k' }, model: 'voxtral-mini-latest', audio: AUDIO, language, diarize: true, vocabulary: ['metformin'], fetchImpl: async (_u, { body }) => {
      assert.equal(body.get('diarize'), 'true');
      assert.deepEqual(body.getAll('context_bias'), ['metformin']);
      assert.ok(!(body.get('language') && body.get('timestamp_granularities')));
      assert.equal(body.get('language'), language ?? null);
      return Response.json({ text: 'Bonjour.', language: 'fr', segments: [{ text: 'Bonjour.', start: 0, end: 1, speaker_id: 'speaker_1' }] });
    } });
    assert.deepEqual(result.segments, [{ start: 0, end: 1, text: 'Bonjour.', speaker: 'speaker_1' }]);
  }
});

test('Deepgram posts raw audio with Token auth and maps utterances', async () => {
  const result = await transcribe({ connection: { provider: 'deepgram', apiKey: 'k' }, model: 'nova-3-medical', audio: AUDIO, diarize: true, vocabulary: ['apixaban'], fetchImpl: async (url, { headers, body }) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://api.deepgram.com/v1/listen');
    assert.equal(parsed.searchParams.get('model'), 'nova-3-medical');
    assert.equal(parsed.searchParams.get('diarize'), 'true');
    assert.equal(parsed.searchParams.get('detect_language'), 'true');
    assert.deepEqual(parsed.searchParams.getAll('keyterm'), ['apixaban']);
    assert.equal(headers.Authorization, 'Token k');
    assert.equal(headers['Content-Type'], 'audio/webm');
    assert.equal(body, AUDIO);
    return Response.json({ results: { channels: [{ detected_language: 'en', alternatives: [{ transcript: 'Hi there.' }] }], utterances: [{ start: 0, end: 1, speaker: 0, transcript: 'Hi there.' }] } });
  } });
  assert.deepEqual(result, { text: 'Hi there.', segments: [{ start: 0, end: 1, text: 'Hi there.', speaker: '0' }], language: 'en', model: 'nova-3-medical', provider: 'deepgram' });
});

test('ElevenLabs Scribe groups words into speaker and sentence segments', async () => {
  const words = [
    { text: 'Hello.', start: 0, end: 0.5, type: 'word', speaker_id: 'speaker_0' }, { text: ' ', type: 'spacing', speaker_id: 'speaker_0' },
    { text: 'Hi', start: 0.6, end: 0.8, type: 'word', speaker_id: 'speaker_1' }, { text: ' ', type: 'spacing' }, { text: 'doctor.', start: 0.9, end: 1.2, type: 'word', speaker_id: 'speaker_1' },
    { text: '(cough)', start: 1.3, end: 1.4, type: 'audio_event' },
  ];
  const result = await transcribe({ connection: { provider: 'elevenlabs', apiKey: 'k' }, model: 'scribe_v2', audio: AUDIO, diarize: true, language: 'en', vocabulary: ['a', 'b'], fetchImpl: async (url, { headers, body }) => {
    assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.equal(headers['xi-api-key'], 'k');
    assert.equal(body.get('model_id'), 'scribe_v2');
    assert.equal(body.get('diarize'), 'true');
    assert.equal(body.get('language_code'), 'en');
    assert.deepEqual(body.getAll('keyterms'), ['a', 'b']);
    return Response.json({ text: 'Hello. Hi doctor.', language_code: 'eng', words });
  } });
  assert.deepEqual(result.segments, [{ start: 0, end: 0.5, text: 'Hello.', speaker: 'speaker_0' }, { start: 0.6, end: 1.2, text: 'Hi doctor.', speaker: 'speaker_1' }]);
});

test('Gemini transcribes inline audio with a verbatim instruction and vocabulary as spelling reference', async () => {
  const result = await transcribe({ connection: { provider: 'gemini', apiKey: 'k' }, model: 'gemini-3.8-flash', audio: new Blob(['ABC'], { type: 'audio/wav' }), language: 'id', vocabulary: ['amlodipin'], fetchImpl: async (url, o) => {
    assert.ok(url.endsWith('/models/gemini-3.8-flash:generateContent'));
    const body = JSON.parse(o.body);
    assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: 'audio/wav', data: btoa('ABC') } });
    assert.match(body.contents[0].parts[1].text, /verbatim/);
    assert.match(body.contents[0].parts[1].text, /"amlodipin"/);
    assert.equal(body.generationConfig.responseMimeType, undefined);
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Selamat pagi.' }] } }] });
  } });
  assert.deepEqual(result, { text: 'Selamat pagi.', segments: [], language: 'id', model: 'gemini-3.8-flash', provider: 'gemini' });
});

test('transcription validates inputs before any upload', async () => {
  const noFetch = async () => assert.fail('no upload');
  const cases = [
    [{ provider: 'anthropic', apiKey: 'k' }, { audio: AUDIO }, 'unsupported'],
    [{ provider: 'openai', apiKey: 'k' }, { audio: new Blob([]) }, 'invalid_input'],
    [{ provider: 'openai', apiKey: 'k' }, { audio: 'base64' }, 'invalid_input'],
    [{ provider: 'openai', apiKey: 'k' }, { audio: AUDIO, language: 'english' }, 'invalid_input'],
    [{ provider: 'openai', apiKey: 'k' }, { audio: AUDIO, vocabulary: 'a,b' }, 'invalid_input'],
    [{ provider: 'gemini', apiKey: 'k' }, { audio: new Blob([new Uint8Array(14_000_001)]) }, 'too_large'],
  ];
  for (const [connection, extra, code] of cases) await assert.rejects(transcribe({ connection, model: 'm', fetchImpl: noFetch, ...extra }), { code });
  await assert.rejects(transcribe({ connection: { provider: 'openai', apiKey: 'k' }, model: 'm', audio: AUDIO, fetchImpl: async () => Response.json({ text: 5 }) }), { code: 'invalid_response' });
});

test('segments merge in order with time offsets and per-segment speaker namespaces', () => {
  const merged = mergeTranscripts([
    { text: 'First.', segments: [{ start: 1, end: 2, text: 'First.', speaker: 'A' }], language: 'en' },
    { text: 'Second.', segments: [], language: null },
    { text: 'Third.', segments: [{ start: 0.5, end: 1, text: 'Third.', speaker: 'A' }], language: 'en' },
  ], [{ start: 0, end: 600 }, { start: 600, end: 1200 }, { start: 1200, end: 1500 }]);
  assert.equal(merged.text, 'First.\n\nSecond.\n\nThird.');
  assert.deepEqual(merged.segments, [
    { start: 1, end: 2, text: 'First.', speaker: '1:A' }, { start: 600, end: 1200, text: 'Second.' }, { start: 1200.5, end: 1201, text: 'Third.', speaker: '3:A' },
  ]);
  assert.equal(transcriptToText(merged, { timestamps: true, speakers: true }), '[00:00:01] Speaker 1:A: First.\n[00:10:00] Second.\n[00:20:00] Speaker 3:A: Third.');
  assert.equal(transcriptToText(merged), merged.text);
  const direct = mergeTranscripts([{ text: 'Whole file.', segments: [], language: null }], [{ start: 0, end: null }]);
  assert.deepEqual(direct.segments, [{ start: 0, end: null, text: 'Whole file.' }]);
});

test('segment uploads run with limited concurrency, retry transient failures and report progress', async () => {
  const segments = Array.from({ length: 5 }, (_, i) => ({ audio: new Blob([`seg${i}`], { type: 'audio/wav' }), start: i * 10, end: i * 10 + 10 }));
  let active = 0;
  let peak = 0;
  const attempts = {};
  const progress = [];
  const result = await transcribeSegments({
    connection: { provider: 'openai', apiKey: 'k' }, model: 'gpt-transcribe', segments, concurrency: 2, onProgress: p => progress.push(p.completed), sleep: async () => {},
    fetchImpl: async (_u, { body }) => {
      const name = await body.get('file').text();
      attempts[name] = (attempts[name] ?? 0) + 1;
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      if (name === 'seg2' && attempts[name] === 1) return new Response('', { status: 429 });
      if (name === 'seg3' && attempts[name] === 1) return new Response('', { status: 503 });
      return Response.json({ text: name });
    },
  });
  assert.equal(peak, 2);
  assert.equal(result.text, 'seg0\n\nseg1\n\nseg2\n\nseg3\n\nseg4');
  assert.deepEqual(progress, [1, 2, 3, 4, 5]);
  assert.deepEqual(attempts, { seg0: 1, seg1: 1, seg2: 2, seg3: 2, seg4: 1 });
});

test('a non-retryable failure or user abort stops the remaining uploads', async () => {
  const segments = Array.from({ length: 6 }, (_, i) => ({ audio: new Blob([`s${i}`]), start: i, end: i + 1 }));
  let calls = 0;
  await assert.rejects(transcribeSegments({ connection: { provider: 'openai', apiKey: 'k' }, model: 'm', segments, concurrency: 1, fetchImpl: async () => { calls++; return new Response('', { status: 401 }); } }), { code: 'auth' });
  assert.equal(calls, 1);
  const controller = new AbortController();
  const pending = transcribeSegments({ connection: { provider: 'openai', apiKey: 'k' }, model: 'm', segments, signal: controller.signal, fetchImpl: async (_u, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('x')))) });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, { code: 'aborted' });
});
