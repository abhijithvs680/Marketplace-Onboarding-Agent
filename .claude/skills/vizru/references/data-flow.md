# Data flow

End-to-end paths, so you know which layer to reach for and what can silently be
stale or missing.

## 1. A client runs a workflow

```
React app
  │  POST /workflow.trigger/<shortCode>   (JSON body; bearer only if auth_required=1)
  ▼
Trigger.php
  │  resolve by _id or short_code · CORS allow-list check · auth check
  │  first block's obj_id must be 4200–4205, else nothing runs
  ▼
Workflow::runWorkflow(params, 'master', enable_log, null, 'external', wfId)
  │  MySQL viz_workflow_exec_log ← one row, exec_status 'Failed'
  │
  │  ┌─ block at source == 0
  │  │    execute(prevResult) → { status, output, prev_outputs, debugLogData }
  │  │    Mongo VizWorkflowLog ← one document per block
  │  └─ next = target, or target_yes/target_no on a condition
  │     … until target == 0, status == 'break', or 10 000 runs
  │
  │  viz_workflow_exec_log ← exec_status 'Success', finished_at
  ▼
response shaped by the LAST block that ran
  customoutput → outData + headerStatusCode
  return       → contentType + returnValue
  getfiledetails → the file bytes
  otherwise    → JSON of output, with jsCodes and workflow_log_id merged in
```

A mid-run exception still answers **200** with the body `Internal Server Error`.
Parse the body, not the status.

## 2. Values move between blocks

```
Entry block output ──► [ {orderId: 42, status: 'approved'} ]
      │
      │  the engine carries forward:
      │    output        — the last block's rows
      │    prev_outputs  — { label: rows } for every LABELLED block
      │    prev_labels   — labels in execution order
      ▼
next block's block_properties are template-rewritten:
      {status}              ← output[0]['status']
      {Entry.orderId}       ← prev_outputs['Entry'][0]['orderId']
      {Filter.rows[]}       ← column-wise array across all rows
      {%math {qty}*{price}%}
      {loginuserid} {tenantid} {viz-uuid} …
      {fnCustom(a,b)}
```

**An unlabelled block never enters `prev_outputs`.** An unresolvable `{name}` is
replaced with nothing — no error. Full rules in
[templating.md](templating.md).

## 3. Writing a spreadsheet row

```
insertssdata block
  │  properties['field-mapping']: [{ insertcolumn: 'ProductID', keyvalue: '{Entry.id}' }]
  │  reWriteParameters() resolves keyvalue against the incoming row
  ▼
Spreadsheet::insertRow({ ssid, row, sstid, userEmail, eventSource })
  │  label → md5 column key via getAllColHeadersKeys()
  │  getCastDataByColumnKey() casts per column-settings datatype
  ▼
Mongo VizSpreadsheetRows ← { ssid, _tid, row_id (uuid4), updated_by,
                             row_meta.last_updated, <colKey>: value, … }
  │
  ├─► Realtime::updateRealtimeData(ssid, dataset, action, lid)
  │      only if a VizLiveappsContent doc has source = "SS##<ssid>"
  │      and realTime ∈ {1,2,3}  … and disable_realtime is off
  │      → POST InternalSocketServer/ssUpdate
  │
  └─► Sync::rowsChanged(ss, lid, [rowIds])
         only if general-settings.Autosync is set
         → Redis LPUSH vizru:ss-sync:events { event: 'rows.upsert', ids }
```

The two fan-outs are **independent**. Either, both, or neither may be active.

## 4. Mongo row → Postgres mirror

```
Redis vizru:ss-sync:events (FIFO via BRPOP, capped 50 000)
  ▼
sync_worker.py  (a thread inside mcp-server)
  │  events carry IDS ONLY — the current row is re-read from Mongo at apply time,
  │  so events are idempotent and order does not matter
  ▼
sync_apply.py
  schema.sync     reconcile t<tid>.ss_<code> against the descriptor
                  (add/rename/retype/index all take the same path;
                   a drifted table is repaired, not migrated)
  rows.upsert     re-read from Mongo, upsert on _row_id
  rows.delete     delete by _row_id
  table.backfill  load every row the sheet currently holds (batches of 500)
  table.drop      drop the mirror
  ▼
PostgreSQL t<tid>.ss_<code>
  _row_id · _synced_at · "<md5 key>" per column · indexColumnNo0N
```

