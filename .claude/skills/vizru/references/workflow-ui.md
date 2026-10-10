# Workflow-UI — the React workflow studio

`receiver/volumes/web/react-source/Workflow-UI/` — React 18 + Vite + TypeScript +
React Flow 11 + dagre. Built as **static files only**: it reuses the production
platform's existing controllers and workflow JSON format, and adds no PHP.

Package name `vizru-workflow-debugger`. Intended to be served from
`v1-web-app/workflows/` (but see [the path discrepancy](#the-deploy-path-and-the-build-base-disagree--check-before-you-ship)),
whose `.htaccess` sends anything that is not a real file to `dist/index.html`:

```apache
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule ^.*$ dist/index.html [L]
DirectoryIndex dist/index.html
```

So the served document lives one level down and every asset URL is absolute
against `/workflows/dist/` (`BUILD_BASE` in `vite.config.ts`). Routing is
hash-based, which the rewrite never sees.

## Routes

```
/workflows/#/list                            the workflow list
/workflows/#/debugger/<id-or-shortCode>      the canvas
/workflows/#/debugger/<id>?version=<vid>     read-only canvas for a saved version
```

`src/lib/routes.ts`. `APP_PATH` is `/app/workflows/`; `#/list` is the landing
route when the hash is empty.

Auth is the **platform session cookie** — open it in a browser already signed in.
Every request is same-origin and carries no CSRF token.

## Bootstrap — why it fetches HTML pages

Production has no `/workflow.studio` controller and no JSON graph endpoint, so
`src/api/bootstrap.ts` assembles the boot payload from three pages the classic
canvas already requests:

| Request | Yields |
|---|---|
| `GET /workflow.debugger/{idOrShortCode}` | resolved Mongo id, name, short code, the palette (`window.w_leftBlockArray`) |
| `GET /workflow.debugger/{workflowId}/isChild/` | blocks (position, type, icon, label, description) and connections, scraped from `content.tpl` |
| `GET /workflow.settings/{shortCode}/json` | full `w_objects` including `block_properties` (optional — degrades only the "configured" badge) |

The first two also **re-seed the PHP `workflow` session**, which every
`/workflow.savesession` write depends on. That side effect is the reason it
fetches pages rather than something leaner. **Posting to the session before
bootstrap silently creates a partial session entry.**

## The save protocol

Two phases, exactly as the classic jsPlumb canvas does it, so a workflow edited
in either opens correctly in the other:

1. Every edit posts an event to **`POST /workflow.savesession`**, mutating
   `session('workflow')[workflowId]`.
2. **`POST /workflow.save`** commits that session to Mongo.

`src/api/session.ts` wraps each event:

| `eventType` | Params |
|---|---|
| `objectInsert` | `blockId`, `id` (= objId), `function_type`, `iconPath`, `xPos`, `yPos`; plus `blockOptr=clone`, `blockParent`, `clone_wf_id` to copy a block |
| `objectDelete` | `blockId` |
| `objectDrag` | `blockId`, `xPos`, `yPos` |
| `objectDragBulk` | `blocks` = JSON `[{blockId, xPos, yPos}]` |
| `connectionInsert` | `source`, `target`, `con_id`, `condition_type` (`''`\|`yes`\|`no`) |
| `connectionDelete` | `con_id` |
| `blkNameUpdate` | `sourceId`, `label` |
| `changeBlockIcon` | `blockId`, `iconPath` |
| `customblockPropInsert` | `sourceId`, `blockType`, **plus every block property as a top-level field** |
| `connectionPropInsert` | `sourceId`, `targetId`, `connection_action` (`SENDMAIL`\|`READ`), plus the mapping fields |

All take `workflow_id`. `con_id` is always `` `${source}-${target}` ``.

`POST /workflow.save` takes `workflow_id`, `name`, `ajaxwrkflwIds` (the open
canvases in the classic multi-tab layout; a standalone canvas sends just its own
id). Requires permission **1007**.

## Two invariants

**Coordinates are swapped.** The session stores `xPos` as CSS *top* and `yPos`
as CSS *left*. React Flow uses `{x: left, y: top}`, so `RF.x = yPos` and
`RF.y = xPos`. The conversion exists in exactly one place,
`src/graph/convert.ts`. Getting it wrong transposes whole diagrams.

**`customblockPropInsert` replaces, it does not merge.** Any `block_properties`
key not echoed back is deleted. `BlockSettingsDialog` therefore seeds every save
from the stored document and overlays the form on top, so unknown or
not-yet-ported keys survive untouched.

## Block settings

Every dialog is native React — no legacy Smarty markup is injected. Forms are
declared in `src/components/settings/registry.ts` against the **platform's own
input names**, taken from each block's `.tpl` under
`ui-themes/karma/templates/sys/controllers/workflow/blocks/`. That name match is
the whole compatibility contract: a block configured here is byte-identical to
one configured in the classic dialog.

A verified example (Spreadsheet Filter):

```
label, d_master_ssid, s_master_ssid, dynamic_flag, ss_short_code,
filters[email], filter_operators[email], sort_by[0][sort_column],
sort_by[0][sort_order], limit_to, limit_offset, distinct_column,
big_data, row_count, alias_column, description, blockType
```

`layout` mirrors the second entry of `Customblockpopup::$templateArray`:
`tabbed` (`tabbedBlockSettings.tpl` — Block Settings · Connection Mapping ·
Notes), `untabbed` (`blockSettings.tpl` — Label, Description, then fields), or
one of the bespoke `date-processor` / `plain` layouts. Blocks absent from
`$templateArray` fall through to the tabbed layout with **no** block-specific
fields, which is why Zip Files, LiveCloud Function and Clear Output show only
Label, Description and the mapping tab.

`connectionMapping` is not an independent switch — the tab exists exactly when
`layout === 'tabbed'`.

### Ported natively
Get Parameters · Conditional · Unique Validator · Set Variable · Clear Output ·
Array Extract · Custom Output · Return · Download as File · Realtime Push ·
Send Mail · Notification · Generic GET/POST · Twilio · Retarus Fax/SMS ·
Spreadsheet Filter / Delete Row / Increment Column / Insert / Bulk Insert /
Update / Insert-or-Update · Relational Filter · Convert To Spreadsheet · App
Document · all File blocks · Zip Files · Google OCR · Date · Math · String ·
Execute Workflow · Background Workflow · LiveCloud Function · all User
Management blocks · AI Extract · AI Transform · Agent Node.

### Not ported (`UNPORTED_BLOCKS`)
`ruleengine` (Dashboard Rule), `formrule` (Form Rule), `ssadvdatafilter`
(Spreadsheet Joined Filter). Their editors are generated from live
dashboard/form/two-sheet inventories the server assembles per request —
`layoutBlank.tpl` alone is ~1700 lines. They open, display, save and round-trip
correctly; their properties are edited as JSON on the **Advanced** tab and are
preserved byte-for-byte when the block is saved from any other tab. Every block
with no ported editor gets that Advanced tab, so no setting is unreachable.

## Endpoints used

All of these already exist in the platform.

| Endpoint | Purpose |
|---|---|
| `POST /workflow.savesession` | the event API above |
| `POST /workflow.save` | commit to Mongo |
| `POST /workflow.init/{id}` | run (`data` = JSON array of one params object); returns `workflow_log_id` (0 when logging is off) |
| `GET /workflow/log.debugdata/{logId}` | execution trace |
| `POST /workflow.settings/{id}` | recent logs (`type=log`), runtime settings (`type=save`) |
| `GET /workflow.jsoninfo/{wfId}/{blockId}` | current `block_properties` for one block |
| `POST /workflow.autosuggestionjson` | `{variable}` autocomplete tokens |
| `POST /workflow.version` | `type` = `list` \| `insert` \| `delete` \| `apply` |
| `POST /workflow.tags` | app association |
| `POST /workflow.reusables` | `key` = `view` \| `set` \| `unset` |
| `POST /workflow.search` | workflow picker (`searchItem`) |
| `POST /workflow.livespacelist` | apps |
| `POST /ls/livespace.sslist/{lid}` | spreadsheets in an app (returns `<option>` markup) |
| `POST /ls/livespace.ajaxdoclist/{lid}` | all documents in an app (`<option>` markup) |
| `POST /ls/livespace/spreadsheet.columns/{ssid}` | column list, `rowID` appended |
| `POST /ls/collection.clist_` | collections (`args[livespace-id]`, `args[page-size]`, `args[flags]`) |
| `POST /ls/collection.fileslist` | files in a collection |
| `POST /ls/role.list` | roles/groups |
| `POST /workflow.customblockpopup` | raw legacy dialog HTML — diagnostics only, never rendered |

### Autosuggestion — two things that bite

`POST /workflow.autosuggestionjson` takes **`workflowId` and `blockid`**, not
the `workflow_id` every other endpoint uses. Sending snake_case leaves them
empty and the reply comes back with **no blocks at all, silently**. And the
blocks are read from `session('workflow')[$workflowId]`, so the id must be the
one the session is keyed by — the Mongo id the canvas booted with, not a short
code.

Omit `blockId` for the whole workflow; pass one to re-read a single block after
writing its properties. Blocks exposing no fields are omitted, so an empty list
is a valid answer.

Response: `{ blocks: [{ blockId, type, label, fields: [], tokens: ['{Label.field}', …] }] }`
— **the server owns the token format**; do not synthesise `{Label.field}`
strings yourself.

### Option endpoints return HTML

`livespace.sslist`, `livespace.ajaxdoclist` and some file lists answer with
`<option>` markup inside the envelope's `Body`, not JSON. `lookups.ts` parses it
with `DOMParser` and reads `value`, text, and `data-shortcode`.

## Transport

`src/api/http.ts`:

- `credentials: 'same-origin'`, no CSRF token.
- **`X-Requested-With: XMLHttpRequest` is mandatory** — the platform picks
  between an Ajax envelope and a full HTML page from that header.
- Form bodies are PHP-nested-encoded: `{a: [1, 2]}` → `a[0]=1&a[1]=2`.
- A body starting `<!doctype`/`<html` where JSON was expected is treated as the
  login page (or an error page) and raised as a 401 `PlatformError`. `signIn:
  false` exists so a background request can never navigate the user away on an
  ambiguous HTML body.
- A `res.redirected` to `/user.signin` sends the browser to
  `/user.signin?_dn=<return path>`.

## Features

Load/save · React Flow canvas · drag-and-drop from the palette · click-to-add ·
"add next" auto-connect · connect by drag or click-to-click · edit/delete nodes
and edges · clone · open child workflow · zoom/pan/minimap/fit · selection ·
connection validation · dagre auto-arrange · run with input parameters · debug
dock (taken path, per-block input/output, JSON highlighting, prev/next, resize,
maximize) · recent logs · workflow settings (logging, schedule, versions) ·
read-only until **Edit** · unsaved-changes guard.

**Validation**, before anything reaches the session: no self-loops, no incoming
edge on an entry block, no duplicate edges, one outgoing edge per non-condition
block, one edge per condition branch. Entry types are `datatransfer`,
`genericpost`, `genericget` (`convert.ts: ENTRY_TYPES`).

**Keyboard:** `Ctrl/Cmd+S` save (or unlock editing) · `Del`/`Backspace` delete
selection · `B` blocks · `F` fit · `Enter` edit selected block · `Esc` cancel
pending connection / close.

**Edge colours** (`EDGE_COLORS`): yes `#22c55e`, no `#ef4444`, plain `#000000`,
taken-path `#1e3a8a`.

**"Configured" badge:** `hasConfig()` treats a block whose only
`block_properties` keys are `label`, `description`, `blockType`,
`dynamic_flag`, `debug_mode` as never configured.

## Not included, by design

AI workflow chat (`/workflow.aichat`), Relational Execute, and the
version-debugger canvas are development-branch features with no production
controller. They are deliberately absent. (Agent Node *is* present — the README's
list predates it.)

## Development

```bash
npm install
cp .env.example .env      # point VIZRU_PLATFORM_URL at your platform
npm run dev               # http://localhost:5180/workflows/#/list
```

`.env`: `VIZRU_PLATFORM_URL` (default `https://127.0.0.1`),
`VIZRU_DEV_PORT` (5180 — 5173/5174 are taken by other Vizru front-ends),
`VIZRU_OUT_DIR` (`dist`).

The dev server proxies `/user.`, `/workflow.`, `/workflows/`, `/ls/`, `/sys/`,
`/ui-themes/`, `/php-libs/`, `/data/` and `/api/` to the platform with
`secure: false`, so the browser stays same-origin. Two details make local auth
work:

- **`Secure` and `Domain` are stripped from `Set-Cookie`.** The platform sets
  `tsid` with `Domain=<tenant>; Secure`, which a browser on `http://localhost`
  would refuse. `cookieDomainRewrite: ''` clears the domain; the `Secure` strip
  is what actually fixes it.
- Sign in **through the proxy** (`http://localhost:5180/user.signin`) — a
  session on the real platform host does not share cookies with localhost.

`/workflows/` is both the app base and a platform prefix, so `isPlatformPath()`
disambiguates: a first segment containing a dot and not matching a static
extension (`log.debugdata`, `connection.properties`) goes to the platform;
everything else — the shell, `dist/`, Vite's `@vite`/`@react-refresh`/`src`
routes — is served locally. WebSocket forwarding is deliberately off, or
proxying `/workflows/` would swallow Vite's own HMR socket.

Verified end to end against the running stack:

```
GET  http://localhost:5180/workflows/   → 200, <title>Workflow Studio</title>,
                                          src="/workflows/src/main.tsx"
POST http://localhost:5180/sys/api.v1   → the platform's real 401 envelope,
                                          proxied over plain HTTP to an HTTPS
                                          host with a self-signed cert
```

Opened without a platform session, the app redirects to
`/user.signin?_dn=%2Fworkflows%2F%23%2Flist` and renders the platform's sign-in
page **through the proxy** — which is the whole point of the same-origin setup,
and the quickest way to confirm the cookie rewriting works.

## Build and deploy

```bash
npm install
npm run build        # tsc -b && vite build — verified clean, ~1.2s, 564 modules
npm run deploy -- ../Vizru-Docker/receiver/volumes/web/app-live/v1-web-app
```

`deploy` (`scripts/deploy.mjs`) replaces only the `dist/` subdirectory of its
target and **refuses to run against a directory that is not a `v1-web-app`**
(no `index.php`). It deliberately does not wipe the parent, because the
`.htaccess` that makes the layout work lives there and is maintained by hand —
it warns if that file is missing.

### The deploy path and the build base disagree — check before you ship

Verified by building: `vite.config.ts` sets `BUILD_BASE = '/workflows/dist/'`,
and the emitted `dist/index.html` references

```html
<script src="/workflows/dist/assets/index-DveRcEkd.js">
```

but `scripts/deploy.mjs` copies to `<webroot>/workflow/debugger/dist` and
prints `Open: https://<host>/workflow/#/list`. Its header comment still says
`base: '/workflow/dist/'`. Three different paths are in play — `/workflows/`,
`/workflow/` and `/workflow/debugger/` — and the README documents a fourth
(`/workflow/debugger/#/<id>`).

Deploying as-is puts the assets where the HTML does not look for them. Either
copy `dist/` to `<webroot>/workflows/dist/` (matching the build), or change
`BUILD_BASE`. Neither directory exists in `v1-web-app` right now, so the studio
is **not currently deployed** on this instance — there is nothing live to
contradict. Decide the path first, then make the `.htaccess`, the vite base and
the deploy target agree.

## Layout

```
src/
  api/          http (transport + platform envelopes) · bootstrap · session
                · workflow · workflowList · lookups · clipboard
  graph/        convert (session <-> React Flow, the axis swap) · autolayout
  components/
    canvas/     BlockNode · VizEdge
    settings/   registry (per-block schemas) · schema · serialize · fields
                · BlockSettingsDialog · ConnectionMappingEditor
                · skills · SkillsEditor · SqlQueryEditor
    ui/         Modal · DraggableModal · feedback · BlockIcon · icons
                · AutocompleteInput · ColumnInput · MultiSelect · Select
                · WorkflowPicker
    Toolbar · Palette · DebugPanel · RunDialog · RecentLogs
    · WorkflowSettings · WorkflowList
  contexts/     AutoSuggestionContext
  lib/          runStatus (the platform's inconsistent status casing)
                · routes · versions · customFunctions
  Studio.tsx    canvas state, persistence, run/debug orchestration
  App.tsx       hash routing + bootstrap states
```

## If you are writing your own studio or graph editor

1. **Bootstrap first.** Load the debugger page to seed the PHP session before
   any `savesession` post.
2. **Match the platform's field names exactly.** `customblockPropInsert` copies
   unknown keys verbatim into `block_properties`; a renamed field is silently
   dropped at runtime.
3. **Seed every property save from the stored document.** The handler replaces,
   not merges.
4. **Swap the axes** in exactly one place.
5. **Let the server produce autosuggestion tokens.**
6. **Two-phase save.** Session writes are not durable until `/workflow.save`.
7. Or bypass all of it and write `VizWorkflow` documents directly — see
   [workflow-model.md](workflow-model.md). You then own `source`/`target`
   stamping and short-code generation, and the classic canvas's session cache
   may serve a stale copy within the same request.
