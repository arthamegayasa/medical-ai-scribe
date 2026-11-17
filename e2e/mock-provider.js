// A local OpenAI-compatible provider for end-to-end tests: /v1/models, /v1/chat/completions
// (JSON schema output, SSE streaming) and /v1/audio/transcriptions, with CORS for the browser.
// Behaviour is chosen by model ID so error paths can be exercised deterministically.
import { createServer } from 'node:http';

const ND = { en: 'Not documented in this encounter.', id: 'Tidak didokumentasikan dalam pertemuan ini.' };
export const MOCK_MODELS = ['mock-note-pro', 'mock-note-mini', 'mock-malformed', 'mock-slow', 'mock-ratelimit', 'whisper-mock', 'whisper-flaky', 'text-embedding-mock'];
export const RECORDING_TEXT = 'Good morning, what brings you in today? I have had a cough for five days and a mild fever. Any shortness of breath? No, just tired in the evenings. Your chest sounds clear today. Let us try rest and fluids and review in one week.';

const sentences = (text) => text.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
const quote = (sentence) => sentence.replace(/[.?!]+$/, '');

function transcriptFrom(messages) {
  const user = messages.find((m) => m.role === 'user')?.content || '';
  const match = /\(JSON string\):\n([\s\S]*)$/.exec(user);
  if (!match) return '';
  try { return JSON.parse(match[1].trim()); } catch { return ''; }
}

function buildNote(transcript, language) {
  const lines = transcript.split('\n').map((line) => {
    const m = /^(Doctor|Patient|Other):\s*(.*)$/.exec(line);
    return { who: m ? m[1] : 'Unknown', text: m ? m[2] : line };
  });
  const patient = lines.filter((l) => l.who !== 'Doctor').flatMap((l) => sentences(l.text));
  const doctor = lines.filter((l) => l.who === 'Doctor').flatMap((l) => sentences(l.text));
  const all = lines.flatMap((l) => sentences(l.text));
  const nd = [{ text: ND[language] || ND.en, evidence: [] }];
  const statement = (prefix, s) => ({ text: `${prefix}${quote(s)}.`, evidence: [quote(s)] });
  const first = patient[0] || all[0];
  return {
    chief_complaint: [statement(language === 'id' ? 'Keluhan: ' : 'Reports: ', first)],
    subjective: [
      ...patient.slice(1, 3).map((s) => statement('', s)),
      { text: language === 'id' ? 'Minum obat rahasia 500 mg.' : 'Takes an unnamed drug 500 mg.', evidence: ['the patient takes a secret drug'] },
    ],
    objective: doctor.length > 2 ? [statement('', doctor[doctor.length - 2])] : nd,
    assessment: nd,
    plan: doctor.length ? [statement('', doctor[doctor.length - 1])] : nd,
    review_flags: [{ type: 'unclear', text: language === 'id' ? 'Durasi keluhan perlu dipastikan.' : 'Confirm how long the symptoms have lasted.', evidence: [quote(first).split(' ').slice(0, 4).join(' ')] }],
  };
}

function labelTurns(chunk) {
  return { turns: sentences(chunk).map((text, i) => ({ speaker: i % 2 === 0 ? 'Doctor' : 'Patient', text })) };
}

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!boundary) return { fields: {}, files: {} };
  const marker = Buffer.from(`--${boundary[1] || boundary[2]}`);
  const fields = {};
  const files = {};
  let start = buffer.indexOf(marker);
  while (start !== -1) {
    const next = buffer.indexOf(marker, start + marker.length);
    if (next === -1) break;
    const part = buffer.subarray(start + marker.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString('utf8');
    const body = part.subarray(split + 4);
    const name = /name="([^"]+)"/.exec(head)?.[1];
    if (name) {
      if (/filename="/.test(head)) files[name] = body;
      else (fields[name] ||= []).push(body.toString('utf8'));
    }
    start = next;
  }
  return { fields, files };
}

function wavSeconds(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  const rate = buffer.readUInt32LE(24);
  const bytesPerSample = buffer.readUInt16LE(34) / 8;
  return (buffer.length - 44) / (rate * bytesPerSample);
}

