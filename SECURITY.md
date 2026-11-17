# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, or go directly to
<https://github.com/arthamegayasa/medical-ai-scribe/security/advisories/new>.

Do not open a public issue, pull request or discussion for a suspected vulnerability. Include what you found, how to reproduce it, and the impact you expect. Never include real patient data or working credentials; use fictional content and revoked or test keys.

This is a small independent project maintained by one person. You can expect an acknowledgement, an assessment, and coordination on a fix and disclosure timeline through the advisory. Reporters are credited in the advisory unless they prefer otherwise.

## Supported versions

Security fixes are made on the `main` branch and deployed to <https://medicalaiscribe.vercel.app>. Self-hosters should update from `main`.

## Scope

In scope:

- The code in this repository: the browser engine (`web/core/`), the workspace and landing pages (`web/`), the server-mode handlers (`lib/`, `api/`), `dev-server.js` and the security headers in `vercel.json`.
- The hosted deployment at `medicalaiscribe.vercel.app`, as far as it runs this code.

Examples of what we want to hear about:

- Any way for a key, audio, transcript or note to reach a party other than the provider the user chose (including the app's own host in browser-direct mode).
- Cross-site scripting, CSP bypasses, or injection through transcripts, model output, exports or file names.
- Ways around the server-mode access token, the same-origin check or the request size limits.
- Server-mode errors or logs that expose provider credentials, provider response bodies or clinical content.
- Path traversal or file disclosure in `dev-server.js` or the build script.
- Exports that drop the draft label or the unverified and check-number markers.

## Threat model in brief

**Browser-direct mode (default).** The host serves static files only. The browser sends keys, audio and text over HTTPS directly to the provider the user configured. The host cannot see keys, audio, transcripts or notes. It can, like any web host, change the code it serves; users who need to remove that trust should self-host a reviewed copy.

**Server mode.** Provider keys are read from the deployment's environment and are never sent to the browser; `/api/config` returns only which providers are configured, default model IDs and limits. The costly endpoints require a `Bearer` workspace access token (compared in constant time) whenever `SCRIBE_ACCESS_TOKEN` is set, and refuse all requests on Vercel or under `NODE_ENV=production` until it is. Requests with a foreign `Origin` are rejected. In this mode the deployment's server necessarily sees the audio and text it relays. The app code does not store or log them; the hosting platform's own logs are the deployer's responsibility.

**Key storage.** In browser-direct mode a key is held for the current tab by default. If the user chooses to remember it on the device, it is stored in the browser's storage for this site, unencrypted, and is available to anyone with access to that browser profile and to any script running on the origin. The strict CSP (scripts only from the app's own origin, no inline scripts) is the main protection against the latter.

**Content.** Transcripts and model output are treated as untrusted. The prompt marks the transcript as data, not instructions; model output is strictly validated before it is shown; the UI contract requires transcript and model text to be inserted as text, never as HTML; Markdown, HTML and DOCX exports escape it.

**Endpoints.** Custom base URLs must use HTTPS, except on `localhost`, `127.0.0.1` and `[::1]`, and may not contain credentials or query strings. Server mode never lets the browser choose an endpoint.

## Out of scope

- The security, retention and data handling of AI providers, and whether their terms suit clinical data.
- Compromise of the user's own device, browser, browser extensions or operating system, or of a shared browser profile where a key was remembered.
- Prompt injection that only changes the wording of a draft the clinician reviews, unless it bypasses validation, verification markers or the draft label.
- The accuracy of model output. That is a clinical-safety concern; please report it as a regular issue with a fictional example.
- Denial of service or cost exhaustion against a self-hosted deployment whose owner has shared the access token.
- Configuration of third-party hosting, reverse proxies or local model servers (for example an overly broad `OLLAMA_ORIGINS`).
- Missing hardening headers on hosts other than the one configured by `vercel.json`.
