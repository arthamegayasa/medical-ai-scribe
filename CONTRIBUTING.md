# Contributing to Medical AI Scribe

Thank you for helping. Code, documentation, translations and careful bug reports are all welcome. Reports from clinicians about drafts that went wrong are especially valuable: please describe the problem with a **fictional or fully de-identified** example, never real patient data.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately, as described in [SECURITY.md](SECURITY.md), not in public issues.

## Setup

You need Node.js 20 or newer and npm. There is nothing else to install.

```bash
git clone https://github.com/arthamegayasa/medical-ai-scribe.git
cd medical-ai-scribe
npm ci          # verifies the (empty) lockfile
npm run dev     # http://127.0.0.1:3000, serves web/ directly
```

Before you open a pull request, run the same checks as CI:

```bash
npm run check   # syntax-checks every .js file
npm test        # node --test, with mocked providers
npm run build   # copies web/ into public/
```

CI runs these on Node 20, 22 and 24. Browser end-to-end tests against a mock provider are being added as `npm run test:e2e`; once they land, run them too for UI changes.

Useful references:

- [`web/core/README.md`](web/core/README.md): the engine API (providers, generation, verification, transcription, export, server mode).
- [`web/app/UI-CONTRACT.md`](web/app/UI-CONTRACT.md): the workspace markup hooks, events and i18n rules. `/app/?demo=list` renders every UI state without the engine.
- [GLOSSARY.md](GLOSSARY.md) for project terms and [`docs/adr/`](docs/adr/) for the reasons behind the architecture.

## Ground rules

### Zero runtime dependencies, no build step

`package.json` has no `dependencies` and no `devDependencies`, and it should stay that way. The engine in `web/core/` is plain ES modules that run unmodified in current browsers and in Node 20+. Tests use `node:test` and `node:assert`. The "build" only copies files. See [ADR 0002](docs/adr/0002-zero-dependencies-no-build.md).

If you believe a dependency is truly necessary, open an issue first and explain what it buys and what it costs (supply-chain risk, audit burden, CSP impact).

### Keep the Content Security Policy strict

The policy in `vercel.json` is the single source of the security headers; `dev-server.js` reads it so local development behaves like production. Code must work under `script-src 'self'; style-src 'self'`:

- No inline `<script>`, no `<style>` blocks, no `style=""` attributes, no `onclick=` or other inline handlers.
- To drive visuals from JavaScript, set classes, attributes or CSS custom properties (`el.style.setProperty('--value', n)`).
- Load nothing from third-party origins: fonts, icons and images are self-hosted under `web/assets/`.
- Never widen the CSP to make a feature work. If a change seems to need it, raise it in an issue. [ADR 0006](docs/adr/0006-connect-src-https-csp.md) explains why `connect-src` is broader than the rest.

### Never leak secrets or clinical content

- Keys go only into request headers to the chosen provider. Never put them in URLs, logs, `data-*` attributes, error messages or exports.
- Error messages are fixed, user-safe sentences (`ScribeError`). Do not copy provider response bodies or transcript text into errors or logs.
- Nothing clinical is stored unless the user turned history on, and then only in the browser.

### Keep the draft honest

The DRAFT label, review flags, unverified markers and "check number" markers must stay visible in the UI and in every export. Changes to the prompt, schema or verification (`web/core/soap/`) need tests that show the safety properties still hold.

## Test first

Write or update a failing test before changing behaviour, then make it pass. This applies in particular to:

- anything in `web/core/` (request formats, parsing, verification, segmentation, exports);
- server-mode handlers, configuration, the request guard and limits in `lib/`;
- bug fixes, which should come with a regression test.

Tests inject `fetchImpl` and never call real providers. Copy-only and purely visual changes do not need contrived tests, but include before and after screenshots in the pull request.

## Adding a provider preset

Presets live in [`web/core/providers.js`](web/core/providers.js). A preset is a frozen object with `id`, `label`, `family`, `baseUrl`, `keyUrl`, `keyRequired`, `browser`, `capabilities`, `structuredModes`, suggested `chatModels` and `transcriptionModels`, an optional `defaultChatModel` (the balanced mid-tier choice used when nothing else is selected), and for transcription `transcriptionDialect` and `maxUploadBytes`.

