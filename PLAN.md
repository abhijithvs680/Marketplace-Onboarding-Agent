# Marketplace Onboarding Agent — build plan

A task brief for a Claude cloud agent. It covers four things, in this order:

1. **Part A** — create four spreadsheets on the Vizru platform
2. **Part B** — create and fix the workflows that read and write them
3. **Part C** — rewire this React app to the new workflows
4. **Part D** — fix the UI alignment so the console fits the viewport

Parts A and B need a signed-in browser session on the platform. Part C and D
are code in this repository and can be done without it.

---

## 0. Context

**What this repository is.** A React 18 + Vite + TypeScript client for the
Vizru workflow `marketplaceonboardagent6aca3281a3e51` — a dental-marketplace
vendor onboarding agent, presented as a corporate application: a welcome
screen, an onboarding console (stage rail, conversation, live submission
panel), and a review page. `README.md` documents the platform contract in
detail; read it before changing `src/vizru.ts`.

**The platform.** Vizru is a multi-tenant PHP platform whose two durable
primitives are *workflows* (a directed graph of blocks in MongoDB) and
*spreadsheets* (a header document plus one row document per row). A workflow
whose first block is a trigger block is callable over HTTP at
`POST /workflow.trigger/<shortCode>`.

**Hosts.**

| Thing | Where |
|---|---|
| Platform (where the workflow runs) | `https://innov-dev.beta.injomo.com` |
| Workflow editor — **create workflows here** | `https://innov-dev.beta.injomo.com/workflow.html` |
| Spreadsheet templates — **create spreadsheets here** | `https://innov-dev.beta.injomo.com/#ls/livespace.html/templates?_ls=2170-3111` |
| This app in dev | `http://localhost:3000` (port is load-bearing, see below) |

**Existing workflows.**

| Short code | Name | State |
|---|---|---|
| `marketplaceonboardagent6aca3281a3e51` | MarketPlaceOnboard_Agent | Working. Entry (`genericpost`, `auth_required: "0"`) → Agent Node (gemini-3.5-flash, `memory: true`, `thread_id = {Entry.session_id}`, `stream: false`) |
| `marketplaceonboardsaveinformation6aca3328c7c44` | MarketPlaceOnboard_SaveInformation | **Broken.** Exposed to the agent as the tool `create_vendor`. Every call logs `Invalid SpreadsheetId` then `Internal Server Error … SpreadsheetOperationsBlock.php Line: 285`, twice per turn. No vendor is being saved. |

**The problem this plan solves.** The agent returns prose and nothing else, so
the stage rail, the "Your submission" checklist, the reference number and the
submitted state have no real source. The app currently fills them from an
agent-emitted marker block (`[[vizru]] … [[/vizru]]`, see
`src/submission.ts`) — an honest stopgap that Part C deletes once the platform
can answer "what is the state of this application?".

**Design reference.** `design/` holds the four artboards from the design canvas
(welcome, console, review, console-on-phone). They are Design Component files:
they will not render standalone because `support.js` is only served by the
canvas host, but the markup, inline styles and copy are the spec that
`src/` implements. Treat them as read-only reference.

---

## Part A — spreadsheets

Create these at
`https://innov-dev.beta.injomo.com/#ls/livespace.html/templates?_ls=2170-3111`.

**Record each sheet's short code as you create it** — Part B references sheets
by short code, never by Mongo id. See the "Rules that will bite you" section
for why.

### A1. `Vendors` — one row per company

| Column label | Datatype | Notes |
|---|---|---|
| `VendorId` | text | **Promote to an indexed column.** Every other sheet joins on it |
| `LegalEntity` | text | |
| `TradingAddress` | text | |
| `PrimaryContactName` | text | |
| `PrimaryContactEmail` | text | |
| `CommercialContactEmail` | text | |
| `Status` | text | `draft` \| `submitted` \| `in_validation` \| `live` \| `rejected` |
| `CreatedAt` | date | |
| `UpdatedAt` | date | |

### A2. `VendorOnboardingSessions` — one row per conversation

This sheet is the spine of the UI: the stage rail and the review page read it.

| Column label | Datatype | Notes |
|---|---|---|
| `SessionId` | text | **indexed.** The agent's `thread_id`; the UUID this app mints |
| `Reference` | text | **indexed.** The human reference shown on the review page |
| `VendorId` | text | **indexed.** Empty until `add_vendor` has run |
| `Stage` | text | `company` \| `product` \| `integration` \| `review` |
| `Status` | text | `draft` \| `submitted` |
| `LastTurnAt` | date | |
| `SubmittedAt` | date | |

Three indexed columns of the five allowed per sheet; leave the other two free.

### A3. `VendorFeatures` — one row per capability

