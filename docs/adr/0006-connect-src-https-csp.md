---
status: accepted
---

# A relaxed `connect-src` as the cost of bring-your-own-key, compensated by the rest of the CSP

## Context

With browser-direct mode ([ADR 0001](0001-browser-direct-byok.md)) the page must call whichever provider the user connects: ten presets plus any custom OpenAI-compatible HTTPS endpoint, and local servers on the user's machine. A `connect-src` allow-list of provider hosts would break custom endpoints and every new provider. But a page that holds API keys is exactly where a broad `connect-src` helps an attacker: injected script could send a key anywhere.

## Decision

The policy in `vercel.json` (also applied by `dev-server.js`) is:

```text
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self';
media-src 'self' blob:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*;
frame-src 'self' blob:; worker-src 'self'; object-src 'none'; frame-ancestors 'none';
base-uri 'none'; form-action 'self'
```

`connect-src` is relaxed to any HTTPS origin plus HTTP on loopback. Everything else is locked to the app's own origin, so the relaxed directive can only be used by code the app itself serves:

- `script-src 'self'` with no `'unsafe-inline'` or `'unsafe-eval'`: no inline scripts, no injected handlers, no third-party scripts.
- `style-src 'self'`: no inline styles; JavaScript changes visuals through classes and CSS custom properties only.
- `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`: no plugins, no base-URL hijacking, no form posts elsewhere, no framing.
- `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin`, and a `Permissions-Policy` that allows only the microphone, for this origin.

The engine also refuses non-HTTPS endpoints except loopback, endpoints containing credentials or query strings, and HTTP redirects, and it never logs or echoes keys.

## Consequences

- Any HTTPS provider or custom endpoint works without changing the CSP.
- The protection of keys rests on keeping script execution limited to the app's own files. Any change that adds inline script, a third-party script or `'unsafe-*'` would turn the broad `connect-src` into an exfiltration path, and must be rejected.
- `media-src` and `frame-src` allow `blob:` for locally created media such as recordings, and for printing the export from a Blob URL.
- `validateBaseUrl()` accepts `[::1]`, but the CSP lists only `localhost` and `127.0.0.1`, so IPv6 loopback endpoints are blocked by the browser in browser-direct mode.
- Hosts other than Vercel must reproduce these headers themselves.

## Alternatives rejected

- **An allow-list of provider hosts.** Breaks custom endpoints and needs a deployment for every new provider.
- **A proxy so that `connect-src 'self'` suffices.** That is server mode; making it mandatory would send all content through the host.
- **No CSP.** Leaves keys exposed to any injection.
