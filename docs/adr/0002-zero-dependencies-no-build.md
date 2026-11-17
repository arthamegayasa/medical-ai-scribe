---
status: accepted
---

# Zero runtime dependencies and no build step

## Context

Clinicians and their IT staff need to be able to review what runs in the browser with patient data, and self-hosters need a deployment that does not break when a package changes. Every dependency is supply-chain exposure in a page that holds provider keys. The engine must also run in two places: the browser (browser-direct mode) and Node (server mode and tests).

## Decision

The project ships **no runtime dependencies and no devDependencies**. The engine in `web/core/` is plain ES modules that run unmodified in current browsers and in Node 20+, using only web-standard APIs (`fetch`, streams, `TextDecoder`, Web Audio in the browser). The server uses only `node:` modules. Tests use `node:test`. The build (`lib/build.js`) only copies `web/` to `public/`, skipping Markdown, tests and dotfiles; `npm run dev` serves `web/` directly.

Formats that usually come from libraries are implemented in small, tested modules: DOCX via a minimal ZIP writer (`web/core/export/zip.js`), WAV encoding and resampling (`web/core/audio/pcm.js`), and a partial-JSON reader for streaming.

## Consequences

- What is in the repository is exactly what the browser runs; there is nothing to audit beyond it.
- `npm ci` installs nothing, and CI runs in seconds on Node 20, 22 and 24.
- Fonts, icons and images are self-hosted, which also suits the strict CSP.
- Some features cost more effort than a library would (DOCX, audio decoding, JSON streaming), and the hand-written versions cover only what the app needs.
- No TypeScript, JSX or minification. Types are documented in JSDoc and in `web/core/README.md`.

## Alternatives rejected

- **A framework and bundler.** Faster UI development, but a large dependency tree, a build that self-hosters must reproduce, and shipped code that differs from the source.
- **Selected small libraries (for example for DOCX or ZIP).** Each is small, but together they add update and audit burden for features that need only a fraction of the library.
