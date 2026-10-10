# Workflow blocks

Every block type the engine can execute, with its palette id, implementing
class, and the `block_properties` keys it reads. The `return` block is
deliberately omitted, per the skill's scope.

- **Registry:** `$APP/sys/workflow/Block.php` — the `switch` in `getBlock()` is
  the authoritative type → class map. A type missing from it returns `null` and
  the run dies with a fatal.
- **Palette (ids + labels + icons):** `$APP/sys/controllers/workflow/Leftblock.php`
- **Base class (templating, built-ins, helpers):** `$APP/sys/workflow/block/Block.php`
- **Native settings schemas (field names verified against the Smarty templates):**
  `Workflow-UI/src/components/settings/registry.ts`

## Keys every block carries

Written by the save path regardless of type. `graph/convert.ts` treats a block
holding *only* these as "never configured".

| Key | Meaning |
|---|---|
| `label` | The name shown on the canvas, and **the namespace other blocks reference as `{Label.field}`**. Set one on anything you need to read later. |
| `description` | Free text, shown on the node when descriptions are toggled on. |
| `blockType` | Echo of the block's type. |
| `dynamic_flag` | `"true"`/`"false"` string. On spreadsheet blocks it means "resolve the sheet from a shortcode expression rather than the app picker". |
| `debug_mode` | `"0"`/`"1"`. |

Connection mapping (present only on blocks whose dialog is the *tabbed* layout)
lives under a sibling key, not in `block_properties`:

```json
"properties": { "field-mapping": [ { "insertcolumn": "ProductID", "keyvalue": "{Entry.id}" } ] }
```

`insertcolumn` is the destination column **label** (or API parameter name);
`keyvalue` is a template evaluated against the incoming row. `keytype:
"fieldkey"` with `keyvalue: "output"` passes the whole previous row.

---

## Entry / flow

### `datatransfer` — Get Parameters (2001)
`Block\getParameters`. The canonical entry block. Passes the incoming
`output[0]` through unchanged, stripping empty keys and replacing `.` with `*`
in the debug log. Its output is the input row every later block reads.

- `notify_type` — `upload` | `user_creation`

### `condition` — Conditional Block (5001)
`Block\condition`. The only block with two outgoing edges.

- `message` — the expression, e.g. `{status} == "approved"`

Parsing: splits on `&&` or `||` (one operator kind per expression — they do not
mix), then each side on the regex `/^(.*?)(==\(i\)|\(.*?\)|[!<>=|]=?)(.*?)$/m`.
Both sides go through full template rewriting.

Operators: `==` `=` `<=` `>=` `<` `>` `==(i)` (case-insensitive),
`inArray` (right side found in a comma-split left side), `regex` (right side is
the pattern). Prefix any with `!` to negate. A right side of literal `NULL`
(any case) is treated as `''`.

Result sets `status` to `yes`/`no`, and the engine then follows `target_yes` or
`target_no`.

### `setvariable` — Set Variable (1700)
`Block\setVariable`. Merges named values into every row of the current output.

- `variables` — `;`-separated `name=value` pairs; values may be quoted to
  protect embedded `;`. `name[key]=value` wraps the value as `{"key": value}`
  (used to shape input for `executeworkflow` loops). A value of `[[]]` becomes
  `[]`.

### `clearoutput` — Clear Output Block (2049)
`Block\clearOutputBlock`. Resets `output` to `[[]]`. No properties.

### `arrayextract` — Array Extract Block (2048)
`Block\arrayExtractBlock`. Runs `preg_match_all` over a string and emits one
row per match.

- `regex` — **never** template-rewritten; always a literal
- `data_selector` — the haystack, template-rewritten
- `output_key` — key each match lands under (default `data`)
- `sort_order` — `none` | `asc` | `desc`

Sets `resultCount` (the match count), readable later as `{extracted-array-count}`.

### `uniquevalidator` — Unique Validator (5005)
`Block\Uniquevalidator`. A distributed lock in `VizWorkflowUniqueValidator`,
keyed by `(uniquevalue, workflowID, _tid)`.

- `value` — the key, template-rewritten
- `unique_action` — `check` (upsert; output `permission` = `true` only if the
  upsert created the document) | `drop` (delete; output `permissionfinished`)

The classic dialog also rewrites `iconPath` to match the chosen action.

---

## Triggers (must be the first block to be callable over HTTP)

