# web/core — Medical AI Scribe engine API

Plain ES modules with zero dependencies. They run unmodified in current browsers and in Node 20+.
The site serves them at `/core/...`; the server handlers import the same files.

- `import * as core from '/core/index.js'` — everything except audio decoding.
- `import { decodeAudio, prepareSegments } from '/core/audio/decode.browser.js'` — browser only (Web Audio).

Two modes, same result shapes:

| Mode | How | Who sees keys, audio, transcript |
|---|---|---|
| **BYOK (browser-direct)** | Call engine functions with a `connection` holding the user's key. | Only the browser and the chosen provider. Never the app server. |
| **Server keys** | `createServerClient()` calls `/api/*` with an optional app access token. | The deployment's server and its provider. |

Everything the engine produces is a **draft for clinician review**. Keep the DRAFT label, the
review flags and the unverified, close-match, edited and check-number markers visible in the UI.

---

## 1. Errors

Every failure is a `ScribeError` (`error.code` is stable; `error.message` is a fixed, user-safe
sentence — it never contains keys, provider response bodies or transcript text).

```js
import { ScribeError, ERROR_CODES } from '/core/index.js';
try { ... } catch (e) { if (e instanceof ScribeError) show(e.code, e.message); }
```

| `code` | Meaning / suggested UI |
|---|---|
| `auth` | Key rejected (HTTP 401/403). Ask the user to check the key. |
| `rate_limit` | 429. Retry later. `e.retryAfterMs` may be set. |
| `quota` | 402, or 429 for exhausted quota/credit. Check billing. |
| `model_not_found` | Model ID unknown to this key (404 or equivalent). |
| `context_too_long` | Transcript exceeds the model's context window. Pick a larger-context model. |
| `too_large` | Upload larger than the provider allows. Use segments. |
| `bad_request` | Provider rejected the request shape (after the structured-output fallback ladder). |
| `refusal` | Model declined (refusal stop reason, safety block, content filter). |
| `truncated` | Output hit the token limit or the stream ended early. |
| `invalid_output` | Model output failed strict JSON/schema validation. Never shown as a note. |
| `invalid_response` | Provider returned malformed/oversized data. |
| `provider_unavailable` | 5xx / overloaded. |
| `network` | Could not reach the provider: offline, wrong URL, **or CORS blocked** (browsers cannot tell these apart). |
| `timeout` | Deadline passed. |
| `aborted` | Your `AbortSignal` fired. |
| `invalid_input` | Bad argument (missing key, short transcript, bad language code, ...). Checked before any network call. |
| `unsupported` | Provider cannot do this (e.g. Anthropic transcription, Deepgram key check). |
| `verification_failed` | Speaker labelling changed the wording; result rejected. |
| `access_denied` | Server mode: app access token rejected. |
| `server_not_configured` | Server mode: provider/transcription/token not configured on the server. |

`e.retryable` is `true` for `rate_limit`, `provider_unavailable`, `network`, `timeout`.

Every async browser-direct function (providers, generation, speaker labelling, transcription)
accepts `signal` (an `AbortSignal`), `timeoutMs` and `fetchImpl` (defaults to `globalThis.fetch`;
tests inject a mock). The server-mode client is different: it takes `fetchImpl` and `timeoutMs`
once, in `createServerClient(...)`, and its methods accept only `signal` (section 8).

---

## 2. Providers and connections

```js
core.PROVIDERS                 // frozen array of presets (below)
core.getProvider(id)           // preset or throws invalid_input
core.listProviders(capability) // capability: 'chat' | 'transcription' | 'modelListing' | 'diarization' | undefined
core.suggestedModels(id, purpose = 'chat' | 'transcription') // string[] fallback IDs
core.resolveConnection(connection) // -> { preset, baseUrl, apiKey } (validates; mostly internal)
core.validateBaseUrl(url)      // -> normalised URL string; HTTPS, or HTTP only on localhost/127.0.0.1/[::1]
```

A **connection** is a plain object you keep in UI state (store keys only where the user chose):

```js
{ provider: 'openai', apiKey: 'sk-...' }                       // fixed endpoint; baseUrl ignored
{ provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1' }   // optional baseUrl, no key needed
{ provider: 'custom', baseUrl: 'https://llm.example.org/v1', apiKey: '...' } // baseUrl required
```

