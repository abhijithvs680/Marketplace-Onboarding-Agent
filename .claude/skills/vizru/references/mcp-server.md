# MCP server

`vizru-mcp-server/` — a FastAPI service on **:9101** (container `mcp-server`)
holding four separate concerns behind one basic-auth boundary:

1. **Read access to the PostgreSQL mirrors** of Vizru spreadsheets
   (`/api/query`, `/api/schema`), plus the same two capabilities as MCP tools
   over JSON-RPC (`POST /mcp`).
2. **A tool-result store** so an Agent Node can reference a large result by id
   instead of re-sending it every iteration (`/api/tool-result/*`).
3. **Agent conversation memory** (`/api/memory/*`).
4. **A RAG pipeline** over a *separate* pgvector database (`/rag/*`).

Plus an in-process **sync worker** that consumes spreadsheet change events from
Redis and reconciles the mirror tables.

The PHP client is `$APP/sys/workflow/block/McpClient.php`. Its expectations are
the contract: basic auth, a **bare JSON array** of row objects from
`/api/query`, and a 200 with a JSON body from `/api/schema`. Anything else the
caller reads as the service being unavailable.

## Configuration

| Service env | Platform constant (`$APP/config/env-docker.php`) | Default |
|---|---|---|
| `MCP_API_USER` | `McpApiUser` | `vizru` |
| `MCP_API_SECRET` | `McpApiSecret` | `vizru_secret_key` |
| container + `9101` | `McpServerUrl` | `http://mcp-server:9101` |
| `DATABASE_URL` | — | (Neon pooled endpoint — use the `-pooler` host) |
| `RAG_DATABASE_URL` | — | unset ⇒ `/rag/*` answers 503 |
| `MAX_ROWS` | — | **1000 in this deployment** (README says 500) |
| `STATEMENT_TIMEOUT_MS` | — | **8000 here** |
| `MIRROR_TABLE_PREFIX` / `MIRROR_SCHEMA_PREFIX` | — | `ss_` / `t` |
| `SYNC_WORKER_ENABLED` | — | `1` (set `0` on read replicas) |
| `SYNC_QUEUE_KEY` | `SyncQueue::QUEUE_KEY` | `vizru:ss-sync:events` |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_DB` / `REDIS_PASSWORD` | the `pcache` registration | `receiver-redis` / 6379 / 1 |
| `MONGO_URI` | the `nosql` registration | the platform's Mongo |

Read the running env rather than the README — `probe.mjs mcp` prints it.

## Naming

| Platform | PostgreSQL |
|---|---|
| tenant `204` | schema `t204` (`tenant.py: schema_for`) |
| spreadsheet short code `EMP001` | table `ss_emp001` (lower-cased: Postgres folds unquoted identifiers, and the blocks reference these unquoted) |
| row `row_id` | column `_row_id` (primary key, the upsert target) |
| — | column `_synced_at` (mirror-owned) |
| column key `<md5>` | column `"<md5>"` — **case-sensitive, must be double-quoted in SQL** |
| indexed column | column `indexColumnNo01`…`05`, indexed in Postgres too |

A short code containing anything but `[A-Za-z0-9_]` is rejected rather than
escaped.

## Endpoints

Everything except `GET /health` and `GET /rag/health` requires HTTP basic auth
(constant-time comparison). There is no OpenAPI/docs route — it is an internal
service.

### `GET /health`
Liveness plus a real database round trip. `{"status":"ok"}`, or 503
`{"status":"degraded","detail":…}`.

### `POST /api/query`
```json
{ "query": "SELECT \"TaskID\" FROM ss_emp001 WHERE \"Status\" = 'open'",
  "tid": 204,
  "allowed_tables": ["ss_emp001"] }
```
Answers a **bare JSON array** of row objects. `allowed_tables` is optional and
narrows the statement further *within* the tenant — the Agent Node sends the
sheets its block was configured with. Errors come back as
`{"detail": "…"}` with 400 (refused) / 404 / 500.

### `GET /api/schema?shortcode=EMP001&tid=204`
```json
{ "table": "ss_emp001", "short_code": "EMP001",
  "columns": [
    { "name": "_row_id", "label": null, "type": "text", "nullable": false },
    { "name": "_synced_at", "label": null, "type": "timestamp with time zone", "nullable": true },
    { "name": "indexColumnNo01", "label": "Deal_ID", "type": "double precision", "nullable": true },
    { "name": "102c98d9c15c65916da473f434b6b421", "label": "AppReq_GDID", "type": "double precision", "nullable": true }
  ] }
