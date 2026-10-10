# Spreadsheets

A Vizru spreadsheet is two MongoDB collections plus one MySQL row, and
optionally a mirrored PostgreSQL table. `$APP/sys/livespaces/livespace/Spreadsheet.php`
(6.7k lines) is the whole engine.

## The three places a sheet lives

### 1. `viz_livespace_files` (MySQL) — the registry

Every document in an app is a row here. This is the **only** place a
`short_code` maps to a Mongo id, and every shortcode lookup in the platform
goes through it.

```sql
SELECT fid, lid, uid, cid, dir_path, short_code, title, mime_type
  FROM viz_livespace_files
 WHERE tid = ? AND short_code = ? AND flags != 0;
```

- `dir_path` **is** the `VizSpreadsheet._id` (as a 24-hex string)
- `short_code` is `strtolower(alnum-stripped title) . uniqid()`
  (`aString::createShortCode`), e.g. `Products` → `tasklist6a65dfa47281c` —
  note it is generated from the *document* title at creation, so renaming the
  sheet later does not change it
- `mime_type = 'spreadsheet'` distinguishes sheets from uploads and grids
- `flags != 0` means not deleted
- `lid` is the app (livespace) id; `cid` the collection (0 = app root)

### 2. `VizSpreadsheet` (Mongo) — the header document

```
{ _id, _tid, title, desc, short_code, header, column-settings,
  general-settings, created-by, created-at, updated-at, _flags }
```

`header` is an **array of single-key maps**, positional:

```json
[
  { "row_id":     "1d05950736d0f4635d54482d15cf8496" },
  { "updated_by": "systemuser@vizru.com" },
  { "row_meta":   { "last_updated": "2026-08-01T12:31:54.000Z" } },
  { "d831d9be57361eace52d0c98bce5049c": "ProductID" },
  { "6b6017149a02bb5db211cac2c9dbce7c": "ProductName" }
]
```

Indices 0, 1, 2 are always the meta columns `row_id`, `updated_by`, `row_meta`.
**From index 3 on, the key is the storage key and the value is the visible
heading.** Data columns therefore start at index 3 — this is why the code is
full of `array_slice(…, 3)` and `if ($hkey < 3) continue;`.