Use separate connections for transcription and for note generation if you like.

Preset fields: `id, label, family ('openai'|'anthropic'|'gemini'|'deepgram'|'elevenlabs'), baseUrl, defaultChatModel?
(the balanced, mid-tier model used as the default note model in the app and in server mode),
keyUrl (where to create a key, or null), keyRequired, customBaseUrl?, browser, capabilities
{ chat, transcription, modelListing, diarization }, structuredModes, chatModels, transcriptionModels,
maxUploadBytes (transcription presets), transcriptionDialect`.

`browser`: `'direct'` = CORS verified for the endpoints/headers the engine sends; `'local'` = works
only after the user enables CORS on their local server (Ollama: set `OLLAMA_ORIGINS` to the app
origin; LM Studio: enable CORS); `'unknown'` = custom endpoint, must allow CORS itself.

| id | chat | transcription | model list | diarization | max upload |
|---|---|---|---|---|---|
| `openai` | yes | yes | yes | yes (`gpt-4o-transcribe-diarize`) | 25 MB |
| `anthropic` | yes | no | yes | – | – |
| `gemini` | yes | yes (audio prompt, no timestamps) | yes | no | 14 MB |
| `openrouter` | yes | no | yes | – | – |
| `groq` | yes | yes (Whisper) | yes | no | 25 MB |
| `mistral` | yes | yes (Voxtral) | yes | yes | 25 MB |
| `deepgram` | no | yes | **no** (CORS) | yes | 100 MB |
| `elevenlabs` | no | yes (Scribe) | no (key check via `/user`) | yes | 100 MB |
| `local` | yes | yes (if the server offers `/audio/transcriptions`) | yes | no | 25 MB |
| `custom` | yes | yes | yes | no | 25 MB |

### listModels(connection, options) → `Promise<Model[]>`

`options: { purpose = 'chat' | 'transcription' | null, signal, fetchImpl, timeoutMs = 20000 }`.
Returns `[{ id, label, contextTokens?, structuredOutputs? }]` from the user's own key. For
OpenAI-style `/models` lists, `purpose` filters by name heuristics (embeddings, TTS etc. removed for
`'chat'`); `null` returns everything. Throws `unsupported` for presets without listing (Deepgram,
ElevenLabs) — fall back to `suggestedModels()` and a free-text model field.

### testConnection(connection, options) → `Promise<{ ok: true, models: Model[] }>`

`options` are the same as `listModels` (pass `{ purpose: 'transcription' }` for a transcription
connection). Free, read-only key validation (model listing; ElevenLabs uses `GET /user`). Throws `auth`,
`network`, ... on failure, and `unsupported` for Deepgram (its key is checked on first transcription).

---

## 3. Text generation (low level)

### generateText(options) → `Promise<{ text: string, mode: 'json_schema' | 'json_object' | 'prompt' }>`

```js
{
  connection, model, system, user,           // strings
  schema, schemaName = 'result',             // JSON Schema; omit for plain text
  structured = 'auto',                       // or force 'json_schema' | 'json_object' | 'prompt'
  maxOutputTokens = 16000, stream = false,
  onDelta,                                   // ({ text: accumulatedText, delta, mode }) => void, when stream
  attachments = [],                          // Gemini only: [{ mimeType, data: base64 }]
  signal, timeoutMs = 300000, fetchImpl,
}
```

`'auto'` tries the provider's native schema mode (OpenAI-family `response_format.json_schema`
strict, Anthropic `output_config.format`, Gemini `responseJsonSchema`), then JSON mode, then
prompt-only — moving down **only** on `bad_request`. Groq skips `json_schema` when streaming.
Finish states are enforced: length → `truncated`, refusal/safety/content filter → `refusal`,
missing finish reason → `truncated`. You normally use the higher-level functions below.

`core.parsePartialJson(text)` → the largest valid prefix of a streaming JSON object, or `undefined`.
For display only; final output always goes through the strict parser.

---

## 4. SOAP notes

### Note shape

```js
{
  chief_complaint: Statement[], subjective: Statement[], objective: Statement[],
  assessment: Statement[], plan: Statement[],     // each non-empty
  review_flags: Flag[],                           // may be empty
}
Statement = { text: string, evidence: string[] }  // evidence = verbatim transcript quotes
Flag      = { type: FlagType, text: string, evidence: string[] }
FlagType  = 'unclear' | 'contradiction' | 'uncertain_number' | 'uncertain_medication' | 'possible_mistranscription' | 'other'
```