`authorize()` in `workflow.trigger` only proceeds when the first block's
`obj_id` is in **4200–4205**. See [http-api.md](http-api.md).

All share (`Block\TriggerBlock` subclasses):

- `auth_required` — `"0"` public, `"1"` requires a credential
- `user_email` / `uid` — the user the run executes as when unauthenticated

### `genericpost` — Generic POST (4202)
`Block\PostBlock`. Merges the JSON body (`php://input`), then `$_POST`, then an
`auth_token` header if present. When the body is JSON the raw decoded body is
also placed at `output[0]['rawdata']`. `auth_token` is masked in the log.

### `genericget` — Generic GET (4204)
`Block\GetBlock`. Output is the query string, `htmlspecialchars_decode`d.

### `twilio` (4203), `retarusfax` (—), `retarussms` (—)
`Block\TwilioBlock`, `Block\retarusFaxBlock`, `Block\retarusSMSBlock`.
Provider-shaped inbound triggers; same auth fields.

### `chatfileupload` — File Upload (4205)
`Block\chatFileUpload`. Accepts a multipart upload from the caller.

- `lid`, `cid` (app / collection to store into), `tags`

---

## Spreadsheet blocks

All handled by `Block\SpreadsheetOperationsBlock` except `relationalfilter` and
`tospreadsheet`. Target-sheet selection is shared:

| Key | Meaning |
|---|---|
| `d_master_ssid` | App (livespace) `lid` — scopes the picker |
| `s_master_ssid` | The sheet's Mongo `ssid` — **read/delete/increment blocks** |
| `ssid` | The sheet's Mongo `ssid` — **insert/update blocks** |
| `ss_short_code` | A shortcode (or `{template}`) used *instead* of the picker; when set it is resolved at run time via `loadBySSShortCode` and overrides `ssid`/`lid` |
| `dynamic_flag` | `"true"` when the shortcode path is in use |
| `disable_realtime` | `"true"` suppresses the socket push (insert/update/upsert only) |

Filters:

```json
"filters":          { "ProductID": "212", "Status": "{Entry.status}" },
"filter_operators": { "ProductID": "=",   "Status": "=" }
```

Keys are column **labels**. Values are template-rewritten. Operator strings map
to Mongo:

| Operator | Mongo | Operator | Mongo |
|---|---|---|---|
| `=` | `$eq` | `IN` | `$in` |
| `!=` | `$ne` | `NOTIN` | `$nin` |
| `>` | `$gt` | `IN(i)` | `$ini` |
| `<` | `$lt` | `NOTIN(i)` | `$nini` |
| `>=` | `$gte` | `=i` | `$regex` |
| `<=` | `$lte` | `regex` | `regex` |
| `btwn` | `btwn` | `like` / `!like` | `like` / `!like` |

A filter value of `NULL`/`null` becomes `''`. With `dynamic_flag` on, the filter
**keys** are template-rewritten too, so a key can itself be `{Entry.column}`.

### `ssdatafilter` — Spreadsheet Filter (4101)
Reads rows. The only spreadsheet block with the advanced settings.

- `sort_by` — `[{ "sort_column": "VendorName", "sort_order": "desc" }, …]`
  (labels; legacy single `sort_column`/`sort_order` still honoured)
- `limit_offset`, `limit_to` — both must be set for paging to engage; the block
  then also computes the unpaged total into `resultCount`
- `alias_column` — `col as newName` per line/comma; renames output keys
- `distinct_column` — one column label
- `big_data` — `1` streams via a PHP generator; output becomes
  `{"viz_yield_key": <generator>}` rather than a plain array. Only
  `executeworkflow` with `loop` on knows how to consume that.
- `row_count` — `1` returns **only** `resultCount`, no rows

Sets `resultCount`, readable later as `{filter-count}`.

### `ssdeleterow` — Spreadsheet Delete Row (2050)
Deletes every row matching `filters`.

### `ssautoincrementcol` — Spreadsheet Increment Column (2051)
- `increment_column` — the column label to bump on matching rows

Uses `getSSAutoIncNextVal`, so it is safe for generating sequence numbers.

### `insertssdata` — Spreadsheet Data Insert (1800)
Appends `properties['field-mapping']` as one new row. No filters.

### `bulkinsertssdata` — Spreadsheet Bulk Data Insert (1801)
Appends many rows in one operation. Takes the *first* field-mapping's
`keyvalue` (e.g. `{Filter.rows}`), resolves that label's previous output, and
if the value parses as JSON iterates it, applying the mapping per element. No
realtime row and no filters.

