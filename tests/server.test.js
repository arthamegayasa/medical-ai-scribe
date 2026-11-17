import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServer } from '../dev-server.js';
import { buildSite } from '../lib/build.js';
import { NOTE, openaiReply } from './fixtures.js';

const VERCEL = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));

async function fixtureSite(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scribe-web-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = {
    'index.html': '<!doctype html><title>Landing</title>', 'app/index.html': '<!doctype html><title>Workspace</title>',
    'core/index.js': 'export const engine = true;', 'core/README.md': '# private notes', 'core/x.test.js': 'test', 'assets/site.css': 'body{}',
    'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', '.env': 'SECRET=1', 'core/data.bin': 'raw',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

async function start(t, options) {
  const server = makeServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('local server serves the web/ site with directory indexes and production security headers', async t => {
  const webRoot = await fixtureSite(t);
  const base = await start(t, { webRoot, env: {}, fetchImpl: async () => assert.fail('No provider request expected.') });
  const landing = await fetch(base);
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get('content-type'), /text\/html/);
  assert.match(await landing.text(), /Landing/);
  const csp = VERCEL.headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
  assert.equal(landing.headers.get('content-security-policy'), csp);
  assert.equal(landing.headers.get('permissions-policy'), 'camera=(), geolocation=(), microphone=(self)');
  assert.equal(landing.headers.get('cache-control'), 'no-store');
  assert.match(await (await fetch(`${base}/app/`)).text(), /Workspace/);
  const redirect = await fetch(`${base}/app`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/app/');
  for (const [path, contentType] of [['/core/index.js', 'text/javascript'], ['/assets/site.css', 'text/css'], ['/assets/logo.svg', 'image/svg+xml']]) {
    const asset = await fetch(base + path);
    assert.equal(asset.status, 200, path);
    assert.ok(asset.headers.get('content-type').startsWith(contentType), path);
    const head = await fetch(base + path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
});

test('local server keeps repository, dot, documentation and traversal paths private', async t => {
  const webRoot = await fixtureSite(t);
  await symlink(join(webRoot, '..'), join(webRoot, 'escape'), 'junction').catch(() => {});
  const base = await start(t, { webRoot, env: {} });
  for (const path of [
    '/.env', '/core/README.md', '/core/x.test.js', '/core/data.bin', '/package.json', '/dev-server.js', '/lib/config.js', '/api/generate-soap.js',
    '/tests/api.test.js', '/README.md', '/.git/config', '/assets/../../package.json', '/assets/%2e%2e/%2e%2e/package.json', '/assets/%2e%2e%2f%2e%2e%2fpackage.json',
    '/core/..%5c..%5cpackage.json', '/%00', '/missing.html', '/escape/', '/escape/package.json',
  ]) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(`${base}/index.html`, { method: 'POST' })).status, 405);
});

test('local server routes the same-origin API', async t => {
  const base = await start(t, { webRoot: await fixtureSite(t), env: {}, fetchImpl: async () => assert.fail('No provider request expected.') });
  const config = await fetch(base + '/api/config').then(r => r.json());
  assert.equal(config.providers.length, 7);
  assert.ok(config.providers.every(p => !p.configured));
  const invalidJson = await fetch(base + '/api/generate-soap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).code, 'invalid_json');
  const missingProvider = await fetch(base + '/api/generate-soap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript: 'A fictional testing transcript.', provider: 'openai' }) });
  assert.equal(missingProvider.status, 503);
  const oversized = await fetch(base + '/api/generate-soap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript: 'x'.repeat(2_200_000), provider: 'openai' }) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, 'payload_too_large');
  assert.equal((await fetch(base + '/api/label-speakers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
});

test('authenticated HTTP flow transcribes audio then creates a validated draft through a mocked provider', async t => {
  let audioCalls = 0;
  let draftCalls = 0;
  const base = await start(t, {
    webRoot: await fixtureSite(t),
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
      return openaiReply(NOTE);
    },
  });
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test-app-token', Origin: base };
  const body = { audio: Buffer.from('Fictional recording bytes').toString('base64'), mimeType: 'audio/webm', language: 'auto' };

  const unauthorized = await fetch(base + '/api/process-audio', { method: 'POST', headers: { ...headers, Authorization: 'Bearer incorrect' }, body: JSON.stringify(body) });
  assert.equal(unauthorized.status, 401);
  const crossOrigin = await fetch(base + '/api/process-audio', { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: JSON.stringify(body) });
  assert.equal(crossOrigin.status, 403);
  assert.equal(audioCalls, 0);

  const audioResponse = await fetch(base + '/api/process-audio', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(audioResponse.status, 200);
  assert.equal(audioResponse.headers.get('cache-control'), 'no-store');
  const audio = await audioResponse.json();
  assert.equal(audio.text, 'Synthetic source transcript.');
  assert.equal(audio.note, undefined);

  const draftResponse = await fetch(base + '/api/generate-soap', { method: 'POST', headers, body: JSON.stringify({ transcript: audio.text, provider: 'openai', language: 'en' }) });
  assert.equal(draftResponse.status, 200);
  assert.equal(draftResponse.headers.get('access-control-allow-origin'), null);
  const draft = await draftResponse.json();
  assert.deepEqual(draft.note, NOTE);
  assert.equal(draft.meta.model, 'test-default-model');
  assert.equal(audioCalls, 1);
  assert.equal(draftCalls, 1);
  assert.ok(!JSON.stringify(draft).includes('test-provider-key'));
});

test('build copies web/ recursively into a clean output, skipping docs, tests and dotfiles', async t => {
  const source = await fixtureSite(t);
  const output = join(source, '..', `${source.split(/[\\/]/).pop()}-public`);
  t.after(() => rm(output, { recursive: true, force: true }));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'stale.html'), 'old');
  const count = await buildSite({ source, output });
  const list = async (dir, prefix = '') => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(e => (e.isDirectory() ? list(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`])))).flat();
  const files = (await list(output)).sort();
  assert.deepEqual(files, ['app/index.html', 'assets/logo.svg', 'assets/site.css', 'core/data.bin', 'core/index.js', 'index.html']);
  assert.equal(count, files.length);
  await assert.rejects(buildSite({ source: join(source, 'missing'), output }), /web\/ directory is missing/);
});