An empty section is exactly one statement whose text is the language's "not documented" string
(`core.LANGUAGES[code].notDocumented`) with `evidence: []`.

Constants: `SECTIONS`, `FLAG_TYPES`, `NOTE_SCHEMA`, `NOTE_LIMITS` (`statementChars 2000`,
`quoteChars 600`, `quotesPerStatement 8`, `statementsPerSection 100`, `flags 60`),
`TRANSCRIPT_LIMITS` (`minChars 10`, `maxChars 250000` ≈ 60–75 min of speech),
`CUSTOM_INSTRUCTIONS_MAX = 2000`.

`LANGUAGES`: `en` "Not documented in this encounter.", `id` "Tidak didokumentasikan dalam pertemuan
ini.", plus `es`, `fr`, `de`, `pt`. Each entry: `{ label, notDocumented }`.

`TEMPLATES` (guidance-only emphasis, never adds content): `general`, `neurology`, `emergency`,
`internal_medicine`, `pediatrics`, `psychiatry`, `follow_up`. Each entry: `{ label, emphasis }`.

### generateNote(options) → `Promise<{ note, meta }>`

```js
{
  connection, model, transcript,
  language = 'en', template = 'general', customInstructions = '',   // style only; cannot override safety rules
  stream = false, onPartial,       // ({ text, partial }) => void; partial = parsePartialJson(text), sections fill in
  maxOutputTokens = 16000, structured = 'auto', signal, timeoutMs, fetchImpl,
}
meta = { provider, model, template, language, structuredMode, generatedAt /* ISO */, transcriptHash, draft: true }
```

The transcript is trimmed, validated (`invalid_input`) and sent as a JSON string marked as
untrusted data. Output is strictly validated (`invalid_output` otherwise). Long transcripts that
exceed the model's window fail with `context_too_long`; `core.estimateTokens(text)` (≈ chars/3.5)
lets you warn before sending if `listModels()` reported `contextTokens`.

**Transcript changed since generation:** `core.hashText(currentTranscript.trim()) !== meta.transcriptHash`.

### regenerateSection(options) → `Promise<{ note, items, structuredMode }>`

Same options as `generateNote` plus `note` (current note, validated) and `section` (one of
`SECTIONS`); `maxOutputTokens` defaults to 8000. Returns the new note with only that section
replaced. Review flags are kept unchanged.

### verifyNote(note, transcript) → `Verification`

Pure and synchronous. Pass the transcript the note was generated from.

```js
{
  sections: { chief_complaint: Result[], ... },  // same order as note statements
  review_flags: Result[],
  summary: { statements, grounded, approximate, unverified, edited, clinician, notDocumented, numberIssues },
}
Result = {
  status: 'grounded' | 'approximate' | 'unverified' | 'not_documented',   // + 'edited' | 'clinician', see below
  quotes: [{ quote, found: true, start, end, exact, match: 'exact' | 'approximate' } | { quote, found: false, reason: 'weak' | 'absent' }],
  numbers: [{ text: '500 mg', number: '500', unit: 'mg' | null, found, reason?: 'absent' | 'unit' | 'ambiguous' }],
}
```

Statuses:

- `grounded`: at least one quote, and **every** quote matches the transcript exactly after
  normalisation. Only an exact match can ground a statement. `start`/`end` are UTF-16 offsets into
  the original `transcript` string: `transcript.slice(start, end)` is exactly the matched source
  text (also with CRLF line endings, accents, emoji and other multi-byte characters).
- `approximate`: every quote was found, but at least one only as a close match: it matches only when
  sentence punctuation is ignored, or (quotes of 3+ words) within about 15% word edits. A close
  match can hide a changed negation ("I am allergic" against "I am not allergic"), so it is never
  grounded: show it as needing review ("close match: check wording"), like `unverified`, with the
  matched span available for highlighting.