| Column label | Datatype | Notes |
|---|---|---|
| `VendorId` | text | **indexed** |
| `Feature` | text | e.g. "Intraoral scanning" |
| `Description` | text | |
| `Category` | text | optional |

A child sheet rather than columns on `Vendors`, because
`update_vendor_feature` carries a list and the design renders them as chips.

### A4. `VendorApiInfo` — one row per environment

| Column label | Datatype | Notes |
|---|---|---|
| `VendorId` | text | **indexed** |
| `Environment` | text | `sandbox` \| `production` |
| `BaseUrl` | text | |
| `AuthMethod` | text | e.g. "OAuth 2.0 client credentials" |
| `DocsUrl` | text | |
| `TechnicalContact` | text | |

**Never store credentials here.** The welcome screen promises that sandbox
credentials are requested later over a secure channel; keep that promise.

### A5. `VendorOnboardingEvents` *(optional, recommended)*

`SessionId` (indexed), `At` (date), `Action`, `Payload`. One row per tool call.
The first time someone asks "what did the agent actually save?", this is the
answer.

---

## Part B — workflows

Create at `https://innov-dev.beta.injomo.com/workflow.html`. Workflow names are
unique per tenant; a duplicate is refused with "Stencil name already exist".

### B1. Fix `MarketPlaceOnboard_SaveInformation` *(existing — repair)*

It is one spreadsheet block holding a dead sheet id. Rebuild it as an action
router over the sheets from Part A:

```
Entry (genericpost)
  → condition   message: {Entry.action} == "add_vendor"
      yes → setvariable            VendorId = {%uniqid%} (or ssautoincrementcol on Vendors)
          → insertssdata           Vendors
          → insertorupdatessdata   VendorOnboardingSessions   filters: SessionId = {Entry.session_id}
          → customoutput           json: {"ok": true, "vendor_id": "{VendorId}"}
      no  → condition   message: {Entry.action} == "update_vendor_feature"
              yes → bulkinsertssdata      VendorFeatures
                  → customoutput          json: {"ok": true, "saved": "features"}
              no  → insertorupdatessdata  VendorApiInfo   filters: VendorId = {Entry.vendor_id}, Environment = sandbox
                  → customoutput          json: {"ok": true, "saved": "api_info"}
```

Three changes that matter beyond the broken id:

- **Select every sheet by `ss_short_code` with `dynamic_flag: "true"`**, not by
  the `ssid` picker. A short code survives moving between environments; a Mongo
  id does not, and that is exactly the present failure.
- **End every branch in a `customoutput`** (`outputDataType: json`). Today a
  failing block echoes `<div class="alert">Workflow Error</div>…` into the
  response *before* the JSON, which this app has to salvage around
  (`extractPayload` in `src/vizru.ts`). Fix it at the source.
- **Set the tool's `result_mode` to `first_row`**, not `full`. `full` feeds
  every returned row back into the model and burns the run's token budget.

### B2. `MarketPlaceOnboard_GetApplication` *(new — build this first after B1)*

The highest-value workflow in the plan: it is what makes the stage rail, the
submission panel and the review page truthful.

```
Entry (genericpost: session_id, optionally reference)
  → ssdatafilter  VendorOnboardingSessions   filters: SessionId = {Entry.session_id}
  → ssdatafilter  Vendors                    filters: VendorId  = {Session.VendorId}
  → ssdatafilter  VendorFeatures             filters: VendorId  = {Session.VendorId}
  → ssdatafilter  VendorApiInfo              filters: VendorId  = {Session.VendorId}
  → customoutput  json
```

The response shape Part C expects — keep it exactly:

```json
{
  "ok": true,
  "reference": "VZ-00042",
  "status": "draft",
  "stage": "product",
  "vendor": {
    "vendor_id": "…",
    "legal_entity": "Molaris Dental Imaging Ltd",
    "primary_contact": "Integration lead"
  },
  "features": [{ "feature": "Intraoral scanning", "description": "" }],
  "api": [{ "environment": "sandbox", "base_url": "…", "auth_method": "…" }]
}
```

An unknown `session_id` must return `{"ok": true, "status": "new"}` with HTTP
200, not an error — the client calls this before the first turn.

Set `auth_required: "0"` on the entry block: the client calls it from the
browser with no credential, exactly like the agent workflow.

### B3. `MarketPlaceOnboard_StartSession` *(new, small)*

Called when the vendor presses "Start the application".

```
Entry (genericpost: session_id)
  → ssautoincrementcol    (mint the reference number — safe for sequences)
  → insertorupdatessdata  VendorOnboardingSessions  filters: SessionId = {Entry.session_id}
                          Stage = company, Status = draft
  → customoutput          json: {"ok": true, "reference": "…"}
```

### B4. `MarketPlaceOnboard_SubmitApplication` *(new)*

