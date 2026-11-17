# Provider setup

Medical AI Scribe uses two models: a **transcription model** that turns audio into text, and a **note model** that writes the SOAP draft. They can come from different providers. If you paste transcripts, you need only a note model.

In browser-direct mode, add each provider in the workspace under **Settings → Connections**, test the connection, then pick models under **Settings → Models**. Your key goes only to that provider. It is kept for the current tab unless you choose to remember it on this device.

The catalog behind this page is [`web/core/providers.js`](../web/core/providers.js). Suggested model IDs there are fallbacks; where a provider allows it, the app lists the models your key can use.

## Hosted providers

| Provider | Get a key | Note model | Transcription | Notes |
| --- | --- | :---: | :---: | --- |
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | yes | yes | Speaker diarization with `gpt-4o-transcribe-diarize`. 25 MB per upload. |
| Anthropic Claude | [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys) | yes | – | Note model only. |
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | yes | yes | Transcribes through an audio prompt, without timestamps or diarization. 14 MB per upload. |
| OpenRouter | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) | yes | – | Note model only; model IDs look like `anthropic/claude-sonnet-5.5`. |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) | yes | yes (Whisper) | 25 MB per upload. |
| Mistral | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) | yes | yes (Voxtral) | Diarization supported. Setting a spoken language disables timestamps (an API restriction). |
| Deepgram | [console.deepgram.com](https://console.deepgram.com/) | – | yes | See the Deepgram caveat below. 100 MB per upload. |
| ElevenLabs | [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) | – | yes (Scribe) | Diarization supported. Models are not listed; type the model ID. 100 MB per upload. |

Recordings larger than a provider's upload limit are cut in the browser into WAV segments that fit ([ADR 0004](adr/0004-client-side-audio-segmentation.md)).

**Choosing a note model.** Use a capable text model that supports structured output. The app asks for a strict JSON schema first and falls back to JSON mode, then plain instructions, only if the provider rejects the request format. It rejects any reply that does not validate. Smaller models may fail validation or produce unverified statements more often; test a model on fictional consultations before relying on it.

### Deepgram

Deepgram allows cross-origin requests only on `POST /v1/listen`, the transcription endpoint. From the browser the app therefore cannot list Deepgram models or test the key in advance. Type a model ID (the suggestions are `nova-3-medical` and `nova-3`); a wrong key is reported on the first transcription.

## Local models

The **Local model (Ollama / LM Studio)** preset talks to an OpenAI-compatible server on your own machine and needs no key. The default base URL is `http://127.0.0.1:11434/v1` (Ollama). Endpoints must use HTTPS, except on `localhost` and `127.0.0.1`.

A local note model keeps the drafting step on your machine. It does **not** make transcription local: for that, also connect a local server that implements the OpenAI `POST /v1/audio/transcriptions` API, or paste transcripts. Ollama and LM Studio do not provide that endpoint themselves.

### Allowing the app's origin (CORS)

Browsers block a page from reading responses from another origin unless that server allows it. Local servers must allow the origin the app is served from:

| You open the app at | Origin to allow |
| --- | --- |
| The hosted app | `https://medicalaiscribe.vercel.app` |
| `npm run dev` | `http://127.0.0.1:3000` (or your `PORT`) |
| Your own deployment | its `https://` origin |

**Ollama.** Set the `OLLAMA_ORIGINS` environment variable for the Ollama server to a comma-separated list of origins, then restart Ollama. Recent Ollama versions already allow `localhost` and `127.0.0.1` origins, so this is mainly needed for the hosted app or your own domain.

- Windows: add `OLLAMA_ORIGINS` as a user environment variable (for example `setx OLLAMA_ORIGINS "https://medicalaiscribe.vercel.app"` in a terminal), quit Ollama from the system tray and start it again.
- macOS: `launchctl setenv OLLAMA_ORIGINS "https://medicalaiscribe.vercel.app"`, then restart the Ollama app.
- Linux (systemd): `sudo systemctl edit ollama.service`, add `Environment="OLLAMA_ORIGINS=https://medicalaiscribe.vercel.app"` under `[Service]`, then `sudo systemctl daemon-reload && sudo systemctl restart ollama`.

Allow only the origins you use. A wildcard (`*`) lets any website you visit use your local models.

**LM Studio.** Start the local server from LM Studio's developer view and turn on **Enable CORS** in its server settings. Use the base URL `http://127.0.0.1:1234/v1` unless you changed the port.

**Other local servers.** Any OpenAI-compatible server works if it answers CORS preflight requests from the app's origin and allows the `Content-Type` header (and `Authorization`, if you set a key).

### Calling a local server from the hosted app

The hosted app is an HTTPS page; your local server is plain HTTP on loopback. Current Chromium-based browsers and Firefox treat `localhost` and `127.0.0.1` as secure contexts and allow this, but some browsers block it or ask for permission to access devices on your local network, and Safari is stricter. If requests fail, run the app locally with `npm run dev` and connect from there. `[::1]` is not usable from the browser because the app's Content Security Policy allows only `localhost` and `127.0.0.1`.

## Custom OpenAI-compatible endpoints

The **Custom OpenAI-compatible endpoint** preset accepts any HTTPS base URL that includes the API prefix, such as `https://llm.example.org/v1`, with an optional key. It can provide a note model (`/chat/completions`), transcription (`/audio/transcriptions`) and model listing (`/models`).

From the browser this works only if the endpoint answers CORS preflights for the app's origin with `Authorization` and `Content-Type` allowed. Browsers report a blocked request as a network error, indistinguishable from an outage. If you control the endpoint, enable CORS for your app's origin; if you do not, use [server mode](self-hosting.md#configuring-server-mode) with `COMPATIBLE_BASE_URL` or `TRANSCRIPTION_BASE_URL`, where the server makes the call and CORS does not apply.

## Troubleshooting

| Message or symptom | Likely cause |
| --- | --- |
| The provider rejected the key | Wrong or revoked key, or a key for a different project or region. |
| The request did not reach the provider | Offline, wrong base URL, or blocked by CORS. For local and custom servers, check the allowed origins. |
| The model could not be used | The model ID is not available to this key. Refresh the model list or check the ID. |
| The model's reply could not be read as a note | The model did not return valid structured output. Try again or choose a more capable model. |
| The provider is limiting requests | Rate limit or exhausted credit. Wait, or check billing. |

## Data terms

Whatever you send is processed by the provider under its own terms, which differ in retention, training use and the agreements available for health data. Read them before using real patient information. Provider names are listed only to describe compatibility; this project is not affiliated with or endorsed by any provider.