- `unverified`: no evidence, or a quote that was not found or was too weak to be evidence.
- `not_documented`: the language's exact "not documented" line with no evidence.
- `edited` and `clinician` are never produced by `verifyNote`; an app sets them from statement
  provenance (the workspace does, in `web/assets/js/app/note.js`): `edited` = a model statement
  whose text changed after verification, `clinician` = a line the clinician typed. Exports render
  all six statuses, and `summarizeVerification(sections)` recounts a summary after such changes.

Quote matching (`findQuote`):

- Normalisation folds case and accents and treats any run of whitespace and punctuation (quote
  marks, commas, dashes, line breaks) as one space. Sentence punctuation (`. ! ? ;` and ellipses)
  is a boundary: a quote may cross it only if the quote has sentence punctuation there too, so
  "no chest pain" is not grounded by "No. Chest pain". Trailing punctuation in a quote is ignored.
- Matches are word-aligned and never start or end inside a word or a number: `.` `,` `/` `:` and
  dashes between digits stay part of the number ("5 mg" is not found in "2.5 mg", "80 mmHg" not in
  "120/80 mmHg", "3 days" not in "2-3 days"). A unit glued to a number reads like the spaced form
  ("500mg" = "500 mg").
- Weak quotes never count (`reason: 'weak'`): fewer than three letters or digits, a bare number, or
  only filler words, pronouns and speaker labels (English and Indonesian, see `isWeakQuote`).

Number check (`checkNumbers`, `indexNumbers`); every number in a statement is checked and a number
that cannot be matched is flagged, never skipped:

- Numbers are compared as parsed values, never as text: "25" never matches "2.5", "15" never "1,5".
  `.` and `,` are both decimal marks. Separators are ignored only in a valid thousands grouping
  (groups of exactly three digits after a first group of 1-3 digits not starting with 0: "1,000",
  "1.000", "1 000", "1,234.5"); anything else with several separators ("1,23,456") is ambiguous and
  always flagged (`reason: 'ambiguous'`). Note that "2.500" therefore reads as 2500.
- Units are compared when the statement gives one, glued or spaced ("500mg"), with English and
  Indonesian spellings ("milligrams", "miligram", "hari" = days). Same number with another unit
  (`5 mg` vs `5 g`, `mg` vs `mcg`, `°C` vs `°F`, days vs weeks) is flagged (`reason: 'unit'`), as
  is a unit the transcript did not give.
- Ratios (`120/80`, "120 over 80") and ranges (`2-3`, "2 to 3", "2 sampai 3") are compared whole.
  A single value may come from one side of a ratio ("diastolic 80"), not from a written range
  ("3 days" is not "2-3 days"); spoken ranges ("from 5 to 10 mg") also confirm their ends, because
  speech uses the same words for dose changes.
- English and Indonesian number words are parsed in both texts: compounds ("one hundred and twenty",
  "dua puluh lima", "dua ribu lima ratus"), decimals ("two point five", "dua koma lima"), halves
  ("one and a half", "satu setengah") and frequencies ("once", "twice"). Pronoun uses ("no one",
  "salah satu") are not numbers. Number words in other languages are not parsed.

Lower-level helpers: `indexTranscript(transcript)`, `findQuote(index, quote)`, `isWeakQuote`,
`indexNumbers(transcript)`, `checkNumbers(text, index)`, `summarizeVerification(sections)`.

---

## 5. Speaker labelling

### labelSpeakers(options) → `Promise<{ text, turns }>`

`{ connection, model, transcript, onProgress, structured = 'auto', signal, timeoutMs, fetchImpl }`.
Input must be **unlabelled** text (`invalid_input` if it already starts lines with `Doctor:` etc.).
Long transcripts are processed in ≈12,000-character chunks (`onProgress({ completed, total })`).
Each chunk is rejected with `verification_failed` unless its words are identical apart from labels
and line breaks. `turns = [{ speaker: 'Doctor' | 'Patient' | 'Other', text }]`;
`text` is `"Doctor: ...\nPatient: ..."`. Also exported: `SPEAKERS`, `verifyLabelledTurns(source, turns)`
→ `{ ok } | { ok: false, wordIndex }`, `turnsToText(turns)`.

---

## 6. Transcription

### transcribe(options) → `Promise<Transcript>`