Register as a **second agent tool** named `submit_application` so submitting
stays conversational; the client only reflects the resulting status.

```
Entry → condition (are all required fields present?)
   no  → customoutput json: {"ok": false, "missing": ["api_base_url", …]}
   yes → updatessdata VendorOnboardingSessions  Status = submitted, SubmittedAt = {date}
       → updatessdata Vendors                   Status = submitted
       → backgroundworkflow → B5
       → customoutput json: {"ok": true, "reference": "…"}
```

On `ok: false` the agent asks for what is missing — that is the whole point of
routing submission through the model rather than a button.

### B5. `MarketPlaceOnboard_NotifyPartnerships` *(new, background)*

`sendmail` to the partnerships inbox plus a confirmation to the vendor. Invoke
it from B4 via `backgroundworkflow` so the agent's HTTP turn does not wait on
SMTP.

### B6. `MarketPlaceOnboard_ReminderSweep` *(optional, scheduled)*

Filter drafts untouched for N days, email the resume link. This is the promise
the "Pause and come back" card makes.

### B7. Update `MarketPlaceOnboard_Agent`

- Rewrite `system_prompt` around the four stages (company → product →
  integration → review) so the agent asks in the order the stage rail displays.
- Register `submit_application` (B4) alongside `create_vendor` in
  `skill_workflow_config`.
- Once B2 is live, **remove any instruction to emit the `[[vizru]]` marker
  block** (see README). The read workflow replaces it.
- **Never put JSON braces in `system_prompt`.** The engine interpolates `{…}`
  and deletes whatever it cannot resolve, so a JSON example there reaches the
  model mangled. Structured data travels as tool parameters.

### B8. Record the short codes

Write every new short code into `.env.example` and `README.md` as you go. Part
C needs them.

---

## Part C — React app changes

### C1. New client functions in `src/vizru.ts`

Generalise the existing `runOnboardingAgent` into a shared `callWorkflow(shortCode, body)`
that keeps the current behaviour — `Content-Type` as the only header, the
`extractPayload` salvage, the status-code mapping — and add:

```ts
startSession(sessionId): Promise<{ reference: string }>
getApplication(sessionId): Promise<ApplicationState>
```

Read these short codes from `import.meta.env`, with the new variables added to
`.env.example`:

```
VITE_VIZRU_WORKFLOW_START=…
VITE_VIZRU_WORKFLOW_GET=…
```

### C2. Make the submission panel server-driven

- On "Start the application" → `startSession()`, store the reference.
- After every agent turn, and once on load → `getApplication()`; map the
  response into the existing `SubmissionRecord` shape.
- `src/submission.ts` keeps `FIELDS`, `STAGES`, `progressOf`, `isComplete` and
  `summaryText` unchanged — only the *source* of `captured` changes.
- **Delete** `parseAgentReply`, `mergeRecord`, the `[[vizru]]`/fence regexes and
  their tests, and the marker instructions from the README.
- The "Added to your submission" card now renders the diff between the previous
  and current `getApplication()` result for that turn.
- Show the real `reference` on the review page in place of the derived
  `sessionId.slice(0, 8)`.

### C3. Keep what already works

Do not regress these; each was verified against the live platform:

- Port 3000 with `strictPort`. `Trigger.php` hard-codes its CORS allow-list to
  `http://localhost:3000`, `https://baines.healthcare` and `*.vizru-ras.com`.
  A non-matching origin gets **no** CORS headers and the browser drops the reply.
- `Content-Type` is the only header sent. `X-Requested-With` is not in the
  trigger's `Access-Control-Allow-Headers` and fails the preflight.
- A 200 does not mean success: a thrown workflow returns 200 with the body
  `Internal Server Error`.
- `session_id` must stay stable for a conversation — it is the agent's
  `thread_id` and its memory key.
- Agent replies are markdown; `src/components/RichText.tsx` renders a safe
  subset as React nodes. Never `dangerouslySetInnerHTML`.

---

## Part D — UI alignment, and no page scrolling

**Goal: on the console at 1280×800 and above, the whole interface is visible
without scrolling the page.** Only the message thread scrolls, inside its own
card. Verify with `document.documentElement.scrollHeight <= window.innerHeight`.

### D1. Make the shell a fixed-height layout

Today `.app` is `min-height: 100vh` and the view simply stacks: header, stage
bar, a console row whose right-hand column holds three cards, then the footer.
The right column and the footer push past the fold, so the page scrolls *and*
the thread scrolls — two scrollbars, which is the core complaint.

Change it to one viewport-height shell with internal scroll regions:

- `.app` → `height: 100dvh; overflow: hidden`
- `.page` → `flex: 1; min-height: 0; overflow: hidden`
- `.console` → fills the remaining height; both columns `min-height: 0`
- `.thread-card` → `height: 100%`, with `.thread` as `flex: 1; min-height: 0;
  overflow-y: auto` — **remove the arbitrary `max-height: 58vh`**
