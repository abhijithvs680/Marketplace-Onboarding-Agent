# HTTP API

## Routing

`\Sys\Controllers\Controller::GetByPath($path)` maps a URL to a class:

```
/workflow.trigger/abc/def   →  \Sys\Controllers\Workflow\Trigger   args ['abc','def']
/ls/livespace.sslist/2      →  \Sys\Controllers\Ls\Livespace       method 'sslist', args ['2']
/sys/api.v1                 →  \Sys\Controllers\Sys\Api\V1
```

Everything before the **first dot** is a namespace path (`/` → `\`), the segment
after it is the class, and the rest of the path is positional `args`. No dot
means the class `Html`. PHP reserved words get a trailing underscore
(`List` → `List_`, `New` → `New_`).

Lifecycle per controller: `initialize` → `authenticate` → `authorize` →
`validate` → `execute` → `render`. Returning `false` from any of them stops the
chain.

## `POST /workflow.trigger/<idOrShortCode>` — the public workflow endpoint

`$APP/sys/controllers/workflow/Trigger.php`. This is how an external app runs a
workflow.

**The first block must be a trigger block.** `authorize()` only proceeds when
the entry block's `obj_id` is in **4200–4205**: `genericpost` (4202),
`twilio` (4203), `genericget` (4204), `chatfileupload` (4205). Anything else
returns without executing.

The path segment is a Mongo `_id` **or** a `short_code` — it tries
`new ObjectId()` first and falls back to `loadWorkflowByShortcode()`.

### Status codes (verified live)

| Situation | Response |
|---|---|
| unknown shortcode, no session | **404** |
| unknown shortcode, with session | 302 to `/` |
| soft-deleted workflow (`deleted == "true"`) | `initialize` returns false |
| `auth_required = "0"` | **200**, runs as the block's `uid` |
| `auth_required = "1"`, bad/absent credential | 401 / 417 (expired JWT) / 498 (malformed JWT) |
| workflow throws mid-run | **200** with body `Internal Server Error` |

That last row matters: **a 200 means the workflow ran, not that it succeeded.**
Parse the body.

### Input

`genericpost` merges, in order: the JSON body from `php://input`, then `$_POST`,
then an `auth_token` header. A JSON body is also placed whole at
`output[0]['rawdata']`. `genericget` takes the query string,
`htmlspecialchars_decode`d.

### Output shaping

The response depends on the **last block that ran**
(`activityResult['last_activity']`):

| Last block | Response |
|---|---|
| `customoutput` | `outData` verbatim; `Content-Type: application/json` when `outputDataType = json`; `headerStatusCode` applied |
| `return` | `Content-Type` from the row's `contentType`, body = `json_encode(returnValue)` |
| `getfiledetails` | the file bytes, `Content-Type` from `MimeType` |
| anything else | `application/json`, the whole `output` array, with `jsCodes` and `workflow_log_id` merged into `output[0]` |

A row carrying `datatype: "html"` short-circuits: `Body` is
`html_entity_decode`d and echoed as HTML.

### CORS — read this before building a browser client

The allow-list is **hard-coded** in `Trigger.php::initialize()`:

```php
$allowedOrigins = ['http://localhost:3000', 'https://baines.healthcare'];
$allowedSubdomainPattern = '/^https:\/\/([a-z0-9-]+\.)*vizru-ras\.com$/i';
```

A matching `Origin` gets `Access-Control-Allow-Origin: <origin>`,
`Access-Control-Allow-Credentials: true` and `Vary: Origin`. **A
non-matching origin gets no CORS headers at all** — the browser blocks the
response. Adding your origin means editing that array.

Always sent, regardless of origin:

```
Access-Control-Allow-Headers: hashtoken, auth_token, bearer, Authorization, Content-Type
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
```

`OPTIONS` answers 200 and exits before any workflow logic.

### Session hygiene

If the caller had no platform session, the controller ends with
`session_unset()` + `session_destroy()`. A trigger call leaves no session
behind.

### Example

```js
const res = await fetch(`${PLATFORM}/workflow.trigger/${shortCode}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    // only when the trigger block sets auth_required = "1"
    ...(token && { Authorization: `Bearer ${token}` }),
  },
  body: JSON.stringify({ orderId: 42, status: 'approved' }),
});

