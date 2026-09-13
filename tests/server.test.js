import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeServer } from '../dev-server.js';

test('local server serves the application and same-origin API while keeping server files private', async t => {
  const server = makeServer({ env: {}, fetchImpl: async () => { assert.fail('No provider request expected.'); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  for (const path of ['/.env', '/.env.example', '/package.json', '/dev-server.js', '/lib/config.js', '/api/generate-soap.js', '/tests/api.test.js', '/README.md', '/.github/workflows/checks.yml', '/.git/config', '/assets/../dev-server.js', '/assets/%2e%2e/.env', '/assets/%2e%2e%2flib/config.js', '/docs/../package.json']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  for (const [path, contentType] of [['/assets/app.js', 'text/javascript'], ['/assets/styles.css', 'text/css'], ['/docs/banner.svg', 'image/svg+xml']]) {
    const asset = await fetch(base + path);
    assert.equal(asset.status, 200, path);
    assert.ok(asset.headers.get('content-type').startsWith(contentType), path);
    assert.ok((await asset.text()).length > 0, path);
    const head = await fetch(base + path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  const config = await fetch(base + '/api/config').then(r => r.json());
  assert.equal(config.providers.length, 5);
  assert.ok(config.providers.every(p => !p.configured));
  const invalidJson = await fetch(base + '/api/generate-soap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).code, 'invalid_json');
  const missingProvider = await fetch(base + '/api/generate-soap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript: 'A fictional testing transcript.', provider: 'openai' }) });
  assert.equal(missingProvider.status, 503);
  const oversized = await fetch(base + '/api/generate-soap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript: 'x'.repeat(150000), provider: 'openai' }) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, 'payload_too_large');
});

test('authenticated HTTP flow transcribes audio then creates a validated draft through a mocked provider', async t => {
  const soap = {
    chief_complaint: 'Fictional documentation test.',
    subjective: 'Synthetic source transcript.',
    objective: 'Not documented in this encounter.',
    assessment: 'Not documented in this encounter.',
    plan: 'Not documented in this encounter.',
  };
  let audioCalls = 0;
  let draftCalls = 0;
  const server = makeServer({
    env: { NODE_ENV: 'production', SCRIBE_ACCESS_TOKEN: 'test-app-token', OPENAI_API_KEY: 'test-provider-key', OPENAI_MODEL: 'test-default-model' },
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer test-provider-key');
      if (url.endsWith('/audio/transcriptions')) {
        audioCalls++;
        assert.ok(options.body instanceof FormData);
        assert.equal(await options.body.get('file').text(), 'Fictional recording bytes');
        return Response.json({ text: 'Synthetic source transcript.' });
      }
      assert.equal(url, 'https://api.openai.com/v1/chat/completions');
      draftCalls++;
      const request = JSON.parse(options.body);
      assert.equal(request.model, 'test-default-model');
      assert.ok(request.messages[1].content.includes('Synthetic source transcript.'));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(soap) } }] });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test-app-token', Origin: base };
  const body = { audio: Buffer.from('Fictional recording bytes').toString('base64'), mimeType: 'audio/webm', language: 'auto' };

  const unauthorized = await fetch(base + '/api/process-audio', { method: 'POST', headers: { ...headers, Authorization: 'Bearer incorrect' }, body: JSON.stringify(body) });
  assert.equal(unauthorized.status, 401);
  assert.equal(audioCalls, 0);
  const crossOrigin = await fetch(base + '/api/process-audio', { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: JSON.stringify(body) });
  assert.equal(crossOrigin.status, 403);
  assert.equal(audioCalls, 0);

  const audioResponse = await fetch(base + '/api/process-audio', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(audioResponse.status, 200);
  assert.equal(audioResponse.headers.get('cache-control'), 'no-store');
  const audio = await audioResponse.json();
  assert.equal(audio.raw_transcript, 'Synthetic source transcript.');
  assert.equal(audio.soap, undefined);

  const draftResponse = await fetch(base + '/api/generate-soap', { method: 'POST', headers, body: JSON.stringify({ transcript: audio.raw_transcript, provider: 'openai', language: 'en' }) });
  assert.equal(draftResponse.status, 200);
  assert.equal(draftResponse.headers.get('access-control-allow-origin'), null);
  const draft = await draftResponse.json();
  assert.deepEqual(draft, { soap, provider: 'openai', model: 'test-default-model', language: 'en', draft: true });
  assert.equal(audioCalls, 1);
  assert.equal(draftCalls, 1);
  assert.ok(!JSON.stringify(draft).includes('test-provider-key'));
});
