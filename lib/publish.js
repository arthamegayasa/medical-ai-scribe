// What may be published from web/. Shared by the production build (lib/build.js) and the local
// development server (dev-server.js), so both keep exactly the same files private.

const segmentsOf = (relativePath) => String(relativePath).split(/[\\/]+/).filter(Boolean);

/**
 * Never published or served: dotfiles and dot-directories (.env, .git), Markdown and tests.
 * @param {string} relativePath a path relative to web/, with either separator
 */
export function isPrivatePath(relativePath) {
  const segments = segmentsOf(relativePath);
  const name = segments.at(-1) || '';
  return segments.some((segment) => segment.startsWith('.')) || /\.md$/i.test(name) || /\.test\.js$/i.test(name);
}

// Served by the local development server but left out of the production build. The design-review
// harness (/app/?demo=...) renders fictional UI states and is not needed by the published app.
const DEV_ONLY = new Set(['assets/js/demo-states.js']);

export function isDevOnly(relativePath) {
  return DEV_ONLY.has(segmentsOf(relativePath).join('/'));
}

/** The security headers for every path: the vercel.json entry whose source is the catch-all. */
export function securityHeaders(vercelConfig) {
  const entry = (vercelConfig?.headers || []).find((item) => item.source === '/(.*)');
  if (!entry || !Array.isArray(entry.headers)) throw new Error('vercel.json needs a catch-all ("/(.*)") headers entry with the security headers.');
  return entry.headers;
}
