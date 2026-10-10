---
name: vizru
description: Build React apps, services, agents or MCP clients that connect to the Vizru platform's workflows and spreadsheets. Covers every workflow block and its block_properties, the spreadsheet engine and its Mongo document shape, the Postgres mirrors and the Redis sync pipeline, the MCP server (query/schema/tool-result/memory/RAG), the Agent Node and its skills, the Workflow-UI React studio, auth (session cookie, JWT bearer, hashtoken, auth_token, basic, signed URL), realtime sockets, and how to call a workflow as an HTTP endpoint. Use when writing code that reads or writes Vizru spreadsheets, triggers or authors workflows, streams agent output, or drives workflow.trigger / sys/api.v1 / the MCP server.
---

# Vizru — workflows & spreadsheets

Vizru is a multi-tenant PHP 7 platform (`receiver-web`) whose two durable
primitives are **workflows** (a directed graph of blocks, stored in MongoDB)
and **spreadsheets** (a header document plus one row document per row, also in
MongoDB, optionally mirrored into PostgreSQL for SQL access). Everything else
here — the MCP server, the Agent Node, the React studio — hangs off those two.

Paths below are relative to the repo root (`Vizru-Docker/`). The platform
source lives in `receiver/volumes/web/app-live/v1-web-app/`, abbreviated
**`$APP`** throughout.

## Read this first: the 90% you need

| You want to… | Do this |
|---|---|
| Call a workflow from a React app / any HTTP client | `POST /workflow.trigger/<shortCode>` — the workflow's **first block must be** `genericpost`/`genericget`/`twilio`/`retarusfax`/`retarussms`/`chatfileupload`. See [references/http-api.md](references/http-api.md). |
| Read spreadsheet rows with SQL | `POST /api/query` on the MCP server, table `ss_<lowercased short_code>`, always with `tid`. See [references/mcp-server.md](references/mcp-server.md). |
| Read/write spreadsheet rows through the platform | `POST /sys/api.v1` with `op=livespace.spreadsheet.*`. See [references/http-api.md](references/http-api.md). |
| Know what a block does and what keys it stores | [references/blocks.md](references/blocks.md) — every type, every `block_properties` key. |
| Understand `{variable}` / `{%function%}` templating | [references/templating.md](references/templating.md) — this is the single most load-bearing thing in the platform. |
| Author or edit a workflow graph programmatically | [references/workflow-model.md](references/workflow-model.md) (Mongo shape) + [references/workflow-ui.md](references/workflow-ui.md) (the session-based save protocol). |
| Understand spreadsheet storage, column keys, datatypes | [references/spreadsheets.md](references/spreadsheets.md). |
| Stream LLM output to a browser | Agent Node with `stream=true` + socket.io on 8000. See [references/agent-node.md](references/agent-node.md) and [references/realtime.md](references/realtime.md). |
| Authenticate | [references/auth.md](references/auth.md) — five mechanisms, they are not interchangeable. |
| See how data actually moves end to end | [references/data-flow.md](references/data-flow.md). |

## Verify before you build: run the probe

`probe.mjs` exercises the live stack through `docker exec` and prints what each
surface actually returns. Run it before writing code against any of these
endpoints — it is how every claim in this skill was established, and it will
tell you immediately if a service is down or a tenant has no mirrors.

```bash
node .claude/skills/vizru/probe.mjs
```

Individual sections, when you only care about one:

```bash
node .claude/skills/vizru/probe.mjs mcp
```

`sections`: `containers`, `mcp`, `http`, `mongo`, `mysql`, `sync`. Pass several
space-separated. Exit code is non-zero if any check fails.

To point the probe at a different tenant or spreadsheet:

```bash
VIZRU_TID=204 VIZRU_SS_CODE=gddeal67849a22292f9 node .claude/skills/vizru/probe.mjs mcp
```

## The three rules that break people