```
`label: null` marks a mirror-owned column. **`name` goes in the SQL; `label` is
what a human means.** 404 when the sheet has no mirror ("It may not be synced
yet, or the short code may be wrong"). Response JSON is compact-encoded because
it gets pasted into a model's system prompt.

### `POST /mcp` — JSON-RPC
Implements `initialize`, `tools/list`, `tools/call` (protocol version
`2025-06-18`, server `vizru-mcp-server/1.0.0`). No resources or prompts are
advertised. A batch (JSON array) is accepted; an all-notification batch answers
202 with no body.

Two tools, sharing `tools.py` with the REST surface so the two can never drift:

- `query_database(sql_query, tid)`
- `describe_spreadsheet(shortcode, tid)`

A refused query comes back as an **errored tool result** (`isError: true`), not
a JSON-RPC error — the model is meant to see it and correct itself.

### Tool-result store

Rationale: an agentic loop re-sends its whole message array each iteration, so a
25k-token table dropped in at iteration 2 of a twelve-iteration run costs a
quarter of a million input tokens by the end. Nothing is truncated — rows stream
from the query straight into `tool_result_row`, the model is told the exact row
count, and `read_result` pages the rest.

Tables, created on demand in the tenant's schema: `tool_result`
(id, thread_id, run_id, iteration, tool_call_id, tool_name, tool_type, input,
result_type, result, columns, row_count, est_tokens, source_query, created_at)
and `tool_result_row` (result_id, seq, row).

| Endpoint | Body |
|---|---|
| `POST /api/tool-result/query` | `{query, tid, thread_id (req), run_id, iteration, tool_call_id, tool_name, tool_type, input, allowed_tables, preview_rows}` → a reference, the exact row count and a short preview. Never the whole result. |
| `POST /api/tool-result` | `{tid, thread_id, result_type: json\|text\|file\|table, result, …}` — stores a non-table result whole (an HTTP/workflow/skill result has no re-runnable source). 413 when too large. |
| `POST /api/tool-result/read` | `{tid, thread_id, result_id, offset, limit, columns}` — pages it back. `MAX_PAGE_ROWS` caps one page (200). |

Tunables: `CAPTURE_BATCH` (1000), `PREVIEW_ROWS` (5), `MAX_PAGE_ROWS` (200).

### Agent memory

Three tables, and they are not the same thing:

- `agent_message` — every message, append-only, never deleted. The record.
- `agent_state` — keyed facts the agent chose to keep. **Overwritten, not
  appended**, so a value like a booking status has one reading.
- `agent_thread` — counters.

Nothing here is ever replayed into a prompt. Search is Postgres' own: a
generated `tsvector` with a GIN index plus trigram similarity for near-misses
(floor 0.15), so recall costs no embedding call in either direction.

| Endpoint | Body |
|---|---|
| `POST /api/memory/append` | `{tid, thread_id, run_id, messages: []}` |
| `POST /api/memory/recall` | `{tid, thread_id, query, top_k}` — searches that thread only |
| `POST /api/memory/facts` | `{tid, thread_id, action: get\|set\|delete, key, value}` → `{facts}` |
| `POST /api/memory/open` | `{tid, thread_id}` → counters + facts in one round trip (runs before every memory-enabled call, so a second trip is latency the user feels) |

### RAG (`/rag/*`)

A **separate** Neon database with pgvector (`RAG_DATABASE_URL`). The `vector`
extension and `rag_documents` / `rag_chunks` are created idempotently at
startup; without the URL these endpoints answer 503 and nothing else is
affected.

- **Extraction:** PDF (per page), DOCX (tables in reading order), PPTX (per
  slide with notes), XLSX (per sheet), CSV/TSV, HTML, JSON, XML, images (PNG,
  JPEG, GIF, WEBP, BMP, TIFF, ICO), any text format.
- **Images:** a vision model (`RAG_VISION_MODEL`) writes a description —
  transcribing visible text, reading out tables, charts and diagrams — inserted
  at the image's exact position and wrapped as `[Image n | page 3] … [/Image n]`.
  A chunk containing any part of one lists it in `metadata.images`. Repeated
  images (a logo) are described once; blank, decorative, and sub-`RAG_IMAGE_MIN_SIDE_PX`
  images are skipped. A scanned PDF page is indexed through its page image.
- **Chunking:** recursive, token-measured (paragraph → line → sentence → clause
  → word → token window). Defaults 800 tokens / 150 overlap, per-request
  overridable.
- **Embeddings:** `text-embedding-3-large`, 3072 dimensions, packed to fit
  OpenAI's per-request limits, retried with backoff.
- **Search:** exact cosine similarity **plus** Postgres full-text, fused with
  reciprocal rank. No approximate index, so tenant/project/document filters
  never drop matches.

| Endpoint | Body |
|---|---|
| `POST /rag/ingestion` | `{tid, project_id, file_url, api_key?, document_id?, file_name?, metadata?, chunk_size?, chunk_overlap?, describe_images?}`. Re-ingesting an existing `document_id` writes a new generation; searches switch only once every chunk is stored, and a failure leaves the previous content intact. |
| `POST /rag/doc/delete` | `{tid, document_ids}` (CSV or list). Ids owned by another tid come back as `not_found_document_ids`. |
| `POST /rag/retrieve` | `{tid, query, project_id?, document_ids?, search_type: hybrid\|semantic\|keyword, top_k?, min_similarity?, semantic_weight?, keyword_weight?, context_window?, api_key?}` |
| `GET /rag/health` | vector DB reachability, no auth |

Scope: `document_ids` wins over `project_id`; with neither, the whole tenant is
searched. **Nothing caps file size, chunk count, documents per project, or
results — omitting `top_k` returns every matching chunk.**

## What stops a bad query — five layers

The SQL here is written by people and by language models, so the same rules are
enforced in more than one place.

1. **The schema.** The statement runs with `search_path` set to the caller's
   tenant, so a bare table name cannot name another tenant's sheet — Postgres
   answers "relation does not exist". This is the boundary that matters, and the
   database enforces it. *Verified: tid 205 cannot see `ss_appointments…` in t204.*
2. **The block.** `SqlReadGuard.php` refuses anything but a single read-only
   SELECT before the request is made; the Agent Node additionally restricts to
   its configured sheets.
3. **This service.** `guard.py` applies identical rules again — the workflow
   engine is not the only thing that can reach this port, and a guard the caller
   owns is not a guard. Both refuse the two ways out of a `search_path`: a
   schema-qualified name, and a FROM-clause function call that is not a known
   set-returning function (`generate_series`, `unnest`, `string_to_table`,
   `regexp_split_to_table`, the `json*`/`jsonb*` expanders).
4. **The session.** Every pooled connection runs with
   `default_transaction_read_only = on`. This catches what a regex cannot:
   `SELECT … FOR SHARE` takes row locks and trips no keyword, and the database
   rejects it.
5. **The clock and the row count.** `statement_timeout` kills a runaway query;
   `MAX_ROWS` caps what comes back.

Forbidden keywords (`guard.py::_FORBIDDEN`), checked outside string literals:
`INSERT UPDATE DELETE MERGE UPSERT TRUNCATE DROP ALTER CREATE RENAME GRANT
REVOKE COMMENT COPY CALL DO EXECUTE PREPARE DEALLOCATE VACUUM ANALYZE REINDEX
CLUSTER REFRESH LOCK LISTEN UNLISTEN NOTIFY BEGIN START COMMIT ROLLBACK
SAVEPOINT SET RESET DISCARD INTO`. (`INTO` is there because `SELECT … INTO`
creates a table.) The statement must start with `SELECT` or `WITH`; CTE names
are recognised and exempted from the table allow-list.

**The gap:** `tid` is a value the caller sends, and the basic-auth credential is
shared by everything that reaches this service. The schema boundary stops a
*statement* escaping its tenant; it does not stop a caller holding the
credential from claiming a different tid. Per-tenant credentials, or a signed
tid, is what closes that.

## Sync pipeline

The platform never issues DDL or DML against Postgres. It publishes **intent**
to a Redis list; the worker inside `mcp-server` applies it.

### Publisher (PHP)

`$APP/sys/services/livespace/spreadsheet/`:

- **`Sync.php`** — the only thing the platform calls.
  `isEnabled($ss)` reads `general-settings['Autosync']`;
  `rowsChanged($ss,$lid,$rowIds)` · `rowsDeleted(…)` ·
  `schemaChanged($ss,$lid)` · `enabled($ss,$lid)` (schema + backfill) ·
  `disabled($ss,$lid)` · `dropped($ssid,$tid)`.
- **`SyncSchema.php`** — `describe($ss,$lid)` builds the descriptor:
  `{table, ssid, tid, lid, short_code, primary_key: "_row_id", columns: [{key, name, type, source, indexed}]}`.
  Skips `row_id`/`updated_by`/`row_meta`; `indexed` is
  `strpos($colKey,'indexColumnNo') === 0`. Returns `null` when the sheet has no
  short code, which is the signal to publish nothing.
- **`SyncQueue.php`** — `LPUSH` onto `vizru:ss-sync:events` (Redis conf
  `pcache`), then `LTRIM` to `MAX_DEPTH` 50000. 1-second connect timeout, and
  **a Redis failure silently drops the event** (logged via `error_log`, never
  raised) — the user must not wait for the mirror.

Event kinds: `schema.sync` · `rows.upsert` · `rows.delete` · `table.backfill` ·
`table.drop`. Each carries `queued_at`.

### Worker (Python)

`sync_worker.py` runs as a thread inside the MCP server — the tables it writes
are the ones the query endpoints read, so one process owning the pool and the
`ss_*` naming keeps them from disagreeing. `BRPOP` gives FIFO and blocks instead
of polling.

`sync_apply.py` is built on two properties:

- **Reconciliation, not migration.** A `schema.sync` event says what the table
  *should* look like, not what changed. Adding a column, renaming one, changing
  a datatype and promoting one to an index all take the same path, and a table
  that drifted — a missed event, a hand edit — is repaired by the next event.
- **Re-read, not replay.** Row events carry **ids only**; the current row is
  read from Mongo at apply time. Events are therefore idempotent and order does
  not matter.

Safety: every identifier goes through `psycopg.sql.Identifier` (quoted and
escaped), with an allow-list `^[A-Za-z0-9_$]+$` as defence in depth — a leading
digit is deliberately allowed, because MD5 column keys start with one about five
times in eight. Types are restricted to
`text, bigint, double precision, date, timestamptz, boolean, numeric`.
Identifiers are clipped to stay inside Postgres' 63-byte limit; index names are
`ix_<table>_<column>`.

### Operational reality in this instance

`probe.mjs sync` reports **no sheet with `general-settings.Autosync` set**, a
queue depth of 0, and 27 `ss_*` tables in `t204` written by an older external
pipeline (`ss-sync-pipeline`, referenced in the service README). So:

- Do not assume a sheet is SQL-queryable. Check `/api/schema` first.
- Those existing mirrors will go stale — nothing is feeding them.
- Turning on Autosync for a sheet publishes `schema.sync` + `table.backfill`
  and brings it under the live pipeline.

## Calling it from PHP

```php
use Sys\Workflow\Block\McpClient;

$res = McpClient::query($sql, McpClient::QUERY_TIMEOUT, ['ss_emp001'], $tid);
if (!$res['ok']) { /* $res['error'] */ }
$rows = $res['rows'];

$schemas = McpClient::schemas(['EMP001', 'DEPT001']);   // request-cached per tenant+code
```

Timeouts: `QUERY_TIMEOUT` 60s, `SCHEMA_TIMEOUT` 30s, `RAG_TIMEOUT` 0 (none —
ingesting a large file with images takes as long as it takes). `tid` defaults to
`app()->Tenant->Id`. `baseUrl()` and `credentials()` throw a `RuntimeException`
when the constants are undefined *or blank* — an unset env var leaves the
constant defined and empty.

## Calling it from an MCP client

Point any MCP client at `POST http://mcp-server:9101/mcp` with basic auth. From
outside the compose network you need a published port or a proxy — the container
exposes 9101 internally only. Both tools require an explicit `tid`; there is no
default.