```js
{
  connection, model, audio /* Blob or File */, filename,   // filename defaults from MIME type
  language = 'auto' | 'en' | 'id' | ...,                   // ISO 639 2–3 letters
  vocabulary = [],      // up to 300 terms: drug names, clinician/patient names
  prompt = '',          // optional free-text context, max 2000 chars
  diarize = false, timestamps = true,
  signal, timeoutMs = 600000, fetchImpl,
}
Transcript = { text, segments: [{ start, end, text, speaker? }], language: string | null, model, provider }
```

Throws `too_large` if `audio.size > preset.maxUploadBytes` — segment first (below).

How options map per provider:

| Provider / model | vocabulary | language | timestamps | diarization |
|---|---|---|---|---|
| OpenAI `gpt-transcribe` | `keywords[]` | `languages[]` | no (text only) | no |
| OpenAI `gpt-4o-transcribe-diarize` | ignored (unsupported) | `language` | segments | always (`diarized_json`, `chunking_strategy=auto`) |
| OpenAI `whisper-1`, Groq, custom | prompt (≤800 chars) | `language` | `verbose_json` segments | no |
| `local` (Ollama) | prompt | `language` | `verbose_json` | no |
| Mistral Voxtral | `context_bias` (≤100) | `language` (then no timestamps — API restriction) | segments when no language | `diarize=true` |
| Deepgram | `keyterm` (≤100) | `language`, else `detect_language` | utterances | `diarize=true` |
| ElevenLabs Scribe | `keyterms` | `language_code` | word times grouped into segments | `diarize=true` |
| Gemini | spelling reference in prompt | in prompt | none | none (use `labelSpeakers`) |

### Long recordings

```js
core.chooseUploadStrategy({ sizeBytes, durationSeconds? }, { maxUploadBytes, maxDirectSeconds? }) // 'direct' | 'segment'
await prepareSegments(file, { maxUploadBytes, targetSeconds = 600 })  // browser: [{ audio: Blob(WAV), start, end }] seconds
await core.transcribeSegments({ ...transcribeOptions, segments, concurrency = 2, retries = 3, onProgress })
```

- Prefer `'direct'`: an hour of WebM/Opus is ~15 MB and fits OpenAI/Groq unchanged, avoiding decode.
- `prepareSegments` decodes with `OfflineAudioContext` at 16 kHz mono (memory ≈ 230 MB for 60 min),
  cuts at the quietest 400 ms within the 30 s before each target length (no overlap, so no duplicated
  or dropped words), and encodes 16-bit WAV no larger than `maxUploadBytes`.
- `transcribeSegments` uploads in order with limited concurrency, retries `rate_limit`,
  `provider_unavailable`, `network`, `timeout` with exponential backoff (honours Retry-After), cancels
  everything on the first unrecoverable error or on `signal`, and reports
  `onProgress({ completed, total, index })`. Result: one `Transcript` with segment times shifted to
  the full recording. With several segments, diarization labels are only consistent within a
  segment, so they become `"2:A"` (segment 2, speaker A).
- `core.mergeTranscripts(results, segments)` and `core.transcriptToText(transcript, { timestamps, speakers })`
  (`"[00:12:03] Speaker 2:A: text"` lines) are exported too.
- Pure helpers: `TARGET_SAMPLE_RATE`, `downmixToMono`, `resample`, `encodeWav`, `maxSegmentSeconds`, `planSegments`.

---

## 7. Export

All take `input = { note, meta, verification?, transcriptChanged = false, fictional = false }`
(`meta` from `generateNote`). Every format includes: the DRAFT / clinician-review label, a
fictional-sample label when `fictional`, the transcript-changed warning when `transcriptChanged`, an
"evidence not verified" notice when `verification` is absent (or, when present, banners counting
unverified, close-match and edited statements), per-statement markers `[UNVERIFIED]`,
`[CLOSE MATCH - CHECK WORDING]`, `[EDITED - RE-CHECK AGAINST TRANSCRIPT]`, `[CLINICIAN-ENTERED]` and
`[CHECK NUMBER: ...]`, review flags, and provenance
(provider, model, template, language, generated time). Indonesian notes (`meta.language === 'id'`)
get Indonesian labels.

```js
core.toMarkdown(input)   // string
core.toPlainText(input)  // string, EHR-paste friendly
core.toHtml(input, { stylesheetHref })  // full HTML document string for window.print()
core.toDocx(input)       // Uint8Array; new Blob([bytes], { type: core.DOCX_MIME })
```