// 200 does not mean success — the body may be "Internal Server Error".
const text = await res.text();
let payload;
try { payload = JSON.parse(text); }
catch { throw new Error(`workflow ${shortCode} failed: ${text}`); }
```

Inside the workflow those fields are `{orderId}` and `{status}` off the entry
block, or `{Entry.orderId}` once the entry block is labelled `Entry`.

## `POST /workflow.exec/<idOrShortCode>` — session-authenticated run

`$APP/sys/controllers/workflow/Exec.php`. **401 without a platform session.**
Any first block is allowed — no trigger block required.

Input: `data` as a JSON-encoded POST field, plus every query parameter merged
into `postParameters[0]`. `executed_from` (POST field or inside `data`) is
recorded on the run; the value `chat` is special-cased.

Output shaping is the same as `workflow.trigger` with two additions: `jsCodes`
and `Actions.messages` (the platform's flash messages, then cleared) are merged
into `output[0]`, and `getfiledetails` honours `viewtype=download` +
`filename` to force an attachment. Sends `Access-Control-Allow-Origin: *`.

## `POST /workflow.init/<id>[/user_id/<uid>][/…/needreturn]` — the UI run

`$APP/sys/controllers/workflow/Init.php`. What the studio's Run button calls.
Takes `data` as JSON. `/user_id/<uid>` impersonates that user (used by the cron
path). Returns a rendered page normally; with `needreturn` as arg 4 it echoes
`activityResult` as JSON and exits. Also returns `first_block_id`,
`workflow_log_id` and an HTML `workflowStatus` trace.

## `POST /sys/api.v1` — the service bus

`$APP/sys/controllers/sys/api/V1.php` (`V2` is an alias with its own args slot).
`Request::IsApi` is true **only** for a POST to exactly `sys/api.v1` or
`sys/api.v2`.

```
op=livespace.spreadsheet.ssinsert
args[ssid]=6a65dfa441ddff55542bd172
args[ProductID]=42
args[ProductName]=Widget
echo=optional-correlation-value
```

`op` maps to a class the same way controllers do:
`\Sys\Services\Livespace\Spreadsheet\Ssinsert`. `args` is a nested PHP array;
`$_FILES['file']` is merged in.

Response is always a fixed envelope, and the real status is inside it:

```json
{ "Echo": "<your echo>", "Status": [200, "OK"], "Time": "0.765 1790538372",
  "Errors": null, "Body": { … } }
```

| `Status` | Meaning |
|---|---|
| `[200, "OK"]` | success, `Body` holds the result |
| `[400, "Bad Request"]` | the service's `validate()` failed — wrong arguments |
| `[403, "Forbidden"]` | `authorize()` failed |
| `[401, "Unauthorized"]` | `authenticate()` failed |
| `[503, "Internal Server Error"]` | `execute()` returned false or threw |

A generic `\Exception` is deliberately replaced with "Sorry, We have seriously
messed up…" — the real error is only in the server log.
`Access-Control-Allow-Origin: *` is set on this endpoint.

### Services worth knowing

| `op` | Purpose |
|---|---|
| `livespace.spreadsheet.create` | create a sheet + register the file |
| `livespace.spreadsheet.ssinsert` | append a row (parameters are column labels) |
| `livespace.spreadsheet.ssupdate` | update the first row matching a filter |
| `livespace.spreadsheet.spreadsheetdetails` | sheet metadata |
| `livespace.spreadsheet.projection`, `convert`, `convertkvp`, `customfilterprocess`, `ssindexing`, `ssdownload` | read / reshape / export |
| `user.jwt.externalauth`, `user.jwt.validate`, `user.jwt.regentoken` | JWT issue / verify / refresh |
| `workflow.process`, `workflow.backgroundprocess`, `workflow.getscheduledwf` | worker-side workflow execution |
| `cli.backgroundexecservice` | queue CLI work (what `backgroundworkflow` uses) |
| `realtime.real`, `realtime.livesession`, `realtime.chatlog` | chat/realtime logging |
| `liveapps.realtime.userRowData` | per-user row data for a realtime app refresh |
| `log.*` | execution logs |

Full list: `$APP/sys/services/` — each directory is a namespace segment, each
class a lowercase `op` leaf.

## `POST /sys/api.route/<shortCode>/<seg>/<seg>` — RESTish workflow proxy

`$APP/sys/controllers/sys/api/Route.php`. Builds an args array from the path
segments (`segment2`, `segment3`, …), **every request header**, `$_POST`, and an
`upload_file` multipart field, then cURLs it to
`workflow.trigger/<shortCode>` and echoes the result.

Its segment arithmetic assumes a different mount point than
`/sys/api.route/…` — probing that path yields a 302 rather than a proxied run.
**Use `workflow.trigger` directly.** Documented here only because you will find
it in the tree.

## Realtime endpoints (node, not PHP)

`POST` to the socket server (`InternalSocketServer`, `:8000`), called by the
platform rather than by clients: `/emit_block`, `/ssUpdate`,
`/background_service`, `/viz_custom`. See [realtime.md](realtime.md).

## Studio / lookup endpoints

Session-authenticated, same-origin. Used by the React studio and its dialogs —
see [workflow-ui.md](workflow-ui.md) for the full table.
`POST /workflow.savesession`, `POST /workflow.save`,
`GET /workflow/log.debugdata/{logId}`, `POST /workflow.settings/{id}`,
`GET /workflow.jsoninfo/{wfId}/{blockId}`, `POST /workflow.livespacelist`,
`POST /ls/livespace.sslist/{lid}`, `POST /ls/livespace/spreadsheet.columns/{ssid}`,
`POST /workflow.search`, `POST /ls/collection.clist_`,
`POST /ls/collection.fileslist`, `POST /ls/role.list`.

## Ajax vs. page rendering

The platform decides between a JSON/Ajax envelope and a full HTML page from
`X-Requested-With`. **Send `X-Requested-With: XMLHttpRequest` on every JSON
call**, or you get a rendered page. A full HTML body where JSON was expected
usually means the session expired and you were served the login page — the
studio's `http.ts` treats a body starting `<!doctype`/`<html` as exactly that.