export function startMockProvider({ port = 0 } = {}) {
  const stats = { models: 0, chat: [], transcriptions: [], aborted: 0, flakyFailed: false };
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

    if (url.pathname === '/__stats') return json(200, stats);
    if (url.pathname === '/__reset') { stats.models = 0; stats.chat = []; stats.transcriptions = []; stats.aborted = 0; stats.flakyFailed = false; return json(200, { ok: true }); }

    const auth = req.headers.authorization || '';
    if (!/^Bearer mock-/.test(auth)) return json(401, { error: { message: 'Incorrect API key provided: secret-should-never-be-shown', type: 'invalid_request_error' } });

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      stats.models += 1;
      return json(200, { object: 'list', data: MOCK_MODELS.map((id) => ({ id, object: 'model', context_window: 128000 })) });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const request = JSON.parse(body.toString('utf8'));
      const kind = request.response_format?.json_schema?.name || request.response_format?.type || 'prompt';
      const system = request.messages.find((m) => m.role === 'system')?.content || '';
      const language = /Write statement and flag text in Bahasa Indonesia/.test(system) ? 'id' : 'en';
      stats.chat.push({ model: request.model, kind, stream: Boolean(request.stream) });
      if (request.model === 'mock-ratelimit') return json(429, { error: { message: 'Rate limit reached', type: 'rate_limit_exceeded' } }, { 'Retry-After': '7' });
      const transcript = transcriptFrom(request.messages);
      let content;
      if (request.model === 'mock-malformed') content = 'Here is the note you asked for: {"chief_complaint": [oops';
      else if (kind === 'speaker_turns') content = JSON.stringify(labelTurns(transcript));
      else if (kind === 'soap_section') {
        const plan = sentences(transcript.split('\n').map((l) => l.replace(/^(Doctor|Patient|Other):\s*/, '')).join(' ')).at(-1) || transcript;
        content = JSON.stringify({ items: [{ text: `Rewritten: ${quote(plan)}.`, evidence: [quote(plan)] }] });
      } else content = JSON.stringify(buildNote(transcript, language));

      if (!request.stream) return json(200, { id: 'mock', object: 'chat.completion', model: request.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const slow = request.model === 'mock-slow';
      const step = slow ? 12 : 40;
      let closed = false;
      res.on('close', () => { if (!res.writableEnded) { closed = true; stats.aborted += 1; } });
      for (let i = 0; i < content.length && !closed; i += step) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: content.slice(i, i + step) }, finish_reason: null }] })}\n\n`);
        await new Promise((r) => setTimeout(r, slow ? 120 : 12));
      }
      if (closed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
      const { fields, files } = parseMultipart(body, req.headers['content-type']);
      const model = fields.model?.[0];
      const file = files.file || Buffer.alloc(0);
      const seconds = wavSeconds(file);
      const entry = { model, bytes: file.length, seconds, prompt: fields.prompt?.[0] || '', language: fields.language?.[0] || null, format: fields.response_format?.[0] };
      stats.transcriptions.push(entry);
      if (model === 'whisper-flaky' && !stats.flakyFailed && seconds !== null && seconds < 200) {
        stats.flakyFailed = true;
        return json(400, { error: { message: 'Simulated failure for this segment' } });
      }
      if (!file.length) return json(400, { error: { message: 'No file' } });
      let text;
      if (seconds !== null && seconds > 30) text = `This part of the recording lasted ${Math.round(seconds)} seconds. The patient reports knee pain for two weeks.`;
      else text = RECORDING_TEXT;
      const parts = sentences(text);
      const span = (seconds || 12) / parts.length;
      return json(200, { text, language: 'en', duration: seconds || 12, segments: parts.map((t, i) => ({ id: i, start: +(i * span).toFixed(2), end: +((i + 1) * span).toFixed(2), text: ` ${t}` })) });
    }
    return json(404, { error: { message: 'Not found' } });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({ url: `http://127.0.0.1:${actual}/v1`, origin: `http://127.0.0.1:${actual}`, stats, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}