1. **Reuse a protocol family if you can.** Most providers speak the OpenAI Chat Completions protocol (`family: 'openai'`) and need only a new preset. A new family also needs authentication headers in `authHeaders()`, request and response handling in `chat.js` and `models.js`, and, for transcription, a dialect in `transcribe.js`.
2. **Write the tests first** in `tests/core-providers.test.js`, `tests/core-chat.test.js` or `tests/core-transcribe.test.js`, using recorded response shapes from the provider's documentation.
3. **Verify CORS before you set `browser: 'direct'`.** Browser-direct mode works only if the provider answers cross-origin preflight requests. For **every endpoint and header set the engine sends** (model listing, chat, transcription), send an unauthenticated preflight with the production origin:

   ```bash
   curl -si -X OPTIONS "https://api.example.com/v1/chat/completions" \
     -H "Origin: https://medicalaiscribe.vercel.app" \
     -H "Access-Control-Request-Method: POST" \
     -H "Access-Control-Request-Headers: authorization,content-type"
   ```

   Use `GET` for model listing and the provider's real auth header name (for example `x-api-key`). The response must succeed and return `Access-Control-Allow-Origin` equal to the origin (or `*`), and `Access-Control-Allow-Headers` must cover every header requested. Record the endpoints and the date in the comment at the top of `providers.js`, as the existing presets do.

   - All endpoints pass: `browser: 'direct'`.
   - Some fail: set the matching capability to `false` (Deepgram allows only `POST /v1/listen`, so `modelListing` is `false`) and note why in a comment.
   - Only works after the user configures their own server: `browser: 'local'`.
4. **Server mode (optional).** To offer the provider with a server-held key, add it to `TEXT_PROVIDERS` or `TRANSCRIPTION_PROVIDERS` in `lib/config.js`, add its variables to `.env.example`, and add tests in `tests/api.test.js`.
5. **Documentation.** Update the providers table in `README.md`, [`docs/providers.md`](docs/providers.md) and the capability table in `web/core/README.md`. The UI builds its provider grid from the preset ids listed in the UI contract.

Use the [new provider issue template](https://github.com/arthamegayasa/medical-ai-scribe/issues/new?template=new_provider.yml) if you want to discuss a provider before writing code.

## Adding a note template

Templates are emphasis profiles in `TEMPLATES` in [`web/core/soap/prompt.js`](web/core/soap/prompt.js). Each has a `label` and an `emphasis` sentence listing what to make easy to find **when the transcript documents it**. A template must never ask the model to add content, assume normal findings or fill a structure. Keep the wording in the style of the existing entries.

Then:

- add an `<option>` whose `value` equals the engine key to each template `select` in `web/app/index.html`;
- add the `templates.*` label to both `web/assets/js/strings/en.js` and `id.js`;
- extend `tests/core-soap.test.js` so the new template is accepted and its emphasis reaches the prompt.

## Adding a note language

Note languages are in `LANGUAGES` in [`web/core/soap/prompt.js`](web/core/soap/prompt.js): a `label` and the exact `notDocumented` sentence the model must use for an empty section. That sentence is also how verification recognises empty sections, so it must be exact and unique.

- Export labels are in `LABELS` in `web/core/export/model.js`. Languages without an entry export with English labels; add one for a complete translation.
- Add the language to the note-language `select` elements in `web/app/index.html`.
- Number words used by the number check (`web/core/soap/evidence.js`) currently cover English and Indonesian. Adding another language's number words is welcome, with tests.
- Interface translations are a separate matter: a new UI language needs a full strings file with the same keys and placeholders as `en.js`, and changes to `i18n.js`. Open an issue first.

Translations by fluent speakers, ideally clinicians, are much appreciated.

## Commits and pull requests

- Branch from `main` and keep each pull request to one concern.
- Write commit subjects in the imperative mood, under about 72 characters ("Add Cohere preset", "Reject quotes with ellipses"), with a body explaining why when it is not obvious.
- Fill in the pull request template: what changed and why, how you tested it, screenshots for UI changes, and the safety checklist.
- All CI checks must pass. A maintainer review is required before merge.
- Do not include real patient data anywhere: code, tests, fixtures, screenshots, issues or commit messages.
- By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
