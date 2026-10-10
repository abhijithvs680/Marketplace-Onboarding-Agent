# Databases

Four stores, each with a distinct job. Nothing is the single source of truth on
its own: a spreadsheet is a MySQL row **plus** two Mongo collections **plus**
(optionally) a Postgres table.

| Store | Container | Holds |
|---|---|---|
| MySQL `vizru` | `receiver-mysql` | tenants, users, sessions, permissions, apps/collections/files — **the `short_code` ↔ Mongo-id registry** |
| MongoDB `vizru-live` | `receiver-mongo` | workflows, spreadsheets and rows, logs, versions, dashboards, charts |
| Redis db 1 | `receiver-redis` | session cache, socket.io room registry, the spreadsheet sync queue |
| PostgreSQL (Neon) | via `mcp-server` | spreadsheet mirrors, tool-result store, agent memory; a second DB for RAG/pgvector |

Registered in `$APP/config/env-docker.php` as `default` (MySQL), `nosql`
(Mongo), `pcache` (Redis), and the `worker` factory (RabbitMQ/Celery).

## MySQL

Schema source: `receiver/volumes/web/app-live/v1-db-mysql/` — `tables/`,
`views/` (5), `procedures/` (**208** stored procedures and functions),
`table-alters/`, `scripts/`. Most access goes through
`$db->call('pProcName', …)`, not raw SQL. `latin1` on most tables, `utf8` on
sessions.

**Every table is tenant-scoped by a `tid` column.** Every query must carry it.

### The ones that matter here

**`viz_livespace_files`** — the document registry. Its `dir_path` **is** the
Mongo `_id` of the document, and `short_code` is the external identifier.

```sql
tid, uid, lid, cid, fid, id (PK, auto), sid, dir_path, file_name, title,
mime_type, file_size, version, description, created_at, app_id, short_code, flags
-- UNIQUE (tid, uid, lid, fid);  KEY (tid, uid, lid);  KEY (tid, uid, lid, cid)
```

`mime_type` is the document kind: `spreadsheet`, `grid3`, `excel`, or a real MIME
type for an upload. `flags != 0` means not deleted.

**`viz_livespace`** — apps ("livespaces"). `lid` is the PK (auto-increment from
1001), plus `name`, `description`, `def_storage_type` (0 company / 1 user),
`def_storage_id`, `order`, `flags`.

**`viz_livespace_collection`** — folders inside an app.
`UNIQUE (tid, uid, lid, cid)`. `cid = 0` is the app root.
`viz_livespace_collection_users` holds per-collection access.

**`viz_workflow_exec_log`** — one row per workflow run. Base columns
`workflow_exec_id` (PK), `tid`, `uid`, `workflow_id`, `name`, `executed_from`,
`description`, `created_at`; later alters add `exec_status`, `finished_at`,
`child_workflows`, `mode`. See [workflow-model.md](workflow-model.md).

**`viz_sessions`** — `PRIMARY KEY (tid, sid)`, plus `uid`, `tenant`, `user`,
`user_source`, `host`, `data`, `created`, `updated`. `sid` doubles as the device
id for JWT device sessions, and `refdata` (added by an alter) stores the issued
JWT.

**`viz_users`** — `uid`, `tid`, `email`, `fname`, `lname`, `flags`, … Loaded
through `pUserGetById`. `flags` carries the enabled bit.

**`viz_template_workflows`** — workflows attached to a livespace template, keyed
`lid`/`cid`/`fid`/`wid`.

**Permissions** — `viz_permissions`, `viz_user_permissions`,
`viz_group_permissions`, `viz_groups`, `viz_user_groups`, `viz_user_tenants`.
Checked via `fUserHasPermissionById`. 1007 = workflow authoring, 113 = app file
download.

**`viz_worker_job_log`** — background worker runs
(`Workflow::addWorkerJobLog()` via `fWorkerJobLogInsert`).