**Lag is real, and in this instance the pipeline is idle** — no sheet has
`Autosync` on, and the existing `t204` mirrors came from an older external
pipeline. Check `/api/schema` before assuming a sheet is SQL-queryable.
`probe.mjs sync` reports the queue depth, the Autosync count and the mirror
count.

## 5. SQL read path

```
relationalfilter block
  │  sql_query: SELECT * FROM {!EMP001!} WHERE "Status" = '{Entry.status}'
  │  {!CODE!} → ss_code   (before templating)
  │  {variable} substitution
  │  SqlReadGuard::check()      ← layer 2: single read-only SELECT
  ▼
McpClient::query(sql, 60s, allowedTables, tid)
  │  basic auth, POST /api/query
  ▼
mcp-server
  │  guard.py check()           ← layer 3: same rules again + table allow-list
  │  tenant.schema_for(tid)     ← layer 1: search_path = t<tid>  (the real boundary)
  │  read-only session          ← layer 4: catches SELECT … FOR SHARE
  │  statement_timeout, MAX_ROWS ← layer 5
  ▼
bare JSON array of row objects → block output (PHP caps at 500 rows)
```

A failure returns `output = [{ error: "…" }]` rather than throwing, so the
workflow continues. **Check for that key downstream.**

## 6. Agent Node

```
agentnode block
  │  interpolate the 19 listed properties
  │  ss_shortcodes → ownedShortCodes() (a viz_livespace_files query, drops
  │                  codes from other tenants) → McpClient::schemas()
  │                  → schemas + CRITICAL SQL RULES appended to system_prompt
  │                  → allowedTables recorded
  │  rag_type retrieval/both → POST /rag/retrieve → chunks appended as prompt text
  │  thread_id → AgentMemory::open() → POST /api/memory/open (counters + facts)
  │  buildToolRegistry: query_database, external HTTP tools, skills,
  │                     memory tools, read_result
  ▼
agentic loop, ≤ 100 iterations, ≤ 250 000 estimated input tokens
  │  provider call (gemini / openai / anthropic / on-premises)
  │
  │  streaming? → SSE parsed per provider
  │               chunks coalesced (64 B / 120 ms, UTF-8 safe)
  │               → Realtime::realTimePush(… , 'emit_block')
  │               → socket.io event named by `tags` → browser
  │
  │  tool calls? → dispatchToolCalls()
  │       db       → POST /api/query (allowed_tables enforced)
  │       http     → the tool's own URL
  │       workflow → a CHILD WORKFLOW in-process (≤ 12 per execution)
  │       skill    → Slack / Telegram / Discord / WhatsApp / Email API
  │       memory   → /api/memory/*
  │
  │       each result → ToolResultRouter
  │            table-shaped → POST /api/tool-result/query  (stored whole,
  │                           model gets a reference + count + 5-row preview)
  │            otherwise    → POST /api/tool-result
  │            model pages it back via read_result (50 rows/page)
  │
  │  append assistant tool calls + tool results to messages, iterate
  ▼
output = [{ response, provider, model }]
final stream frame: { type: 'agent_stream', status: 'complete' }
```

Tools are withdrawn (forcing a prose answer) when the iteration cap or the token
budget is hit — `budget_exhausted` in the trace tells you which.

## 7. Background workflow

```
backgroundworkflow block  (under HTTP)
  │  resolve namespace → input row
  │  execService('cli.backgroundexecservice', { op: 'workflow.backgroundprocess',
  │                                             'cli-data': {...} })
  ▼  returns immediately: { jobID, jobStatus: 'Started' }
RabbitMQ → receiver-celery
  ▼
CLI run of the same block class, which now executes the child inline
  │  viz_workflow_exec_log ← child row, parent's child_workflows updated
  ▼
the child ends with a realtimepush on identifier = job_id
  │  VizJobStatus ← { jobId, status, message }
  │  optional VizNotification (notification_log = 1)
  ▼  POST InternalSocketServer/background_service → the waiting browser
```

