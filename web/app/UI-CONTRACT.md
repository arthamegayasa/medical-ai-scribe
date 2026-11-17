# UI contract: workspace shell

For the engineer wiring `web/core/**` to the UI. The UI layer owns markup, CSS, theme, i18n and generic primitives. It makes **no** provider calls, does no recording, storage of clinical content, or generation. Your job is to attach behaviour to the hooks below.

Preview any state without the engine: `/app/?demo=list` (index), `/app/?demo=note`, `&pane=note`, `&theme=dark`, `&lang=id`. `web/assets/js/demo-states.js` is the best worked example of this contract: it renders every state by cloning the same templates you will use.

## Files

```
web/index.html                 landing page (static; works without JS)
web/app/index.html             workspace shell (every state is real markup)
web/assets/css/tokens.css      colour, type, space, radius, motion tokens; light + dark
web/assets/css/base.css        reset, focus, utilities (.sr-only, .icon, .no-js handling)
web/assets/css/components.css  buttons, fields, chips, callouts, dialog, drawer, toast, tooltip, menu, tabs
web/assets/css/landing.css     landing only
web/assets/css/app.css         workspace only (state selectors live here)
web/assets/js/theme-boot.js    classic script in <head>: applies saved theme/lang before paint, swaps no-js -> js
web/assets/js/theme.js         theme API
web/assets/js/i18n.js          t(), tn(), applyI18n(), setLang()
web/assets/js/strings/en.js    English strings (source of truth; markup carries the same text)
web/assets/js/strings/id.js    Bahasa Indonesia (same keys, same {placeholders})
web/assets/js/ui.js            dialog, confirm, toast, tooltip, tabs, menu, shortcuts, announce, cloneTemplate
web/assets/js/app-ui.js        workspace boot; presentational behaviour; exports helpers listed below
web/assets/js/landing.js       landing behaviour (nav, theme, specimen animation)
web/assets/js/demo-states.js   design-review harness, loaded only with ?demo= (local development only)
web/assets/icons/sprite.svg    icon sprite: <svg class="icon"><use href="/assets/icons/sprite.svg#i-NAME"/></svg>
web/assets/fonts/              Source Serif 4 + Atkinson Hyperlegible Next (WOFF2, latin) + OFL licence texts
web/assets/img/                favicon (svg/png), app icons, maskable icon, og-image.svg/.png
web/assets/manifest.webmanifest
```

Paths are absolute (`/assets/...`, `/app/`), so `web/` must be the site root (it is, in the current `dev-server.js` and `lib/build.js`).

## CSP rules you must keep

`script-src 'self'; style-src 'self'`. No inline `<script>`, no `style=""`, no `<style>`, no `onclick=`. To drive visuals from JS use `el.style.setProperty('--var', value)` (allowed) or attributes/classes. Existing custom properties meant for JS: `--level`/`--h` (level meter), `--value` (progress bar), `--x`/`--y` (tooltip, internal).

## Boot and events

`app-ui.js` is the page's only module entry. Import from it (it is a module, so importing again does not re-boot):

```js
import { openSettings, showConnectionView, showPane, setCaptureMethod, setOnboardingStep,
         revealEvidence, revealStatement, openFind, closeFind } from '/assets/js/app-ui.js';
import { openDialog, closeDialog, confirmDialog, toast, announce, cloneTemplate, setState,
         selectTab, registerShortcut, openMenu, closeMenus } from '/assets/js/ui.js';
import { t, tn, getLang, setLang, onLangChange, applyI18n } from '/assets/js/i18n.js';
import { getTheme, setTheme, toggleTheme, resolvedTheme, onThemeChange } from '/assets/js/theme.js';
```

The wiring is `web/assets/js/app/main.js`, loaded as a second module tag after `app-ui.js`. It keeps all state in one store (`app/store.js`, pure reducer) and sets `html[data-app="ready"]` once server-mode detection has finished. With `?demo=` in the URL the wiring stays idle so the design harness can render its states. The harness is served only in local development (`lib/publish.js` keeps it out of the production build); when it cannot be loaded, `app-ui.js` sets `html[data-demo-harness="missing"]`, fires `ui:demo-unavailable`, and the wiring starts normally.

Events the UI emits (all bubble; `detail` shown):

