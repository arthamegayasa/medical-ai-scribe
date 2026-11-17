---
status: accepted
---

# Evidence-linked statements with deterministic verification

## Context

A language model can omit, misattribute or invent details, and a fluent note hides those errors. A clinician reviewing a free-text draft has to re-read the whole transcript to find them. Asking a second model to check the first would add cost and its own errors, and would not give the reviewer anything concrete to look at.

## Decision

The note schema (`web/core/soap/schema.js`) makes every SOAP section a list of **statements**, each `{ text, evidence }`, where `evidence` is a list of short verbatim quotes from the transcript. Review flags have the same shape plus a `type`. Model output is parsed strictly: exact keys, non-empty sections, bounded lengths; anything else is rejected as `invalid_output` and never shown. Empty sections must use the language's fixed "not documented" sentence with no evidence.

After generation, `verifyNote()` (`web/core/soap/evidence.js`) checks every quote against the transcript **without AI**:

- A statement is **grounded** only if it has at least one quote and **every** quote matches the transcript exactly after normalisation: case, accents, whitespace and punctuation (including quote-mark variants) are ignored, but sentence punctuation is a boundary a quote may not silently cross, and a match never starts or ends inside a word or number.
- Tolerant matching (ignoring sentence boundaries, or about 15% word edits for quotes of three or more words) yields a distinct status, **approximate** ("close match: check wording"). It is never grounded, because a one-word difference is often a negation ("I am allergic" against "I am not allergic"). The UI and every export treat it as needing review, like unverified, while still showing the matched span.
- Quotes too short or generic to be evidence (under three letters or digits, a bare number, filler words only) never count.
- Otherwise the statement is **unverified**.

Separately, every number in the statement (digits or English/Indonesian number words), with its unit, is compared by parsed value against the numbers in the transcript; ratios and ranges are compared whole, and ambiguous digit groupings are always flagged. Results carry offsets into the original transcript for highlighting.

Grounding describes the text that was checked. The workspace records each statement's provenance: lines the model wrote keep the text that was verified, and lines the clinician typed are marked as theirs. **The rule:** a model statement whose text changes (anything beyond whitespace) becomes **edited**, never grounded, until its text is again exactly what was verified or the section is regenerated; a typed line is **clinician-entered**, not unverified. We do not re-run the quote check on edited text, because the quotes still match the transcript after any edit: the check proves the quotes exist, not that the new wording says what they say. Exports carry `[UNVERIFIED]`, `[CLOSE MATCH - CHECK WORDING]`, `[EDITED - RE-CHECK AGAINST TRANSCRIPT]`, `[CLINICIAN-ENTERED]` and `[CHECK NUMBER: ...]` markers.

## Consequences

- Reviewers get a link from each statement to its source and a short list of what to check first.
- Verification is reproducible, fast, free, and testable with fixed inputs.
- A grounded quote is not proof of correctness: a quote can be found yet misread, out of context or from the wrong speaker. The UI and documentation must say so.
- Exact grounding marks more statements "close match" when the model paraphrases or drops a word or a sentence break. That costs review time; the alternative, grounding near-misses, could hide a reversed negation.
- Any wording change to a model statement, even a typo fix, asks for a re-check. Restoring the original text or regenerating the section clears it.
- Number matching understands decimal commas and points, valid thousands groupings, unit synonyms (English and Indonesian), ratios, ranges and English and Indonesian number words only; other languages rely on digits. A grouping like "2.500" reads as 2500.
- The schema is written to the intersection of what OpenAI strict mode, Anthropic, Gemini and Mistral accept, so it cannot use richer JSON Schema features.

## Alternatives rejected

- **Free-text or section-level notes.** Simpler prompts, but nothing to verify at statement level.
- **Model-produced character offsets or turn ids.** Models are unreliable at counting; quotes can be checked, offsets cannot.
- **A second model as verifier.** Non-deterministic, costs another request, and sends the content to a provider again.
- **Counting fuzzy matches as grounded.** The original design; it grounded "no chest pain" from "Any chest pain" and "allergic to penicillin" from "not allergic to penicillin".
- **Dropping tolerant matching entirely.** Safer than grounding it, but the reviewer would lose the pointer to the nearly matching passage, which is exactly where to look.
- **Keeping an edited statement grounded when its quotes still match.** Quotes almost always still match after an edit, so this would keep "No chest pain" grounded after rewriting "Chest pain".