Column keys are `md5(tid # uid # microtime())` from `getUniqueColId()`, so they
are opaque and per-sheet. A column promoted to an indexed key is renamed to
`indexColumnNo01`…`indexColumnNo05` (`updateColumnToIndexKey`, max five per
sheet, `getFreeIndexedColumns` reports what's left), and those keys are indexed
in Mongo.

### 3. `VizSpreadsheetRows` (Mongo) — one document per row

```
{ _id, ssid, _tid, row_id, updated_by, row_meta: { last_updated },
  created-at, <columnKey>: value, … }
```

- `ssid` is usually an `ObjectId`, but older tenants store the 24-hex string.
  Match both — the sync worker's `_ssid_filter()` uses
  `{"$in": [ObjectId(x), x]}` for exactly this reason.
- `row_id` is a UUID v4 (`getUniqueRowId()`); it is the stable row identity and
  the mirror's `_row_id`.
- Indexes: `_tid`, `ssid`, `indexColumnNo01`–`05`.

## Column datatypes

`column-settings[<columnKey>]`:

```json
{ "datatype": { "type": "date", "format": "DD/MM/YYYY", "fmtype": "Custom" },
  "column-link": "…" }
```

`getCastDataByColumnKey()` casts on write:

| `type` | Stored as | Notes |
|---|---|---|
| `string` | string | the default when `column-settings` has no entry |
| `integer` | int | commas stripped; a default of `"null"` stores `''` |
| `float` | float | same |
| `date` | formatted string via `Misc::setDateFormat` | `fmtype: "Custom"` changes parsing |
| `datetime` | `UTCDateTime` | format is `<date> <time>`; date part one of `MM-DD-YYYY` `MM/DD/YYYY` `M/D/YYYY` `DD-MM-YYYY` `DD/MM/YYYY` `D/M/YYYY` `YYYY-MM-DD` `YYYY/MM/DD` `MMM DD,YYYY` |
| `file` | `''` | the cell never holds the bytes |

A `column-link` column stores an `<a>` tag; the caster strips it back out.

Postgres mapping (`SyncSchema::TYPE_MAP`):
`string`→`text` · `integer`→`bigint` · `float`→`double precision` ·
`date`→`date` · `datetime`→`timestamptz` · `file`→`text`.

## `general-settings`

Sheet-level UI and behaviour flags. Observed keys in this instance, by
frequency: `rowsize`, `lockHeader`, `lockColumnOperation`, `tagEnabled`,
`fixedColumn`, `defaultSortOrder`, `pagination`, `showLastRecords`,
`mincolwidth`.

**`Autosync`** is the one that matters to a client: `Sync::isEnabled()` reads
`general-settings['Autosync']`, and nothing is queued to the relational mirror
without it. In this instance **no sheet has it set** — see
[mcp-server.md](mcp-server.md#sync-pipeline).

## Reading rows

`getSSDataArray()` is the workhorse. Full signature:

```php
getSSDataArray(
  $limitedMetaFlag = false,   // trim the meta columns from each row
  $pFilter = [],              // filter spec (below)
  $skipLinkPrep = false,      // don't expand column-link columns
  $embedFormula = false,      // return formulas rather than computed values
  $pStart = 0, $pSize = 1000,
  $returnTotalCount = false,
  $skipRecentRule = false,
  $pSortOption = [],          // { columnKey => 'asc'|'desc' }
  $pSelectFields = [],
  $isKeyValueRes = false,     // keyed by column key instead of positional
  $isYield = false,           // return a generator (the big_data path)
  $distinctColKey = '',
  $reflexiveParams = false
)
```

Default page size is **1000 rows**. `$isYield` returns a generator, which is
what `ssdatafilter`'s `big_data` switch produces and only
`executeworkflow` + `loop` knows how to consume (it arrives as
`output['viz_yield_key']`).

Other read entry points: `getSSDataObject`, `getRowByRowId`,
`getSSDistinctColumnValues`, `getSSColumnAllValues`, `getSsModifiedResult`
(template/grid-shaped), `getAdvSSDataArray` (the two-sheet join behind
`ssadvdatafilter`), `getRows`, `getSSAutoIncNextVal`, `getChildCount`.

### Filter spec

Workflow blocks build a `filter_list` of `{ key, value, operator }` where `key`
is the column **label**; the engine translates label → key and the operator
string → a Mongo operator. See the operator table in
[blocks.md](blocks.md#spreadsheet-blocks). Beyond plain Mongo operators the
engine also supports `btwn`, `like`, `!like`, and case-insensitive `$ini` /
`$nini` / `$regex`, which it expands itself.

## Writing rows

| Method | Use |
|---|---|
| `addNewSS($p, $noMetaColumnFlag, $pFlags)` | create a sheet; `$p = {title, desc, short_code, header[], rows[][], email}`. With `$noMetaColumnFlag` the three meta columns are prepended for you. Inserts rows with `insertMany`. |
| `insertRow($p)` / `insertRows($p)` | append; `$p = {ssid, row, sstid, userEmail, eventSource}` |
| `insertDataRowMultipleCell($p)` | insert addressing cells by key |
| `updateRow`, `updateDataRow`, `updateDataRowCell`, `updateDataRowMultipleCell($p)` | update; the last takes `{_tid, ssid, row_id, col_details: {key: value}, eventSource}` |
| `deleteDataRow($p)` | delete rows |
| `copyPasteData($p)` | bulk paste; `$p = {ssid, newrows, updrows, hdrrows, eventSource}` — what `tospreadsheet` uses |
| `insertNewColumn`, `removeColumn`, `updateHeaderRow` | schema changes |
| `updateColSettings`, `updateSingleColumnSettings`, `updateAllColumnSettings`, `updateColumnDataType` | datatypes and per-column config |
| `updateColumnToIndexKey($newKey, $currentKey, $ssId)` | promote a column to an indexed key |
| `updateMetaData`, `deleteSS` | housekeeping |

`eventSource` (`'ss'`, `'workflow'`, …) is how the realtime layer decides
whether to broadcast an update and how to label it.

Every mutation that changes shape or rows should call the matching
`Sync::` method so the mirror follows — see
[mcp-server.md](mcp-server.md#sync-pipeline).

## Per-request caches

Two `$GLOBALS` caches avoid re-reading inside one request:
`$GLOBALS['SpreadsheetCache'][$ssid]` (whole documents) and the instance-level
`colKey` / `colDataTypesByKey`. Plus `$GLOBALS['WorkflowIdCache']` and
`$GLOBALS['WorkflowSCCache']` on the workflow side. Loading a sheet twice in a
request is cheap; mutating it and re-reading in the same request may serve
stale data.

## Key/label helpers

```php
$ss->getAllColKeysHeaders()    // { columnKey => label }   ← label lookup
$ss->getAllColHeadersKeys()    // { label => columnKey }   ← key lookup
$ss->getAllColHeaders($h, $limitedMetaFlag)  // ordered labels
$ss->getAllColKeys()           // ordered keys
$ss->getColumnKey($label)      // one label → key
$ss->getColumnHeader($key)     // one key → label
$ss->getColKeyByIndex($i)      // positional
$ss->getColDataTypeByKey($key) // { type, format, fmtype }
$ss->getSSshortcodeBySSid($id)
```

## Loaders

```php
$ss->loadBySSId($ssid, $tid = 0);                      // by Mongo id
$ss->loadBySSShortCode($code, $tid = 0, $lidFlag = false);  // $lidFlag returns the MySQL row instead
$ss->loadBySSIdWithLid($ssid, $lid, $tid = 0);         // scoped to an app
$ss->loadBySSShortcodeWithLid($code, $lid, $tid = 0);
$ss->loadSSObjectWithData($ssid, $ssData = false, $tid = 0);
```

The `WithLid` variants fall back to `VizSharedTemplates` when the sheet is not
owned by that app — that is how a template shared into an app resolves.

## Logging

`VizSpreadsheetLog` (indexed on `_tid`, `ssid`) records row-level changes when
column activity logging is on (`getColumnActivityLogStatus`).
`SpreadsheetLog.php` is the model.

## Services (callable over `/sys/api.v1`)

`$APP/sys/services/livespace/spreadsheet/`:

| `op` | Purpose |
|---|---|
| `livespace.spreadsheet.create` | New sheet. `livespace-id` (req), `name` (req), `collection-id`, `description`, `columns[]`, `rows[][]`, `user-id`. Returns `FileId` + `SpreadsheetId`. Generates the short code and registers the file. |
| `livespace.spreadsheet.ssinsert` | Append one row. `ssid` (req) plus one parameter per column **label**; unknown labels are ignored, missing ones become `''`. |
| `livespace.spreadsheet.ssupdate` | Update the first row matching a filter. `master-ssid`, `filter-key` (label), `filter-value`, `tenant-id`, plus one parameter per column label to set. |
| `livespace.spreadsheet.spreadsheetdetails` | Sheet metadata. |
| `livespace.spreadsheet.projection` / `projection1` | Projected reads. |
| `livespace.spreadsheet.convert` / `convertkvp` | Positional ↔ key/value row shapes. |
| `livespace.spreadsheet.customfilterprocess` | The full filter/rule pipeline (1k lines). |
| `livespace.spreadsheet.ssindexing` | Manage indexed columns. |
| `livespace.spreadsheet.ssdownload` | Export. |

`Ssinsert` writes with `userEmail = 'workflow@vizru.com'`, so rows created this
way are attributable.

## Gotchas

- Column **labels are not unique** and not validated. Two columns can share a
  heading, and `array_search` on the label map then returns the first.
- `ssid` type drift (ObjectId vs string) in `VizSpreadsheetRows` breaks naive
  queries silently — match both.
- Meta columns are positional, not named, in the array-shaped read paths. Use
  `$isKeyValueRes = true` if you want keyed rows.
- `getSSDataArray` caps at 1000 rows by default. A "missing data" bug is
  usually a forgotten `$pSize`.
- Deleting a sheet must also `Sync::dropped($ssid, $tid)` or the mirror lingers.