| Event | Target | detail | Notes |
| --- | --- | --- | --- |
| `ui:ready` | document | | after all UI listeners are installed |
| `ui:capture-method` | `#capture` | `{ method }` | `record`, `upload`, `paste` |
| `ui:file-drop` | `#dropzone` | `{ files: File[] }` | also listen to `change` on `#file-input` |
| `ui:speakers` | `#transcript` | `{ on }` | UI already toggled `data-speakers` |
| `ui:flag-resolved` | `.flag` | `{ id, resolved }` | UI already set `data-resolved` |
| `ui:connection-new` | `#connection-form` | | form was reset and view switched to `edit` |
| `ui:onboarding-step` | `#onboarding-dialog` | `{ from, to }` | **cancelable**: `preventDefault()` to block (e.g. key not tested) |
| `ui:tabchange` | the tablist | `{ tab, id, controls }` | any `[role=tablist]` |
| `ui:opened` / `ui:closed` | the `<dialog>` | `{ returnValue }` on close | |

Every `<form>` in the app has its default submission prevented (a GET would leak keys into the URL). The `submit` event still fires: handle `submit` on `#connection-form`, `#ob-connect-form`, `#set-access`.

## Global attributes

| Element | Attribute | Values | Effect |
| --- | --- | --- | --- |
| `html` | `data-theme` | absent (system), `light`, `dark` | set via `theme.js` only |
| `html` | `lang` | `en`, `id` | set via `setLang()` |
| `#workspace` | `data-stage` | `capture`, `transcript`, `note` | furthest stage reached; drives the header stepper |
| `#workspace` | `data-pane` | `source`, `note` | which pane shows below 960px; use `showPane()` |
| `#connection-chip` | `data-state` | `none`, `checking`, `ok`, `error`, `server`, `example` | set label in `#connection-chip-label` (`app.conn.*`) |
| `#unsupported` | `hidden` | | remove to show; fill `#unsupported-detail` with `t('app.unsupported.missing', {features})`; also hide `.app-header` and `#workspace` |

## Source pane

- `#btn-load-example`, `#btn-empty-example`, `#ob-choose-example`: load the fictional example. Show `#example-band` (remove `hidden`) while the example is loaded; set chip `example`; provenance `t('app.note.provenanceExample')`.
- `#btn-new-session` (hidden until there is content): confirm with `app.confirm.newSession.*`.

### Capture `#capture`

`data-state`: `idle | requesting | recording | paused | processing | error | denied`. `data-method`: `record | upload | paste` (use `setCaptureMethod()`, which also resets `error`/`denied` to `idle`). Children with `[data-show-when~=state]` appear automatically; method tabs hide during `requesting/recording/paused/processing`.

| Hook | Use |
| --- | --- |
| `#btn-record` | start (go to `requesting`, then `recording` or `denied`) |
| `#audio-language` | `auto`, `id`, `en` |
| `#rec-status-label` | `t('app.capture.recording')` / `t('app.capture.paused')` |
| `#rec-timer` | `mm:ss` text |
| `#rec-meter` | `style.setProperty('--level', 0..1)` for a simple meter, or per `.meter__bar` `--h` 0..1 for a waveform (32 bars) |
| `#rec-segment-hint` | optional, `t('app.capture.segmentHint', {min})` |
| `#btn-pause` | set its `data-state` to `pause` (shows Pause) or `resume` (shows Resume) |
| `#btn-stop`, `#btn-discard` | discard should confirm with `app.confirm.discard.*` |
| `#file-input`, `#dropzone[data-drag]` | UI handles drag visuals; you get `ui:file-drop` |
| `#upload-file` (hidden), `#upload-file-name`, `#upload-file-info`, `#btn-remove-file`, `#btn-transcribe-file` | selected-file row |
| `#paste-input`, `#btn-use-paste`, `#paste-count` | UI keeps the count and enabled state; you parse `Doctor:`/`Patient:` lines |
| `#proc-progress` (`aria-valuenow`), `#proc-progress-bar` (`--value` 0..100), `#proc-label` | e.g. `t('app.proc.segment', {i, n})` |
| `#btn-cancel-processing` | |
| `#capture-error-title`, `#capture-error-message`, `#btn-capture-retry` | error state; messages from `app.error.*` |
| `#btn-denied-retry` | denied state |

When a transcript exists, hide `#capture` (`hidden`) and show `#transcript`; set `data-stage="transcript"`.

### Transcript `#transcript`

