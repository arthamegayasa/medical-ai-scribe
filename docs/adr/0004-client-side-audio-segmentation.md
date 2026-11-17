---
status: accepted
---

# Client-side audio segmentation to 16 kHz mono WAV

## Context

Consultations can last an hour. Transcription providers cap uploads per request (25 MB for OpenAI, Groq, Mistral and OpenAI-compatible servers, 14 MB for Gemini inline audio, 100 MB for Deepgram and ElevenLabs), and server mode is limited to 3 MB per request by the serverless body limit. In browser-direct mode there is no server to split files, and in either mode audio should not be uploaded to more places than necessary.

## Decision

The browser decides per file (`chooseUploadStrategy()`): if the original file fits the provider's limit it is uploaded unchanged; otherwise it is decoded with `OfflineAudioContext` at 16 kHz mono and cut into segments (`prepareSegments()`, `planSegments()`). Each cut is placed at the quietest 400 ms within the 30 seconds before the target length, with **no overlap**, and each segment is encoded as 16-bit PCM WAV no larger than the limit. Segments are uploaded in order with limited concurrency and retries, then merged with their time offsets (`transcribeSegments()`, `mergeTranscripts()`).

## Consequences

- The same code serves browser-direct and server mode; server mode simply passes a smaller limit.
- 16 kHz mono is what speech recognisers typically use internally, so little useful information is lost, and WAV avoids needing an encoder in the browser.
- WAV is larger than compressed audio (about 1.9 MB per minute), so segments are shorter than the original file would be, and decoding an hour of audio needs roughly 230 MB of memory.
- Without overlap, no words are duplicated and nothing has to be de-duplicated; a word could still be cut if a speaker never pauses within the search window.
- Diarization labels are only consistent within a segment, so multi-segment speaker labels are namespaced (`2:A`) rather than presented as the same speaker.

## Alternatives rejected

- **Server-side splitting (for example with ffmpeg).** Not available in browser-direct mode, sends audio through the server, and adds a binary dependency.
- **Overlapping segments with text de-duplication.** De-duplication can silently drop or repeat clinical content.
- **Re-encoding to a compressed format in the browser.** Smaller segments, but it needs either a JavaScript encoder (a dependency or a large module) or re-recording the decoded audio in real time.