### `updatessdata` — Spreadsheet Data Update (2000)
Updates rows matching `filters`. Runs only when a matching row exists.

### `insertorupdatessdata` — Spreadsheet Data Insert Or Update (1900)
Update if `filters` match, insert otherwise.

### `relationalfilter` — Relational Filter (4103)
`Block\RelationalFilterBlock`. Reads via the **MCP server / Postgres mirrors**,
not the Mongo engine.

- `sql_query` — one read-only `SELECT`
- `d_master_ssid` — App, **only** to scope editor autocomplete; it does not
  restrict the query

`{!CODE!}` in the SQL is rewritten to `ss_CODE` before templating, so you write
`FROM {!EMP001!}` and the block sends `FROM ss_emp001`. `{variable}` templating
runs after that. `SqlReadGuard::check()` refuses anything but a single
read-only SELECT before the request leaves PHP; the server's `guard.py` repeats
the same rules. Capped at **500 rows** in PHP (the server's own `MAX_ROWS` is
separate and larger).

On failure it does **not** throw — it returns `output = [{"error": "…"}]`, so
the workflow continues. Check for that key downstream.

### `ssadvdatafilter` — Spreadsheet Joined Filter (4102, hidden in the palette)
Joins two sheets in Mongo via `getAdvSSDataArray`.

- `first_ssid_code`, `second_ssid_code` — shortcodes
- `join_on_first`, `join_on_second` — the join columns (all four required)
- `alias_column` — `{ "first": "a as b,…", "second": "…" }`; when absent the
  block auto-aliases every column to itself
- `filter_conditions` — `{ "first": [{key, operator, value}, …], "second": […] }`
- `sort_by`, `big_data`, `row_count`

Its editor is **not** ported to the React studio (needs a live two-sheet column
inventory); edit via the Advanced JSON tab or the classic dialog.

### `tospreadsheet` — Convert To Spreadsheet (3001)
Handled inline in `Workflow\Block::execute`, not by a block class. Writes the
current output into a spreadsheet document.

- `d_master_ssid` — target app, used as `livespace-id` for a new sheet
- `s_master_ssid` — an existing sheet to append into; **when blank, a new sheet
  is created** titled `SS_<name>` via `livespace.spreadsheet.create`

Appending goes through `copyPasteData` with `eventSource: 'workflow'`.

### `livespace` — App Document
Selects a document inside an app. `d_master_ssid` (app) + `s_master_ssid`
(document). `obj_id` is a compound string `livespace-<kind>-<lid>-<fid>`, where
kind is `spreadsheet` | `excel` | `grid3`; `getLivespaceBlockInfo()` resolves
the column list differently per kind (an `excel` document is downloaded and
parsed with SpreadsheetReader).

---

## Files

`Block\fileOperationsBlock` unless noted. All take `lid` (App) and `cid`
(Collection). File rows come back with these keys:

`Id`, `User`, `OwnerEmail`, `OwnerName`, `Name`, `MimeType`, `FileSize`,
`FileCount`, `FilePath`, `Description`, `StorageId`, `CreatedAt`, `Flags`,
`FileIdentification` (`uid-lid-cid/fid`), `FileFullPath` (an absolute
`/sys/core/files.pxy/` URL), `createdTimestamp`.

Permission: super admin, or app owner, or app permission 113.

| Type | id | Extra properties |
|---|---|---|
| `getfiles` | 6000 | — (lists the collection) |
| `deletefile` | 6001 | `fid` |
| `movefile` | 6002 | `new-cid`, `fid` |
| `getfiledetails` | 6003 | `fid` |
| `createfile` | 6004 | `operationType` (`data`\|`url`\|`file`), `filename`, `data`, `mimetype` |
| `copyfile` | 6005 | `fid`, `new-lid`, `new-cid` |
| `processfile` | 2100 | `fid` — parses a stored file into rows (`Block\processFileBlock`) |
| `downloadasfile` | 4208 | see below (`Block\downloadAsFile`) |
| `zipfiles` | 2054 | no ported fields |
| `googleocr` | — | `file_path`, `fields` (`Block\googleOcr`) |

### `downloadasfile` (4208)
- `fileAction` — `download` (stream to client) | `save` (store remotely)
- `fileType` — `csv` | `xls` | `txt`
- `charSet` — `utf-8` | `windows-1252` | `us-ascii`
- `fileName`, `columnData` (header row), `outData` (JSON rows)