**Also present:** `viz_tenants`, `viz_storage_conf`, `viz_log` +
`viz_log_actions` (audit trail — 35 = stencil created, 36 = updated, 15 =
spreadsheet created), `viz_tags`, `viz_keyvalue`, `viz_object_conf`,
`viz_notification_log`, `viz_saved_dashboard`, `viz_attachments`, `viz_events`,
`viz_tasks`, `viz_messages` / `viz_message_to`, `viz_broadcast*`,
`viz_contact_group*`, `viz_favorites`, `viz_livespace_visits`,
`viz_saml_settings`, `viz_user_source`, `viz_user_linkedin`,
`viz_user_resetpassword`.

## MongoDB

Database `vizru-live`. Index definitions:
`receiver/volumes/web/app-live/v1-db-mongo/collections/indexes/*.js`.

**Every document carries `_tid`.** Every query must filter on it. Objects also
carry `_flags` (`{permanent: false}` by default), `created-by`, `created-at`,
`updated-at`. Soft deletion is the **string** `"true"` in `deleted`, so queries
use `['deleted' => ['$ne' => 'true']]`.

Base class: `Sys\Core\aMongoObject`; queries go through `Sys\Core\MongoQuery`.

### Workflow & spreadsheet collections

| Collection | Indexes | Contents |
|---|---|---|
| `VizWorkflow` | `_tid`, `short_code` | the graph — see [workflow-model.md](workflow-model.md) |
| `VizWorkflowLog` | `_tid`, `log_master` desc | one doc per block execution |
| `VizWorkflowVersions` | `_tid`, `short_code` desc | saved snapshots |
| `VizWorkflowSchedule` | — | cron entries |
| `VizWorkflowUniqueValidator` | — | the `uniquevalidator` lock, keyed `(uniquevalue, workflowID, _tid)` |
| `VizSpreadsheet` | `_tid`, `short_code` | header + column settings — see [spreadsheets.md](spreadsheets.md) |
| `VizSpreadsheetRows` | `_tid`, `ssid`, `indexColumnNo01`–`05` | one doc per row |
| `VizSpreadsheetLog` | `_tid`, `ssid` | row-level change log |
| `VizSharedTemplates` | — | documents shared into another app (`template_shortcode`, `shared_ls_shortcode`) |
| `VizTags` | — | workflow ↔ app association |
| `VizJobStatus` | — | background job state |
| `VizNotification` | — | inbox notifications |
| `VizRecentActivity` | — | recently-opened items per user |
| `VizFavourites` | — | favourites and the block clipboard |

The five `indexColumnNo0N` indexes on `VizSpreadsheetRows` are why a column must
be *promoted* to an indexed key to be filtered efficiently — its storage key is
renamed to one of those slots (max five per sheet).

### Others in the same database

