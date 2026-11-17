# Self-hosting

Medical AI Scribe can run anywhere that serves static files. Server mode, where the deployment holds provider keys, additionally needs Node.js 20+ or Vercel functions.

- [Choose a mode](#choose-a-mode)
- [Vercel](#vercel)
- [Any static host (browser-direct only)](#any-static-host-browser-direct-only)
- [Any Node host](#any-node-host)
- [Configuring server mode](#configuring-server-mode)
- [Before you share a deployment](#before-you-share-a-deployment)
- [Updating](#updating)

## Choose a mode

| | Browser-direct (default) | Server mode |
| --- | --- | --- |
| Who supplies provider keys | Each user, in their browser | The deployer, in environment variables |
| What the host sees | App files only | Audio and text relayed to the provider |
| Needs | Static files and the security headers | Node.js or Vercel functions, `SCRIBE_ACCESS_TOKEN` |
| Streaming of the draft | Yes, where the provider supports it | No |
| Audio per request | Provider limit (14–100 MB) | 3 MB, segmented in the browser |
| Custom endpoint without CORS | Does not work | Works |

Both modes run the same engine and produce the same drafts; evidence checks and exports happen in the browser either way. See [ADR 0001](adr/0001-browser-direct-byok.md) for the reasoning.

## Vercel

1. Fork or import <https://github.com/arthamegayasa/medical-ai-scribe> into a Vercel project. No framework preset is needed; `vercel.json` sets:
   - `buildCommand: npm run build` and `outputDirectory: public`;
   - the security headers, including the Content-Security-Policy, for every path;
   - the functions `api/config.js`, `api/generate-soap.js`, `api/label-speakers.js` and `api/process-audio.js`, each with `maxDuration: 300`. Your Vercel plan must allow that duration.
2. Deploy. With no environment variables, the deployment works in browser-direct mode and the fictional example works.
3. For server mode, add the variables described [below](#configuring-server-mode) under **Settings → Environment Variables**, then redeploy. On Vercel the AI endpoints refuse every request until `SCRIBE_ACCESS_TOKEN` is set.

`.vercelignore` keeps documentation, tests, `dev-server.js` and local `.env` files out of the deployment.

## Any static host (browser-direct only)

```bash
npm ci
npm run build      # writes public/
```

Publish the contents of `public/` at the root of a domain (paths are absolute, such as `/assets/...` and `/app/`). Serve it over HTTPS, since browsers allow microphone recording only on secure origins.

Configure the host to send the same headers as `vercel.json` on every response:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; media-src 'self' blob:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-src 'self' blob:; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: camera=(), geolocation=(), microphone=(self)
```

Copy them from `vercel.json` rather than from this page if the two ever differ; `vercel.json` is the source of truth. Also redirect `/app` to `/app/`. There are no `/api/*` endpoints on a static host, so server mode is unavailable.

## Any Node host

`npm start` (the same script as `npm run dev`) serves `web/` and the `/api/*` routes with the headers from `vercel.json`. It has no dependencies to install beyond Node.js itself.

```bash
git clone https://github.com/arthamegayasa/medical-ai-scribe.git
cd medical-ai-scribe
npm ci
cp .env.example .env    # PowerShell: Copy-Item .env.example .env
# edit .env, then:
NODE_ENV=production PORT=3000 npm start
```

On PowerShell, set the variables first: `$env:NODE_ENV = 'production'; $env:PORT = '3000'; npm start`.

Things to know:

- The server **binds to `127.0.0.1` only**. Put a reverse proxy on the same machine in front of it to terminate TLS. The proxy must pass the original `Host` header, because the API rejects requests whose `Origin` does not match the host.
- It reads simple `KEY=value` lines from `.env` in the project root. Variables already set in the environment take precedence; there is no interpolation or shell execution.
- With `NODE_ENV=production`, the AI endpoints require `SCRIBE_ACCESS_TOKEN`, exactly as on Vercel. Setting the token also enforces it without `NODE_ENV`.
- Every response is sent with `Cache-Control: no-store`.
- Use a process manager (systemd, a container restart policy or similar) to keep it running.

A minimal [Caddy](https://caddyserver.com/) configuration, which obtains a certificate and preserves `Host` by default:

```text
scribe.example.org {
  reverse_proxy 127.0.0.1:3000
}
```

With nginx, include `proxy_set_header Host $host;` in the `location` block, and raise `client_max_body_size` to at least 5 MB for audio requests.

## Configuring server mode

Set at least one note provider and the access token. The full list is in the [configuration reference](../README.md#configuration-reference) and in [`.env.example`](../.env.example).

```dotenv
# Note writing and speaker labelling (any of these)
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-sonnet-5-5   # optional; this is also the default

# Transcription: OpenAI by default, using OPENAI_API_KEY
OPENAI_API_KEY=...
# or another provider:
# TRANSCRIPTION_PROVIDER=deepgram
# DEEPGRAM_API_KEY=...

# Required on Vercel and with NODE_ENV=production
SCRIBE_ACCESS_TOKEN=<long random secret>
```

Generate a token with, for example, `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Give it to your users through a private channel; they enter it in the app under **Settings → Workspace access**.

**A self-hosted model as the note model.** Point `COMPATIBLE_BASE_URL` at any OpenAI Chat Completions-compatible server, including `/v1`. HTTPS is required except for `localhost`, `127.0.0.1` and `[::1]`, and a loopback address refers to the machine running the app server, not to the user's computer. Because the server makes the call, the model server does not need CORS.

**A self-hosted transcription server.** Set `TRANSCRIPTION_BASE_URL` to a server that implements the OpenAI `POST /audio/transcriptions` API. It receives only `TRANSCRIPTION_API_KEY`, never another provider's key.

The browser can learn which providers are configured, their default model IDs and the limits from `/api/config`. It never receives keys or endpoint URLs.

## Before you share a deployment

- [ ] Served over HTTPS, with the headers from `vercel.json`.
- [ ] `SCRIBE_ACCESS_TOKEN` is long, random and shared only with intended users. It is one shared secret, not per-user identity or an audit trail.
- [ ] Spending limits are set in each provider account the server uses.
- [ ] You have read each provider's data-processing and retention terms and have the agreements your setting requires.
- [ ] You know what your hosting platform and reverse proxy log. The app does not log content, but platforms log requests.
- [ ] Users know to obtain consent before recording and to treat every draft as requiring review.
- [ ] Your institution and local regulations permit this use.

This project makes no compliance claim and is not a medical device; meeting these obligations rests with the deployer.

## Updating

```bash
git pull
npm ci
npm run check && npm test && npm run build
```

Then restart the Node process, or let Vercel redeploy from your repository. Read the commit history for changes to `vercel.json` or `.env.example`.