**1. A spreadsheet's user-facing column *name* is not its storage *key*.**
Every column past the third is keyed by an MD5 hash generated at creation
(`getUniqueColId()`), and the header document maps key → label. Workflow
filters and connection mappings are written against **labels**; Mongo documents
and Postgres mirror columns are keyed by the **hash**. The MCP `/api/schema`
response gives you both (`name` = hash, `label` = heading) — match the user's
words against `label`, write `name` into SQL.

A column promoted to an indexed key is the exception: its key becomes
`indexColumnNo01`…`indexColumnNo05` (five per sheet), and that is what appears
in Mongo, in the mirror, and in `/api/schema`'s `name`.

**2. `customblockPropInsert` replaces `block_properties`; it does not merge.**
Any key you do not echo back is deleted. Seed every save from the stored
document and overlay your changes.

**3. Coordinates are transposed.** The workflow session stores `xPos` as CSS
*top* and `yPos` as CSS *left*. React Flow wants `{x: left, y: top}`, so
`RF.x = yPos` and `RF.y = xPos`. One conversion site only —
`Workflow-UI/src/graph/convert.ts`.

## Topology

```
                          haproxy :80 :443 :8000 :8001
                                     │
  ┌──────────────────────────────────┼─────────────────────────────┐
  │                                  │                             │
receiver-web (PHP/Apache :443)   receiver-chatsystem          receiver-chatsystem-v2
  │  the platform: controllers,   (socket.io :8000,             (:8001)
  │  services, workflow engine     redis adapter, JWT)
  │
  ├── receiver-mysql   tenants, users, sessions, permissions,
  │                    viz_livespace_files (the ssid ↔ short_code map),
  │                    workflow master exec log
  ├── receiver-mongo   VizWorkflow, VizSpreadsheet, VizSpreadsheetRows,
  │                    VizWorkflowLog, VizWorkflowVersions, VizJobStatus, …
  ├── receiver-redis   session cache (db 1) + the ss-sync event queue
  ├── receiver-rabbitmq + receiver-celery{,-beat,-realtime}  async work
  ├── receiver-pdfgen :3000
  └── mcp-server :9101 ── PostgreSQL (Neon) spreadsheet mirrors,
                          tool-result store, agent memory, RAG (pgvector)
```

Config constants live in `$APP/config/env-docker.php`; the compose-level
knobs are in `options` at the repo root. Names that matter to a client:
`McpServerUrl`, `McpApiUser`, `McpApiSecret`, `InternalSocketServer`,
`ExternalSocketServer`.

## Anatomy of a workflow run

1. An entry point resolves the workflow by **Mongo `_id` or `short_code`**
   (`Workflow::loadWorkflowByShortcode`). Entry points:
   `workflow.trigger` (public HTTP), `workflow.exec` (session required),
   `workflow.init` (UI run), `workflow.startcrontask` (schedule),
   `cli.backgroundexecservice` (background).
2. `Workflow::runWorkflow($parameters, $mode, $_debug_log, $parentLogId, $executed_from, $masterWrkflwID)`
   walks `w_objects` starting at the block whose `source == 0`.
3. Each block gets the previous block's result array and returns a new one:

   ```php
   [
     'status'        => 'yes' | 'no' | 'break',
     'output'        => [ [col => val, …], … ],   // always a list of rows
     'prev_labels'   => ['Entry', 'Filter', …],
     'prev_outputs'  => ['Entry' => [...], 'Filter' => [...]],
     'debugLogData'  => [...],                    // what the debugger shows
     'resultCount'   => int,                      // filter / array-extract
     'httpcode'      => int,                      // livecloud
   ]
   ```

4. Next block = `target`, except on a `condition`, where it is `target_yes` or
   `target_no` based on `status`.
5. `status === 'break'` stops the loop. So does 10 000 block runs
   (infinite-loop protection, throws `WorkflowError`).
6. Every block execution is logged to `VizWorkflowLog` (unless
   `enable_log == '1'`, which means *disabled* — see the gotcha below) and the
   run to MySQL `viz_workflow_exec_log`.

