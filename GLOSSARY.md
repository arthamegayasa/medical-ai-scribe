# Medical AI Scribe

Terms used in the code, the interface and the documentation for turning a recorded or written clinical consultation into a clinician-reviewed SOAP draft.

## Modes and access

**Browser-direct mode**:
The default way of working, in which the browser sends keys, audio and text straight to the provider and the app's host serves files only.
_Avoid_: client mode, local mode

**BYOK (bring your own key)**:
The principle that each user supplies their own provider key rather than using one held by the app.
_Avoid_: user key mode

**Server mode**:
An optional self-hosted setup in which provider keys live in the deployment's environment and the browser reaches providers through the app's `/api/*` endpoints.
_Avoid_: proxy mode, server keys mode

**Workspace access token**:
A shared secret, set by the deployer as `SCRIBE_ACCESS_TOKEN`, that users present to use a server-mode deployment; it is never a provider key.
_Avoid_: password, API key

**Deployer**:
Whoever runs an instance of the app and is therefore responsible for its configuration, hosting logs and the provider accounts it uses in server mode.
_Avoid_: admin, operator

## Providers and models

**Provider**:
A service that transcribes audio or writes text, reached over HTTP, including a model server on the user's own machine.
_Avoid_: vendor, backend, AI

**Preset**:
A catalog entry describing one provider: its endpoint, protocol family, capabilities, browser access and suggested models.
_Avoid_: provider config, integration

**Protocol family**:
The request and response format a preset speaks (OpenAI-compatible, Anthropic, Gemini, Deepgram or ElevenLabs); presets in one family share request handling.
_Avoid_: API type, dialect (the latter is reserved for transcription request variants)

**Connection**:
One configured use of a preset: the preset plus the user's key and, for local or custom presets, a base URL.
_Avoid_: account, integration, credential

**Browser access**:
A preset's verified ability to be called from the page: direct (CORS verified), local (works once the user enables CORS on their own server) or unknown (custom endpoint).
_Avoid_: CORS mode

**Transcription model**:
The model that turns audio into transcript text.
_Avoid_: ASR, speech model

**Note model**:
The text model that writes the SOAP draft and, when asked, labels speakers.
_Avoid_: chat model, LLM, SOAP model

## Capture and transcript

**Session**:
One consultation's working set in the workspace: its transcript, its draft and their settings.
_Avoid_: encounter (the clinical event itself), visit, case

**Transcript**:
The text of the consultation, either transcribed from audio or pasted, which the clinician checks before drafting and which is the sole source for the draft.
_Avoid_: dictation, recording

**Turn**:
One contiguous stretch of speech by one speaker in a transcript, with an optional speaker label and timestamp.
_Avoid_: utterance, line

**Segment**:
A piece of a long recording, cut at a quiet point and sent for transcription separately, or the timed span of text a provider returns for it.
_Avoid_: chunk (used for text batches in speaker labelling)

**Speaker labelling**:
Assigning each turn to Doctor, Patient or Other, either by the transcription provider (diarization) or by the note model, accepted only if the words are unchanged.
_Avoid_: speaker identification

**Diarization**:
A transcription provider's own separation of speech into anonymous speakers (A, B, ...), without knowing who is the doctor.
_Avoid_: speaker labelling (which assigns roles)

**Vocabulary hints**:
A list of drug names, eponyms and proper names passed to the transcription model so that it spells them correctly.
_Avoid_: dictionary, keywords

## Draft and review

**Draft**:
The SOAP note the app produces; always labelled as requiring clinician review and never a final record.
_Avoid_: note (alone), report, summary

**SOAP section**:
One of the five parts of a draft: chief complaint, subjective, objective, assessment and plan.
_Avoid_: field, heading

**Statement**:
One short, separate claim in a SOAP section, with its evidence.
_Avoid_: sentence, bullet, line item

**Evidence**:
The verbatim transcript quotes attached to a statement or review flag to show where it came from.
_Avoid_: citation, source, reference

**Grounded**:
The status of a statement that has at least one quote and whose quotes are all found in the transcript.
_Avoid_: verified, correct, linked

**Unverified**:
The status of a statement with no quote, or with a quote that cannot be found in the transcript.
_Avoid_: hallucination, unsupported, wrong

**Not documented**:
The status of a section that the transcript says nothing about, written as a fixed sentence in the note language with no evidence.
_Avoid_: empty, N/A

**Check number**:
A marker on a statement containing a number, with its unit, that does not appear in the transcript.
_Avoid_: number error

**Review flag**:
An item the note model raises for the clinician to check: unclear wording, a contradiction, an uncertain number or medication, or a possible mistranscription.
_Avoid_: warning, alert, issue

**Stale draft**:
A draft whose transcript has been edited since it was written, and which carries that warning until it is rewritten.
_Avoid_: outdated note

**Template**:
A specialty emphasis profile that tells the note model which documented details to make easy to find, without adding content.
_Avoid_: form, specialty mode

**Note language**:
The language the draft's statements are written in, independent of the spoken language; evidence quotes stay in the transcript's language.
_Avoid_: output language, locale

**Provenance**:
The record of which provider, model, template and note language produced a draft, and when.
_Avoid_: metadata, audit trail

## Other

**Fictional example**:
A written, invented consultation with a prepared draft that demonstrates the workflow without a key and without any AI request.
_Avoid_: demo, sample patient, test data

**History**:
Saved sessions kept in the user's browser only, off unless the user turns it on.
_Avoid_: archive, records, cloud sync