`hidden` until there is a transcript. `data-mode`: `turns | plain`. `data-speakers`: `on | off` (UI toggles via `#toggle-speakers`).

- Turns: clone `#tpl-turn` into `#turns`. Set `li[data-turn-id]` (stable id the evidence refers to, e.g. `t3`), `li[data-speaker]` (`doctor|patient|other|unknown`), `.turn__num` (1-based display number), `.turn__speaker` value (keep `data-speaker` in sync on `change`), `.turn__time` text and remove its `hidden` if timestamps exist, `.turn__text` text. `.turn__text` is `contenteditable="plaintext-only"`: read with `textContent`, listen for `input`.
- Plain: `#transcript-plain` textarea.
- Find (`#btn-find`, Ctrl/Cmd+F) is implemented by the UI. It wraps hits in `<mark class="find-hit">` temporarily and removes them on close or on edit; `textContent` is unaffected.
- Meta: `#transcript-chars` (`tn('app.count.chars', n)`), `#transcript-duration` (`t('app.transcript.duration', {d})`, remove `hidden`), `#transcript-turn-count` (`tn('app.count.turns', n)`).
- Menu items: `#btn-add-turn`, `#btn-copy-transcript`, `#btn-edit-vocab` (opens settings), `#btn-clear-transcript`.
- Generate: `#btn-generate` (Ctrl/Cmd+Enter clicks it), `#quick-template`, `#quick-note-language`. All `select[data-template-select]` and `select[data-note-language-select]` should be kept in sync with the defaults. The note-language selects are empty in the markup; the wiring fills them with every engine language (`LANGUAGES`), labelled `app.lang.<code>`.

## Note pane `#note`

`data-state`: `empty | generating | ready | error`. `data-stale`: `true | false` (shows `#stale-banner` when ready and true). The draft band "Draft. A clinician must review..." is shown automatically for `generating` and `ready` and must not be removable.

| Hook | Use |
| --- | --- |
| `#note-template-badge` | template name, remove `hidden` |
| `#btn-export` (enable when ready), `[data-export="copy|markdown|text|docx|print"]` | export menu items; Ctrl/Cmd+Shift+C clicks `copy`. `print` can call `window.print()`: print CSS shows only the note |
| `#gen-status-text`, `#btn-cancel-generate` | `t('app.note.generating', {model})` |
| `#note-error-title`, `#note-error-message`, `#btn-generate-retry` | error state |
| `#btn-regenerate-all`, `#btn-stale-dismiss` | stale banner (confirm `app.confirm.regenerate.*` if the user edited) |
| `#flags-list` + `#tpl-flag`, `#flags-count`, `#flags-none`, `#pane-note-flags` | review flags; set `li[data-flag-id]`, `li[data-target-statement]`, `.flag__text`. "Show" scrolls to the statement (UI). Show `#flags-none` when the list is empty |
| `[data-statements="chief_complaint|subjective|objective|assessment|plan"]` + `#tpl-statement` | statement rows |
| `.note-section[data-section][data-state="idle|regenerating"]`, `[data-action="regenerate-section"]` | per-section rewrite; use `t('app.section.regenerating', {section})` for announcements |
| `[data-action="add-statement"]`, `[data-action="remove-statement"]` | add/remove lines |
| `#note-stats` | `t('app.note.stats', { statements: tn('app.count.statements', n), linked, unverified })` |
| `#note-provenance` | `t('app.note.provenance', {time, model, provider, template, language})` |

