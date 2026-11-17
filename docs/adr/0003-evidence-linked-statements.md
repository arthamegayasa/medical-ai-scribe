---
status: accepted
---

# Evidence-linked statements with deterministic verification

## Context

A language model can omit, misattribute or invent details, and a fluent note hides those errors. A clinician reviewing a free-text draft has to re-read the whole transcript to find them. Asking a second model to check the first would add cost and its own errors, and would not give the reviewer anything concrete to look at.

## Decision

The note schema (`web/core/soap/schema.js`) makes every SOAP section a list of **statements**, each `{ text, evidence }`, where `evidence` is a list of short verbatim quotes from the transcript. Review flags have the same shape plus a `type`. Model output is parsed strictly: exact keys, non-empty sections, bounded lengths; anything else is rejected as `invalid_output` and never shown. Empty sections must use the language's fixed "not documented" sentence with no evidence.

After generation, `verifyNote()` (`web/core/soap/evidence.js`) checks every quote against the transcript **without AI**: normalised matching (case, accents, punctuation, whitespace), with a bounded word-level edit tolerance (about 15%) for quotes of three or more words. A statement is **grounded** only if it has at least one quote and all are found, otherwise **unverified**. Separately, every number in the statement, with its unit, is checked against the transcript. Results carry offsets into the original transcript for highlighting, and exports carry `[UNVERIFIED]` and `[CHECK NUMBER: ...]` markers.

## Consequences

- Reviewers get a link from each statement to its source and a short list of what to check first.
- Verification is reproducible, fast, free, and testable with fixed inputs.
- A grounded quote is not proof of correctness: a quote can be found yet misread, out of context or from the wrong speaker. The UI and documentation must say so.
- The fuzzy tolerance can occasionally accept a near-miss quote; a stricter threshold would mark more correct statements unverified because of small transcription differences.
- Number matching understands decimal commas, thousands separators, unit synonyms and English and Indonesian number words only; other languages rely on digits.
- The schema is written to the intersection of what OpenAI strict mode, Anthropic, Gemini and Mistral accept, so it cannot use richer JSON Schema features.

## Alternatives rejected

- **Free-text or section-level notes.** Simpler prompts, but nothing to verify at statement level.
- **Model-produced character offsets or turn ids.** Models are unreliable at counting; quotes can be checked, offsets cannot.
- **A second model as verifier.** Non-deterministic, costs another request, and sends the content to a provider again.