The client holds `jobID` from the synchronous response and waits on the socket.
With `notification_log = 1` an offline user finds it in the Inbox instead.

## 8. Scheduled run

```
VizWorkflowSchedule { workflow_id, minute, hour, day,
                      command: '<base>/workflow.startcrontask/<id>/user_id/<uid>' }
  ▼
receiver-celery-beat  → fetches that URL
  ▼
Workflow::runWorkflow(...) impersonating <uid>
```

A scheduled run is an HTTP self-call. `workflow.getscheduledwf` lists workflows
with `schedule == '1'`.

## 9. Authoring through the studio

```
React studio (session cookie, same-origin)
  │  GET /workflow.debugger/{id}          ← seeds session('workflow')[id] + palette
  │  GET /workflow.debugger/{id}/isChild/ ← blocks + connections
  │  GET /workflow.settings/{sc}/json     ← block_properties
  ▼
every edit → POST /workflow.savesession   (objectInsert, objectDrag,
  │                                        connectionInsert, customblockPropInsert, …)
  │  mutates the PHP SESSION only — not durable
  │  customblockPropInsert REPLACES block_properties wholesale
  ▼
POST /workflow.save  (permission 1007)
  │  session → w_objects + connection, stamping source/target/target_yes/target_no
  │  full_objects = json_encode(w_objects)
  │  short_code generated from the name if absent
  ▼
Mongo VizWorkflow
```

Coordinates are transposed across this boundary: session `xPos` = CSS top,
`yPos` = CSS left; React Flow `x` = `yPos`, `y` = `xPos`.

## 10. Realtime spreadsheet fan-out

```
spreadsheet write (rowInsert | rowUpdate | row_remove | copyPaste |
                   multiRowsUpdate | column_remove)
  ▼
VizLiveappsContent lookup: source = "SS##<ssid>", realTime ∈ {1,2,3}
  ▼  POST InternalSocketServer/ssUpdate { tid, lid, ssid, row_id,
                                          app_object_ids, action, user_id, jwt_token }
receiver-chatsystem
  │  for each room tid_viz_appId[_viz_dnaFilter] that matches:
  │    collect connected users
  │    POST /sys/api.v1 op=liveapps.realtime.userRowData (with that JWT)
  │    → per-user permitted rows
  ▼  emit 'ss_dataChange' per socket, each with only that user's rows
```

Row-level permissions are computed server side, so **every client gets a
different payload**.

## Where a value can go stale or vanish

| Symptom | Cause |
|---|---|
| `{Label.field}` is empty | the producing block has no `label`, or the field name is wrong. Unresolved braces are deleted silently. |
| `{%math%}` returns `0` | a variable in the expression did not resolve; any surviving letter forces `0`. |
| A mirror table does not exist | `general-settings.Autosync` is off for that sheet, or the sync worker is down. |
| Mirror data is old | the queue is backed up, or Autosync was switched off after the table was created. |
| No realtime event on a write | no realtime-enabled `VizLiveappsContent` bound to the sheet, or `disable_realtime` is set. |
| Nothing in `VizWorkflowLog` | `enable_log == '1'` — the flag is **inverted**. |
| Blank autosuggestion | `workflow_id` sent instead of `workflowId`, or a short code instead of the Mongo id. |
| Block settings lost keys | `customblockPropInsert` replaces; the save did not echo them back. |
| Diagram transposed | the `xPos`/`yPos` axis swap. |
| 500 from `/sys/api.v1` with a bearer | a malformed JWT — `decodeJWT` throws rather than returning 401. |
| Browser CORS failure on a trigger | the origin is not in the hard-coded allow-list in `Trigger.php`. |
| 200 but the body reads `Internal Server Error` | a block threw. The status only says the workflow ran. |