---

## Compute

### `date` — Date (2056)
`Block\Dateblock`. `config` is a list of operations, each producing one output key.

| Field | Meaning |
|---|---|
| `key` | Output variable name |
| `time` | `"true"`/`"false"` — include `H:i:s` |
| `input_date` | Date 1; `today` is special-cased |
| `operator` | `''` (extract/reformat) \| `add` \| `sub` \| `diff` \| `comp` |
| `value` | Interval, or Date 2 for `diff`/`comp` |
| `informat` | `timestamp` \| `m/d/Y` \| `m-d-Y` \| `Y/m/d` \| `Y-m-d` \| `d/m/Y` \| `d-m-Y` |
| `outformat` | the above plus `d` `m` `Y` `days` `months` `years` `hours` `minutes` `seconds` |

With an empty `value` and an `outformat` set, the operator becomes `extract`.

### `math` — Math (2057)
`Block\Mathblock`. `config` rows of `{ key, math_input }`. Each expression is
wrapped as `{%math <expr>%}` and evaluated by the templating engine (jlawrence
EOS parser), so `{variable}` works inside it. `avg(…)` and `round(…)` are
handled specially. **Any letter or blacklisted character surviving substitution
makes the result `0`** — a typo in a variable name silently yields zero.

### `string` — String (2058)
`Block\Stringblock`. `config` rows of `{ key, type, regex, input_string, offset }`.

`type`: `regE` (extract) · `regM` (match) · `regR` (replace) · `upper` ·
`lower` · `strlen` · `implode` · `urlencode` · `urldecode` · `unicodeEscape` ·
`unicodeUnescape` · `compareString` · `explode` · `substrcount` ·
`stringreplace` · `substr` · `ltrim` · `rtrim`

The layout relabels `regex`/`input_string`/`offset` per action (Find/Replace,
Start/Length, …). These map onto the `{%…%}` functions in
[templating.md](templating.md).

---

## Workflows

### `executeworkflow` — Execute Workflow (child's Mongo id as `obj_id`)
`Block\executeWorkflow`. Runs another workflow **synchronously, in-process**, as
`mode = 'child'`.

- `namespace` — comma-separated. The first entry selects the input:
  `Label` passes that block's whole output; `Label.field` passes the value at
  that field (JSON-decoded if it parses; up to three dotted segments are
  walked). Remaining `Label.field` entries are merged into every input row.
- `extra_params` — appended to `namespace` when both are set
- `loop` — falsy runs the child once with `input[0]`; truthy runs it once per
  input row and concatenates the outputs
- `reusable_params` — key/value map for a reusable workflow's declared inputs
  (merged into `input[0]`, non-loop only)
- `wkfl_id` — explicit child id, overriding `obj_id`
- `short_code` — sibling of `block_properties`, resolves the child by shortcode

Returns `childWorkflowLogs` as `<childWfId>-<logId>-<logId>…`, which the parent
records in `viz_workflow_exec_log.child_workflows`. Cycles are detected by
`getChildWorkflowInfo`. Recognises `viz_yield_key` input from a `big_data`
filter.

### `backgroundworkflow` — Background Workflow (2055)
`Block\backgroundWorkflow`. Queues a workflow to run detached.

- `background_short_code` — the workflow to run
- `namespace` — same resolution rules as `executeworkflow`

Under HTTP it posts to `cli.backgroundexecservice` with
`op = workflow.backgroundprocess` and returns immediately with
`{ jobID, jobStatus: "Started", wfShortCode, workflowParameters }`. Under CLI
(the worker) it runs the child inline instead. Pair it with `realtimepush` on a
`job_id` identifier to report completion.

### `livecloudfunction` — LiveCloud Function (Mongo function id as `obj_id`)
`Block\Livecloud`. Calls a configured LiveCloud REST function. Inputs come from
`properties['field-mapping']`; parameters of type `Fixed`, `Secret` and
`Mongoquery` are server-side only and never exposed as inputs. Sets `httpcode`
on the result, readable later as `{httpcode}`. No ported settings fields — the
function is chosen by the palette entry.

### `dataset` — LiveCloud Dataset
`Block\Datasetblock`. Runs a stored SQL dataset. `getBlockInfo()` parses the SQL
with `phpsqlparser` to derive output fields: `INSERT` yields its column list,
`SELECT` yields the resultset headers.

---

## Output / notification