- `.side` → `height: 100%; overflow-y: auto` so a short window degrades to one
  internal scrollbar rather than a page scroll

`min-height: 0` on every flex ancestor is what actually makes an inner
`overflow-y: auto` work; without it the child refuses to shrink.

### D2. Specific alignment defects to fix

- **Mixed horizontal padding.** `.card-head` uses 20/24px, `.thread` 24px,
  `.composer` 24px, `.fields` 20px. Pick one scale and apply it so the card
  head, messages and composer share a left edge.
- **The thread scrollbar overlaps the right padding**, so messages sit tighter
  on the right than the left. Add `scrollbar-gutter: stable` or pad for it.
- **`.suggestions` has `margin-left: 45px`** hardcoded to clear the speaker
  avatar. Derive it from the avatar width + gap, or move the chips inside the
  turn body.
- **Header avatar shows a literal "–"** when no vendor is known (visible in the
  current build next to "New application"). Render a neutral icon, or omit the
  avatar until a vendor exists.
- **The stage rail wraps awkwardly between ~860 and ~1100px** — "Step 1 of 4"
  drops to its own line and the four stages reflow unevenly. Give the rail a
  grid with a fixed trailing column, or move the counter above the rail.
- **The footer costs ~50px on the console** and is the main reason the page
  overflows. Make it slim on the console view, or drop it there and keep it on
  welcome and review.
- **Side-panel cards are too tall** — "Pause and come back" and "Need a person?"
  fall below the fold. Tighten padding and type so all three fit at 800px.

### D3. The other two views

- **Welcome**: the 44px headline plus the three step cards overflow at 900px
  height. Reduce the headline and the vertical gaps so it fits, or let the
  content area scroll internally while the header stays fixed.
- **Review**: the three submission cards plus the timeline should fit at
  1280×800; if not, scroll the main column internally, not the page.

### D4. Do not regress

- 44px minimum touch targets, visible `:focus-visible` rings, real `<button>` /
  `<label>` / `<textarea>` elements.
- The phone layout at 375×812 (compact stage line with the meter, single
  column, composer above the panel).
- Light-theme tokens in `src/styles.css`: IBM Plex Sans/Mono, deep teal
  `#0D5B52`, surfaces `#FFFFFF` on `#F5F6F8`.

---

## Rules that will bite you

1. **Select sheets by short code, not by id.** `ss_short_code` +
   `dynamic_flag: "true"`. A stale Mongo `ssid` is the live bug today.
2. **Spreadsheet block `filters` are keyed by column *label*.** Storage keys for
   columns past the third are MD5 hashes — never write a hash into a filter.
3. **Promote `SessionId`, `Reference` and `VendorId` to indexed columns before
   there is data.** Maximum five per sheet, and the key becomes
   `indexColumnNo01`…`05` in storage.
4. **`enable_log` is inverted.** `enable_log = 1` means logging *off*, and new
   workflows are created that way. Set it to `0` while building.
5. **The engine deletes `{braces}` it cannot resolve** — in prompts and in
   parameters alike.
6. **Workflow names are unique per tenant.**
7. **For SQL / MCP reads** (`relationalfilter`, the `ss_*` Postgres mirrors),
   `Autosync` must be enabled in each sheet's general settings. It is off by
   default here. The Mongo-backed `ssdatafilter` path in this plan does not need
   it.

---

## Definition of done

- [ ] Four sheets exist, with the indexed columns set, and their short codes are
      recorded in `.env.example` and `README.md`
- [ ] `create_vendor` completes without `Invalid SpreadsheetId`, and a row
      appears in `Vendors` — check the browser console for the
      `[vizru] the workflow emitted an error before its JSON` warning: it must
      no longer appear
- [ ] `GetApplication` returns the documented JSON for a known session and
      `{"ok": true, "status": "new"}` for an unknown one
- [ ] The submission panel and stage rail move as the conversation progresses,
      fed by `GetApplication`, with no `[[vizru]]` marker anywhere in the
      codebase
- [ ] The review page shows the real reference, and the submitted banner appears
      after `submit_application`
- [ ] At 1280×800 the console needs no page scroll; only the thread scrolls
- [ ] 375×812 still works
- [ ] `npm run build` and `npx tsc --noEmit` are clean

## Running it

```bash
npm install
npm run dev
```

`http://localhost:3000` — keep that port, see Part C3. `.env` holds
`VITE_VIZRU_BASE_URL=https://innov-dev.beta.injomo.com/`, which is where the
workflow lives; leave it empty to route through the Vite dev proxy at
`VIZRU_PLATFORM_URL` instead.
