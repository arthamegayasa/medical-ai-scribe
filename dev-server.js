// Local development server. Vercel serves public/ (built from web/) and the handlers in api/.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHandlers } from './lib/handlers.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
// vercel.json is the single source of the production security headers.
const SECURITY_HEADERS = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')).headers[0].headers;

export function loadLocalEnv(path = resolve(ROOT, '.env'), env = process.env) {
  if (!existsSync(path)) return;
  // Simple KEY=value files only: no shell execution, interpolation or multiline values.
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(env, match[1])) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    env[match[1]] = value;
  }
}

/** Maps a URL path to a file under webRoot, or null for anything outside the public site. */
function publicPath(webRoot, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (!/^\/[A-Za-z0-9_./-]*$/.test(decoded)) return null;
  const segments = decoded.split('/').filter(Boolean);
  // Dot segments cover "..", dotfiles and .env; Markdown and tests are never published.
  if (segments.some(segment => segment.startsWith('.')) || /\.md$|\.test\.js$/i.test(decoded)) return null;
  const path = resolve(webRoot, ...segments);
  return path === webRoot || path.startsWith(webRoot + sep) ? path : null;
}

export function makeServer({ webRoot = resolve(ROOT, 'web'), ...options } = {}) {
  const handlers = createHandlers(options);
  const routes = { '/api/config': handlers.config, '/api/generate-soap': handlers.generateSoap, '/api/label-speakers': handlers.labelSpeakers, '/api/process-audio': handlers.processAudio };
  const root = resolve(webRoot);
  return createServer(async (req, res) => {
    res.status = code => { res.statusCode = code; return res; };
    res.json = data => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); return res; };
    res.setHeader('Cache-Control', 'no-store');
    for (const { key, value } of SECURITY_HEADERS) res.setHeader(key, value);
    const notFound = () => res.status(404).json({ error: 'Not found.', code: 'not_found' });
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (routes[pathname]) return await routes[pathname](req, res);
      if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.', code: 'method_not_allowed' });
      let path = publicPath(root, pathname);
      if (!path) return notFound();
      if ((await stat(path)).isDirectory()) {
        if (!pathname.endsWith('/')) {
          res.statusCode = 308;
          res.setHeader('Location', `${pathname}/`);
          return res.end();
        }
        path = resolve(path, 'index.html');
      }
      // Symbolic links must not lead outside the site root.
      const real = await realpath(path);
      const realRoot = await realpath(root);
      const type = TYPES[extname(real).toLowerCase()];
      if (!type || !real.startsWith(realRoot + sep)) return notFound();
      const data = await readFile(real);
      res.setHeader('Content-Type', type);
      res.statusCode = 200;
      return res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      return notFound();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadLocalEnv();
  const port = Number(process.env.PORT || 3000);
  // Development binds to loopback. Configure a protected reverse proxy for shared hosting.
  makeServer().listen(port, '127.0.0.1', () => console.log(`Medical AI Scribe is ready at http://127.0.0.1:${port}`));
}
