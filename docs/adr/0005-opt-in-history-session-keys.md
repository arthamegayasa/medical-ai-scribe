---
status: accepted
---

# Opt-in, device-only history and session-only keys by default

## Context

In browser-direct mode the browser holds the user's provider key and, during a session, the transcript and draft. Browsers are often shared in clinics, and anything written to browser storage persists after the tab closes and is readable by anyone using that profile. At the same time, re-entering a key every time, or losing a draft on reload, is a real cost for some users.

## Decision

- **Keys** are kept for the current tab only by default. The user may choose "Remember on this device" per connection, with a plain warning that anyone using the browser profile could use it.
- **Session history** (transcripts and drafts) is **off by default**. When turned on, it is stored only in this browser, can be deleted automatically after 1, 7 or 30 days (or kept until deleted), and the user can delete everything stored on the device in one step.
- Nothing clinical is ever stored on a server. Without asking, the UI keeps only preferences on the device: theme, language, note defaults and connection settings without their keys (provider, name, endpoint).
- Keys are kept in `sessionStorage` (tab) or `localStorage` (remembered); history uses IndexedDB. If browser storage is unavailable, the app keeps values in memory for the page only.

## Consequences

- The default leaves no clinical content or credentials behind when the tab closes.
- Users who want convenience make an explicit, informed choice for each key and for history.
- Remembered keys and history are stored unencrypted in browser storage; their protection is the user's device account and the CSP, which blocks third-party and inline scripts.
- No cross-device sync or backup; exports are the way to keep a draft.

## Alternatives rejected

- **Remember keys and history by default.** Convenient, but unsafe on shared machines and surprising for clinical data.
- **Encrypt stored data with a passphrase.** Adds complexity and key management while protecting little against a script running on the same origin.
- **Server-side history.** Contradicts browser-direct mode ([ADR 0001](0001-browser-direct-byok.md)) and would require accounts and a database of clinical content.
