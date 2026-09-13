// Local development server. Vercel deploys the individual handlers in api/.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHandlers } from './lib/handlers.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

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

export function makeServer(options = {}) {
  const handlers = createHandlers(options);
  const routes = { '/api/config': handlers.config, '/api/generate-soap': handlers.generateSoap, '/api/process-audio': handlers.processAudio };
  return createServer(async (req, res) => {
    res.status = code => { res.statusCode = code; return res; };
    res.json = data => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); return res; };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (routes[pathname]) return await routes[pathname](req, res);
      if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.', code: 'method_not_allowed' });
      // Serve only the page and frontend assets, never source, .env, or repository files.
      const relative = pathname === '/' || pathname === '/index.html' ? 'index.html'
        : /^\/(?:assets|docs)\/[A-Za-z0-9_./-]+$/.test(pathname) ? pathname.slice(1) : null;
      const path = relative && resolve(ROOT, relative);
      const type = path && TYPES[extname(path)];
      const isAsset = path && path.startsWith(resolve(ROOT, 'assets') + sep);
      const isDocImage = path && path.startsWith(resolve(ROOT, 'docs') + sep) && type?.startsWith('image/');
      if (!path || !path.startsWith(ROOT + sep) || !type || (relative !== 'index.html' && !isAsset && !isDocImage)) {
        return res.status(404).json({ error: 'Not found.', code: 'not_found' });
      }
      const data = await readFile(path);
      res.setHeader('Content-Type', type);
      res.statusCode = 200;
      return res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      return res.status(404).json({ error: 'Not found.', code: 'not_found' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadLocalEnv();
  const port = Number(process.env.PORT || 3000);
  // Development binds to loopback. Configure a protected reverse proxy for shared hosting.
  makeServer().listen(port, '127.0.0.1', () => console.log(`Medical AI Scribe is ready at http://127.0.0.1:${port}`));
}