`VizLivecloudApps`, `VizLivecloudAppsFunctions`, `VizLivecloudConnection`,
`VizLivecloudDataset` (the LiveCloud blocks' definitions);
`VizLiveappsContent`, `VizLiveappsFilter`, `VizLiveappsGroupby`,
`VizLiveappsSettings`, `VizLiveappsWorkflow`, `VizObjectsDna`;
`VizAnalyticsGridTemplates`, `VizAnalyticsDatalistTemplates`,
`VizAnalyticsFormTemplates`, `VizAnalyticsHtmlCardTemplates`;
`VizChat`, `VizMediaLibrary`, `VizMenubuilder`, `VizPublishUrl`,
`VizLivespaceEditor`, `VizSharingEvents`, `VizTenantSettings`,
`VizTenantStylesheet`, `VizRelease`, `VizPatchRelease`,
`t-users`, `t-livespaces-roles`, `t-files`, `t-livecloud-connections`.

`VizLiveappsContent` matters even outside dashboards: `Realtime::updateRealtimeData`
looks for a document with `source = "SS##<ssid>"` and `realTime ∈ {1,2,3}` to
decide whether a spreadsheet write fans out over the socket.

## Redis

`receiver-redis`, **db 1**, password from `redis-credentials`. Registered as
`pcache`.

| Key / use | Owner |
|---|---|
| `vizru:ss-sync:events` | the spreadsheet → Postgres sync queue (`LPUSH` from PHP, `BRPOP` in the MCP worker, `LTRIM` to 50 000) |
| session storage | `SessionEngine` |
| socket.io room registry | `socket.io-redis` adapter in `receiver-chatsystem` |

## PostgreSQL (via the MCP server)

Two databases, both external (Neon). `DATABASE_URL` should be the **pooled**
endpoint (the host containing `-pooler`) — the service holds a small pool of its
own and the direct endpoint has a lower connection ceiling.

### Main DB — one schema per tenant

Schema `t<tid>` (`tenant.py: schema_for`). Inside it:

**`ss_<lowercased short_code>`** — a spreadsheet mirror.

| Column | Source |
|---|---|
| `_row_id text PRIMARY KEY` | the sheet's `row_id` (UUID v4). The upsert target. |
| `_synced_at timestamptz` | mirror-owned |
| `"<md5 column key>"` | one per data column, **case-sensitive, must be double-quoted** |
| `indexColumnNo01`…`05` | promoted/indexed columns keep their platform name, and are indexed here too (`ix_<table>_<column>`) |

Types are restricted to `text, bigint, double precision, date, timestamptz,
boolean, numeric`. The meta columns `row_id` / `updated_by` / `row_meta` are
**not** mirrored.

**`tool_result`** — `id, thread_id, run_id, iteration, tool_call_id, tool_name,
tool_type, input, result_type, result, columns, row_count, est_tokens,
source_query, created_at`, indexed `(thread_id, created_at DESC)`.
**`tool_result_row`** — `result_id, seq, row`, PK `(result_id, seq)`.

**`agent_message`** (append-only transcript, `tsvector` + GIN, trigram),
**`agent_state`** (keyed facts, overwritten), **`agent_thread`** (counters).

All of these are created idempotently on first use per tenant schema.

### RAG DB (`RAG_DATABASE_URL`)

A separate database with the `vector` extension: `rag_documents` and
`rag_chunks` (3072-dimension embeddings from `text-embedding-3-large`). Created
at startup by `rag/db/migrations.py`; absent config means `/rag/*` answers 503
and nothing else is affected. **No approximate index** — exact cosine plus
full-text, fused by reciprocal rank, so filters never drop matches.

## Querying by hand

```bash
# MySQL
docker exec receiver-mysql mysql -uvizru -pvizru vizru -e "SELECT ... ;"

# Mongo
docker exec receiver-mongo mongosh "mongodb://vizru:vizru@localhost:27017/vizru-live" \
  --quiet --eval 'db.VizWorkflow.countDocuments({_tid: 11})'

# Redis
docker exec receiver-redis redis-cli -a test -n 1 LLEN vizru:ss-sync:events

# Postgres — mcp-server has no psql; go through its own pool
docker exec mcp-server python -c "
import db; db.open_pool()
print(db.run_select('SELECT 1 AS ok', 1, 't11'))"
```

`probe.mjs mongo mysql sync` does all of this and prints the shapes.

## Cross-store invariants

1. **A spreadsheet exists in three places.** Deleting the Mongo document without
   clearing `viz_livespace_files.flags` leaves a shortcode resolving to nothing;
   without `Sync::dropped()` the Postgres mirror lingers.
2. **`short_code` lives in MySQL, not Mongo** — even though `VizSpreadsheet` and
   `VizWorkflow` both carry a `short_code` field. The MySQL row is what lookups
   read.
3. **`ssid` type drift.** `VizSpreadsheetRows.ssid` may be an `ObjectId` or a
   string. Match both.
4. **`deleted` is the string `"true"`,** not a boolean.
5. **`_tid` / `tid` on every query.** There is no automatic tenant filter.
6. **Postgres is a read replica with a lag.** It only updates when Autosync is
   on and the queue is being drained. Never write to it, and never treat it as
   authoritative.