**Printing under the app CSP** (inline styles are blocked): call
`toHtml(input, { stylesheetHref: location.origin + '/core/export/print.css' })` — use an absolute URL,
because a blob: document cannot resolve relative paths — then open it from a Blob URL in a new
window or an iframe (`frame-src 'self' blob:` is allowed) and call `print()`.

---

## 8. Server-key mode

```js
const server = core.createServerClient({ accessToken, baseUrl = '', fetchImpl, timeoutMs = 300000 });
await server.config()   // { mode: 'server', providers: [{ id, label, configured, default_model, suggested_models }],
                        //   transcription: { configured, provider, default_model, diarization },
                        //   access_token_required, limits: { transcript_chars, audio_bytes } }
await server.generateNote({ provider, model?, transcript, language, template, customInstructions })   // { note, meta }
await server.regenerateSection({ provider, model?, transcript, note, section, language, template, customInstructions }) // { note, items, structuredMode, section }
await server.labelSpeakers({ provider, model?, transcript })   // { text, turns }
await server.transcribe({ audio, model?, language, vocabulary, prompt, diarize, timestamps })   // Transcript (provider: 'server')
await server.transcribeSegments({ segments, ...sameOptions, concurrency, onProgress })
```

Server `provider` ids are `openai, anthropic, gemini, openrouter, groq, mistral, compatible`. Omit
`model` to use the server default. Server mode does not stream. Audio per request is limited to
`limits.audio_bytes` (3 MB ≈ 90 s of 16 kHz WAV), so always segment with
`prepareSegments(file, { maxUploadBytes: config.limits.audio_bytes })` unless the file is smaller.
Run `verifyNote` in the browser on the returned note, exactly as in BYOK mode.

Errors are `ScribeError`s mapped from the response's stable `code` only (401 = `access_denied`,
configuration codes = `server_not_configured`, unknown codes = `invalid_response`), each with the
engine's fixed message. The body's `error` text is never copied into an error.

---

## 9. End-to-end example (BYOK)

```js
import * as core from '/core/index.js';
import { prepareSegments } from '/core/audio/decode.browser.js';

const asr = { provider: 'openai', apiKey: userOpenAiKey };
const llm = { provider: 'anthropic', apiKey: userAnthropicKey };
const controller = new AbortController();               // wire to a Cancel button

// 0. Validate keys and fill model dropdowns (fall back to suggestions).
const asrModels = (await core.testConnection(asr, { purpose: 'transcription' })).models;
const llmModels = await core.listModels(llm).catch(() => core.suggestedModels('anthropic').map(id => ({ id, label: id })));

// 1. Audio (recorded Blob or uploaded File) -> segments.
const preset = core.getProvider(asr.provider);
const segments = core.chooseUploadStrategy({ sizeBytes: file.size }, preset) === 'direct'
  ? [{ audio: file, start: 0, end: null }]
  : await prepareSegments(file, { maxUploadBytes: preset.maxUploadBytes });

// 2. Transcribe.
const transcript = await core.transcribeSegments({
  connection: asr, model: 'gpt-transcribe', segments, language: 'id',
  vocabulary: ['levetiracetam', 'Dr. Sari'], signal: controller.signal,
  onProgress: ({ completed, total }) => setProgress(completed / total),
});

// 3. Optional speaker labels (words verified unchanged).
const { text: labelled } = await core.labelSpeakers({ connection: llm, model: 'claude-opus-5-5', transcript: transcript.text });

// 4. Generate the note, streaming sections into the UI.
const { note, meta } = await core.generateNote({
  connection: llm, model: 'claude-opus-5-5', transcript: labelled, language: 'id', template: 'neurology',
  stream: true, onPartial: ({ partial }) => renderPartial(partial), signal: controller.signal,
});

// 5. Verify evidence deterministically; highlight grounded quotes, mark the rest.
const verification = core.verifyNote(note, labelled);

// 6. Export (after clinician review).
const transcriptChanged = core.hashText(editorText.trim()) !== meta.transcriptHash;
const docx = new Blob([core.toDocx({ note, meta, verification, transcriptChanged })], { type: core.DOCX_MIME });
```

Errors at any step are `ScribeError`s; show `e.message` and branch on `e.code` (section 1).