The block registry — the authoritative type → class map — is
`$APP/sys/workflow/Block.php`. The base class with all templating is
`$APP/sys/workflow/block/Block.php`.

## Gotchas that cost real time

- **`enable_log` is inverted.** The engine writes logs when
  `$_logStatus != '1'`. `enable_log = 1` means logging **off**. New workflows
  are created with `enable_log = 1`.
- **A block's `id` is `<obj_id>_<sequence>`** — e.g. `4202_2`, `1800_13`. The
  numeric prefix is the palette id from
  `$APP/sys/controllers/workflow/Leftblock.php`.
- **`livecloudfunction` blocks carry a Mongo ObjectId as `obj_id`**, not a
  palette number. Same for `executeworkflow` (the child workflow's id).
- **A malformed `Authorization: Bearer` on `/sys/api.v1` returns 500**, not
  401 — `decodeJWT` throws after emitting its own header. Verified live.
- **`workflow.exec` returns 401 without a platform session**;
  `workflow.trigger` with `auth_required = "0"` is fully public. Do not
  confuse them.
- **The Autosync toggle may be off everywhere.** `general-settings.Autosync`
  is what drives the Redis sync pipeline, but in this instance no sheet has it
  set and the existing `ss_*` mirrors were written by an older external
  pipeline. Check before assuming a sheet is queryable over SQL — the probe's
  `sync` section does exactly that.
- **`MAX_ROWS` is deployment-specific.** The MCP README says 500; the running
  container has `MAX_ROWS=1000` and `STATEMENT_TIMEOUT_MS=8000`. Read the env,
  don't trust the doc. The `relationalfilter` block separately caps at 500 in
  PHP.
- **`filters` in a spreadsheet block are keyed by column *label*** and paired
  with a parallel `filter_operators` map on the same keys.
- **The workflow engine deletes `{braces}` it cannot resolve.** A prompt or
  parameter containing JSON with braces will be mangled; the Agent Node's
  `live_context_field` exists specifically to route around this.
- **Workflow names are unique per tenant.** `workflow.save` refuses a
  duplicate name with "Stencil name already exist".

## Reference files

| File | Contents |
|---|---|
| [references/blocks.md](references/blocks.md) | Every block type: palette id, class, purpose, full `block_properties`, output shape |
| [references/templating.md](references/templating.md) | `{var}`, `{Label.field}`, `[ut]{}`, `{%fn%}`, built-ins, `{fn…}` custom functions |
| [references/spreadsheets.md](references/spreadsheets.md) | Mongo documents, column keys, datatypes, filter operators, settings, indexed columns |
| [references/mcp-server.md](references/mcp-server.md) | Every endpoint, the MCP JSON-RPC surface, the five guard layers, the sync worker, RAG |
| [references/agent-node.md](references/agent-node.md) | Providers, the agentic loop, tools, skills, memory, result routing, live sessions, RAG |
| [references/http-api.md](references/http-api.md) | `workflow.trigger`, `workflow.exec`, `sys/api.v1` services, CORS, response shaping |
| [references/auth.md](references/auth.md) | Session cookie, JWT bearer, hashtoken, auth_token, basic, signed URL — and which endpoints accept which |
| [references/workflow-model.md](references/workflow-model.md) | `VizWorkflow` document, versions, tags, reusables, schedules, logs |
| [references/workflow-ui.md](references/workflow-ui.md) | The React studio: bootstrap, the session save protocol, every endpoint it uses, dev proxy |
| [references/realtime.md](references/realtime.md) | socket.io rooms, `emit_block`, `ssUpdate`, `background_service`, agent stream frames |
| [references/data-flow.md](references/data-flow.md) | End-to-end paths: request → workflow → sheet → mirror → agent → browser |
| [references/databases.md](references/databases.md) | MySQL tables, Mongo collections and indexes, Postgres mirror layout, Redis keys |
