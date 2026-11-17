---
status: accepted
---

# Browser-direct bring-your-own-key, with an optional server mode

## Context

The app handles consultation audio, transcripts and notes, and needs paid AI models to transcribe and draft. A public deployment that relays this content through its own server would see clinical data and pay for every request, and every self-hoster would inherit that position. Users differ: some have their own provider accounts, some run local models, and some organisations want to hold keys centrally for a team.

## Decision

The default mode is **browser-direct**: the user enters their own provider key in the browser, and the engine in `web/core/` calls the provider directly from the page. The site's host serves static files only and never receives keys, audio, transcripts or notes.

For self-hosters, an optional **server mode** keeps provider keys in environment variables. The browser calls the same engine through `/api/*` (`lib/handlers.js`), gated by `SCRIBE_ACCESS_TOKEN`, which is mandatory on Vercel and under `NODE_ENV=production`. The server never lets the browser choose an endpoint and returns only availability and defaults from `/api/config`, never keys or URLs.

Both modes share one engine and return the same result shapes, so evidence verification and exports run in the browser either way.

## Consequences

- The public deployment holds no clinical data and incurs no model cost; users pay their provider directly.
- Each provider must allow cross-origin requests for browser-direct use. Providers or endpoints that do not (Deepgram's model listing, many custom servers) lose features or must use server mode. Presets record a verified `browser` value.
- The CSP must allow connections to any HTTPS origin ([ADR 0006](0006-connect-src-https-csp.md)).
- The user's key lives in the browser, so key storage must default to the safest option ([ADR 0005](0005-opt-in-history-session-keys.md)).
- Anthropic requires the `anthropic-dangerous-direct-browser-access` header for browser calls; the engine sends it deliberately.
- Server mode is limited by serverless request sizes (3 MB of audio per request) and does not stream.

## Alternatives rejected

- **Server relay only.** Simpler CORS story, but the host sees all clinical content and pays for all usage.
- **Browser-direct only.** Would leave organisations that cannot hand keys to individual users without an option, and would rule out custom endpoints that do not support CORS.
- **Accounts with server-stored keys.** Adds identity, storage and a database holding credentials, all of which the project otherwise avoids.