Statement row (`#tpl-statement`): set `li[data-statement-id]`, `li[data-grounding]` = `grounded | approximate | edited | clinician | unverified | none` (approximate and edited show both the link chip and the review chip; clinician shows only the review chip in a neutral style; the wiring sets the review chip's label, `aria-label` and icon per status from `note.<status>` / `note.<status>Long`), `li[data-evidence]` = space-separated turn ids (`"t2 t3"`), the chip's `data-evidence` (same), `.ev-chip__refs` text = display numbers (`"2, 3"`), optional chip `data-tooltip` (e.g. `"Patient, 2"`), `.statement__text` text (contenteditable plaintext-only). The UI then handles hover/focus highlighting of the source turns, chip click (scroll + flash, and on phones switches to the transcript with a "Back to draft" toast), and screen-reader announcement. Use `revealEvidence(li)` / `revealStatement(id)` programmatically.

## Dialogs

All are native `<dialog>` opened modally via `openDialog(id)`. Any `[data-open-dialog=id]` opens and any `[data-close-dialog]` closes; backdrop click and Esc close. Focus returns to the opener.

### Onboarding `#onboarding-dialog`

`data-step` `1|2|3`; use `setOnboardingStep(n)` (Back/Continue are wired; listen to the cancelable `ui:onboarding-step`). Step 1: `input[name="ob-preset"]`, `#ob-key` (+ show/hide), `#ob-key-link` (set `href` to the preset's `keyUrl`, hide when null), `#ob-test-result[data-state]` + `#ob-btn-test` + `#ob-test-message`. Step 2: `#ob-model-transcription`, `#ob-model-note` (plain selects). Step 3: `#ob-choose-example`, `#ob-choose-capture`. `#ob-skip`. Deciding when to show it (first run) is yours.

### Settings `#settings-dialog`

Open with `openSettings(section)` or any `[data-open-settings=section]`: `general | connections | models | defaults | privacy | access`. Tabs `[data-settings-tab]`; the `access` tab `#set-tab-access` and panel `#set-access` are `hidden` until the server requires a token (also show `#server-mode-note`).

- General: theme radios `name="theme"` and language radios `name="ui-lang"` are fully handled by the UI.
- Connections `#set-connections[data-view="list|edit"]` (use `showConnectionView()`). List: clone `#tpl-connection` into `#connections-list` (`li[data-connection-id]`, `li[data-status="ok|error|untested"]`, `.conn-item__name`, `.conn-item__detail`, `.conn-item__status` text from `app.conn.status*`, buttons `[data-action="edit-connection|remove-connection"]`). `#connections-empty` hides itself when the list has children. `#btn-add-connection` resets the form and opens the edit view (UI); `#btn-conn-back`/`#btn-conn-cancel` return to the list (UI). Edit form `#connection-form`: `input[name="conn-preset"]` (values match `web/core/providers.js` ids: `openai, anthropic, gemini, openrouter, groq, mistral, deepgram, elevenlabs, local, custom`; `#tpl-preset` lets you rebuild the grid from `PROVIDERS` instead), `#conn-form-title` (`app.conn.addTitle` / `app.conn.editTitle`), `#conn-name`, `#conn-key-field` (hide when `keyRequired` is false), `#conn-key`, `#conn-key-link`, `#conn-key-error` (+ `aria-invalid` on the input), `#conn-remember-field` with `name="conn-remember"` `session|device`, `#conn-base-url-field` (show when `customBaseUrl`), `#conn-base-url`, `#conn-privacy-text` (`app.conn.privacyCloud` or `app.conn.privacyLocal`), `#conn-test-result[data-state="idle|testing|ok|error"]` + `#btn-test-connection` + `#conn-test-message` (`app.conn.testOk`, `app.conn.testOkNoList`, `app.conn.testFail`), `#btn-conn-remove` (hidden for new), `#btn-conn-save` (type submit).
- Models: two pickers `#picker-transcription`, `#picker-note` with `data-state="idle|loading|ready|error|manual"`. Each has a connection select (`#model-*-conn`), an ARIA combobox input (`#model-*-input`, toggle `aria-expanded`, set `aria-activedescendant`), a listbox (`#model-*-list`, remove `hidden`; clone `#tpl-model-option`, give each a unique `id`, set `data-model-id`, `.combo__option-id`, `.combo__option-meta`, `aria-selected`), status `#model-*-status`, error `#model-*-error`, and links `[data-action="refresh-models|manual-model"]`. Keyboard behaviour of the combobox (arrows, Enter, Esc) is yours. In `manual` state the input simply accepts any ID.
- Defaults: `#pref-note-language`, `#pref-template`, `#pref-speakers`, `#pref-vocab`.
- Privacy: `#pref-history` (off by default), `#pref-autodelete` (`1|7|30|0` days; set `aria-disabled="true"` on `#pref-autodelete-field` while history is off), `#storage-sessions`, `#storage-keys`, `#btn-delete-all` (confirm with `app.confirm.deleteAll.*`, tone `danger`).
- Access: `#access-token` (+ show/hide), `#access-test-result[data-state]`, `#btn-access-save`, `#access-test-message`.

### History `#history-drawer`

`data-state`: `off | empty | list`. Clone `#tpl-history-item` into `#history-list` (`li[data-session-id]`, `.history-item__title`, `.history-item__meta` via `t('app.history.metaLine', {date, duration, template})`, add `.is-current` for the open session, buttons `[data-action="open-session|delete-session"]`). Search `#history-search` filters rendered rows (UI). `#history-retention` text: `app.history.retention` / `retentionDay` / `retentionNever`. `#btn-history-delete-all`.

### Others

`#shortcuts-dialog` (static), `#confirm-dialog` (use `confirmDialog()`), `#toast-region`, `#tooltip`, `#sr-status`, `#sr-alert`.

## Primitive APIs (`ui.js`)

- `openDialog(idOrEl, { onClose(returnValue), focus: selector })`, `closeDialog(idOrEl, returnValue)`.
- `confirmDialog({ title, message, confirmLabel, cancelLabel, tone: 'default'|'danger' }) -> Promise<boolean>`.
- `toast(message, { tone: 'info'|'success'|'warning'|'error', duration, action: { label, onClick } }) -> { dismiss }`. Errors persist until dismissed unless you pass `duration`. Name the action after the result ("Copy" -> "Draft copied").
- `announce(message, { assertive })` writes to the live regions.
- Tooltips: add `data-tooltip` (empty = use `aria-label`) and optional `data-shortcut`.
- `selectTab(tabEl, { focus })`. Add `data-tabs-manual` to a tablist if panels should not be auto-hidden.
- Menus: a trigger with `data-menu-trigger aria-controls=menuId aria-expanded`, a `.menu[role=menu][hidden]` with `[role=menuitem]` children. `openMenu(trigger)`, `closeMenus()`.
- Password toggles: `[data-toggle-password=inputId]`.
- `registerShortcut(combo, handler, { allowInInputs, when }) -> unregister`. Combos like `mod+enter`, `alt+1`, `?`, `h`. Already registered: `?`, `h`, `,`, `alt+1`, `alt+2`, `mod+f`, `r` (clicks `#btn-record`/`#btn-stop`), `space` (clicks `#btn-pause` while recording), `mod+enter` (`#btn-generate`), `mod+shift+c` (copy). Shortcuts click the visible, enabled button, so your click handlers cover them.
- `cloneTemplate(id) -> HTMLElement`, `setState(idOrEl, state)`.

## i18n

- `t(key, vars)`, `tn(key, n, vars)` (uses `key.one` / `key.other`), `setLang('en'|'id')`, `getLang()`, `onLangChange(fn)`, `applyI18n(root)`.
- Static text: `data-i18n="key"` on a leaf element (sets `textContent`), `data-i18n-attr="aria-label:key,placeholder:key2"` for attributes. Call `applyI18n(clone)` after inserting cloned templates (they contain keys).
- Dynamic text you set (labels with numbers, provider names) must be re-rendered in `onLangChange`.
- Add keys to **both** `en.js` and `id.js`; keep `{placeholders}` identical. Markup English must equal `en.js`.
- UI preferences persist in `localStorage` keys `scribe.ui.theme` and `scribe.ui.lang` (UI-only, not clinical data). "Delete everything" should clear them too.

Key groups (see `strings/en.js` for text): `common.*`, `soap.*` (section names), `templates.*`, `note.*` (evidence chip labels), `landing.*`, `app.capture.*`, `app.proc.*`, `app.captureError.*`, `app.denied.*`, `app.upload.*`, `app.paste.*`, `app.transcript.*`, `app.find.*`, `app.note.*`, `app.noteError.*`, `app.stale.*`, `app.flags.*`, `app.section.*`, `app.export.*`, `app.example.*`, `app.session.*`, `app.conn.*`, `app.models.*`, `app.defaults.*`, `app.privacy.*`, `app.access.*`, `app.history.*`, `app.ob.*`, `app.settings.*`, `app.general.*`, `app.help.*`, `app.keys.*`, `app.toast.*`, `app.confirm.*`, `app.error.*`, `app.count.*`, `app.unsupported.*`.

JS-only keys prepared for you (with placeholders): `app.conn.checking`, `app.conn.connected {name}`, `app.conn.error`, `app.conn.server`, `app.conn.example`, `app.conn.editTitle`, `app.conn.testing`, `app.conn.testOk {n}`, `app.conn.testOkNoList`, `app.conn.testFail {reason}`, `app.conn.status{Ok,Error,Untested}`, `app.conn.privacyLocal`, `app.conn.keyRequired`, `app.conn.urlInvalid`, `app.capture.paused`, `app.capture.segmentHint {min}`, `app.proc.{preparing,finishing}`, `app.proc.segment {i}{n}`, `app.note.generating {model}`, `app.note.stats {statements}{linked}{unverified}`, `app.note.provenance {time}{model}{provider}{template}{language}`, `app.note.provenanceExample`, `app.note.staleExport` (put this line in stale exports), `app.section.regenerating {section}`, `app.flags.count.{one,other} {n}`, `app.models.{loadingFrom,error} {name}`, `app.models.count {n}`, `app.models.noConnection`, `app.models.manualHint`, `app.history.retention {days}`, `app.history.retentionDay`, `app.history.retentionNever`, `app.history.metaLine {date}{duration}{template}`, `app.toast.{copied,connSaved,connRemoved,deletedAll,sessionDeleted,sessionSaved,exampleLoaded,transcriptCopied}`, `app.toast.exported {file}`, `app.confirm.{deleteAll,deleteSession,removeConnection,discard,newSession,regenerate}.{title,message,ok}` (`removeConnection.title` takes `{name}`), `app.error.{network,auth,rateLimit,model,tooLarge,format,cors,output,mic}`, `app.count.{chars,turns,statements}.{one,other}`, `app.unsupported.missing {features}`, `common.{confirm,dismiss,delete,undo,save,done}`.

## Non-obvious details

- The real fictional example lives in `app/example.js` (English and Bahasa Indonesia, following the interface language); `demo-states.js` keeps its own English sample for design review.
- The connection key field is `type=password` with `autocomplete="off"`; never write keys into URLs, logs or `data-*` attributes.
- `.statement__remove`, `.add-line` and the section rewrite button only appear on hover/focus on pointer devices, and on focus on phones.
- Below 960px only one pane shows; after generating a draft call `showPane('note')`. The pane-switch badge `#pane-note-flags` shows the open flag count.
- Print stylesheet hides everything except the note and keeps the draft band.
- Landing CTAs link to `/app/?example=1` (load the fictional example on arrival) and `/app/`.
- Landing and workspace carry `rel=canonical`, `og:url` and an absolute `og:image` on `https://medicalaiscribe.vercel.app`.

## Reconciled with the engine, and hooks added by the wiring

- Template values are the engine's `TEMPLATES` ids: `general, neurology, emergency, internal_medicine, pediatrics, psychiatry, follow_up` (the shell had `internal` and no follow-up). Every `select[data-template-select]` is rebuilt from them; labels are `templates.*` (`templates.internal`, `templates.followUp`).
- Engine errors map to `app.err.<code>` (one key per `ERROR_CODES` entry, plus `app.err.corsLocal`, `corsCustom`, `rate_limit_wait`, `endpointNotFound` and app-level codes in `app/messages.js`). The older `app.error.*` keys remain for `demo-states.js` only. `error.message` is never shown.
- Transcript: `#speaker-source` / `#speaker-source-text` (notice when labels are AI-suggested or diarized without roles), `#btn-suggest-speakers` (menu item, optional AI labelling of unlabelled text), `.turn[data-ai-speaker="true"]` (a role suggested by AI), `.turn__time` also shows the diarized speaker ("Speaker A").
- Note: `#note-stream` (sections fill in while streaming; the skeleton hides once content arrives), `[data-action="copy-section"]` in each section head, `.ev-chip--number` (check-number marker built by the wiring), `.statement.is-cited` (statements citing the hovered or focused turn), and `::highlight(scribe-evidence)` for the exact supporting words inside a turn (CSS Custom Highlight API; browsers without it still get the whole-turn highlight). While a section is rewritten its rewrite button gets `data-regenerating="true"` and cancels the rewrite when pressed again.
- Settings: `#conn-test-hint` (why a provider cannot be tested, e.g. Deepgram), `#pref-history-unavailable` (no IndexedDB), `#storage-blocked` (storage blocked; values kept in memory). Onboarding: `#ob-base-url-field` / `#ob-base-url` (local and custom endpoints), `#ob-key-field`, `#ob-privacy`.
- Printing uses a hidden `iframe.print-frame` loading a `blob:` document that links `/core/export/print.css` by absolute URL.