### `customoutput` — Custom Output (4206)
`Block\customOutput`. Replaces the HTTP response body and status.

- `headerStatusCode` — `200` `302` `400` `401` `403` `404` `500` `503`
- `outputDataType` — `string` | `json`
- `outData` — the body, template-rewritten

With `json`, the engine sets `Content-Type: application/json` and re-encodes.
`workflow.exec` additionally merges `jsCodes` and `Actions.messages` into the
JSON payload; `workflow.trigger` does not.

### `realtimepush` — Realtime Push (4207)
`Block\realTimePush` (extends `setVariable`). Pushes over the socket server.

- `identifier` — `guid` | `job_id`
- `guid` — target GUID (when `identifier = guid`)
- `jobid` — job id (when `identifier = job_id`)
- `notification_log` — `1` also writes `VizNotification` so an offline user
  sees it in the Inbox (job_id path only)
- `tags` — the socket event name; `new_message` gets extra chat-log handling
- `variables` — `;`-separated `name=value`, sent as the `dataset`

`guid` posts to `emit_block`. `job_id` looks up `VizJobStatus`, expands a
comma-separated `USER_ID` (emails are resolved to uids), optionally logs a
notification, writes a `VizJobStatus` row, and posts to `background_service`.
See [realtime.md](realtime.md).

### `sendmail` — Send Mail (1001)
`Block\Sendmailblock`. Recipients, subject and body come from the connection
mapping, not from `block_properties`.

- `notify_type` — `1` send now | `7` weekly | `30` monthly

### `notify` — Notification (3101)
`Block\Notify`. In-app toast.

- `notify_type` — `success` | `danger` | `warning` | `info` (custom allowed)
- `message`

---

## User management

`Block\userManagementBlocks`. All take `email` except Get App Members.

| Type | id | Properties |
|---|---|---|
| `adduser` | 7000 | `email`, `name`, `fedId`, `customerName` (group), `systemRoleName` (global role), `sendmail` (`on`/empty) |
| `getuser` | 7002 | `email` |
| `getuserlivespaces` | 7003 | `email` |
| `deactivateuser` | 7004 | `email` |
| `addusertolivespace` | 7005 | `email`, `livespace_shortcode`, `livespaceroleName` |
| `removeuserfromlivespace` | 7006 | `email`, `livespace_shortcode` |
| `getlivespacemembers` | 7007 | `livespace_shortcode` only |
| `setlanding` | 7008 | `email`, `livespace_shortcode`, `dashboardShortCode` |

---

## AI

### `agentnode` — Agent Node (4211)
`Block\AgentNodeBlock` + traits `AgentNodeSkills`, `AgentNodeLive`. Fully
documented in [agent-node.md](agent-node.md).

### `roverai` — AI Extract (4209, alias XAE)
`Block\RoveraiBlock`. Runs a Rover extraction project.

- `project` — project name
- `searchsource` — `mysource` | `global` | `myinsight` (custom allowed)
- `question` — the tasks (required), `instructions`, `goal`

### `roveragent` — AI Transform (4210, alias XAT)
`Block\RoveragentBlock`. `question` (the data) + `purpose` (instructions).

---

## Rule engines (dashboard/form scoped — listed for completeness)

Out of this skill's scope as features, but they appear in workflow graphs and
their properties must survive a round-trip.

- `ruleengine` — Dashboard Rule (2052), `Block\ruleEngine`. `livespace-id`,
  `liveapp-id`, plus a large generated action config.
- `formrule` — Form Rule (2053), `Block\formRule`. `form-config.formId` plus
  per-field rules.

Neither editor is ported to the React studio; both round-trip byte-for-byte via
the Advanced JSON tab.

---

## Supporting classes (not blocks)

| Class | Role |
|---|---|
| `Block\McpClient` | HTTP client for the MCP server — `query`, `schemas`, `captureQuery`, `storeResult`, `readResult`, memory, `rag`. Basic auth from `McpApiUser`/`McpApiSecret`. |
| `Block\SqlReadGuard` | PHP mirror of the server's `guard.py`. Single read-only SELECT only. |
| `Block\ToolResultRouter` | Decides whether an Agent Node tool result is sent inline or stored and referenced by id. |
| `Block\AgentMemory` | Thread transcript + keyed facts, in `FULL` or `FACTS` mode. |
| `Workflow\Functionlib\Block` | Tenant-defined reusable `fn*` functions callable as `{fnName(args)}`. |
