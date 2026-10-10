# Platform state — what exists on innov-dev, and how it was built

Companion to [PLAN.md](PLAN.md). PLAN.md says what to build; this file records
what is **already built and verified** on
`https://innov-dev.beta.injomo.com`, and the save protocol that was reverse
engineered to do it. Read this before touching the platform again — it will
save you the hour it cost to work out.

App: **Plug-In Integration**, `lid 3111`, short code
`pluginintegration6ac8cea6bde3e`. All URLs below carry `?_ls=2170-3111`.

## Spreadsheets (Part A) — done

| Sheet | ssid | short code |
|---|---|---|
| `VendorsV2` | `6acab4d2701586f2950208c3` | `vendorsv26acab4d288693` |
| `VendorOnboardingSessionsV2` | `6acab508b76bb25d3f0d1482` | `vendoronboardingsessionsv26acab508e8986` |
| `VendorFeaturesV2` | `6acab523701586f2950208c4` | `vendorfeaturesv26acab523c5621` |
| `VendorApiInfoV2` | `6acab53f3d2759968f006e52` | `vendorapiinfov26acab53fe7a99` |

Columns are as PLAN.md Part A specifies.

### The trap that cost a rebuild

**On the new-sheet grid, column 0 is the reserved row-key slot.** Type the
first real heading into column **1**, not column 0. A heading typed into
column 0 is swallowed: the sheet is created without it, and that column never
appears in a block's mapping dropdown.

The first four sheets (`Vendors`, `VendorOnboardingSessions`, `VendorFeatures`,
`VendorApiInfo` — no `V2`) were created that way and each lost its id column.
They are **empty and superseded**; delete them and rename the `V2` sheets.

### Creating a sheet without clicking cells

Open `/ls/livespace/spreadsheet.html?_ls=2170-3111`, then in the page:

```js
const h = window.hot3[''];                    // Handsontable instance, keyed by sheet id ('' = new)
h.setDataAtCell(labels.map((l, i) => [0, i + 1, l]));   // row 0, from column 1
document.querySelector('input[placeholder=Name]').value = 'SheetName';
[...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Save').click();
```

`POST /ls/livespace/spreadsheet.save/` answers
`{"Result":{"sid":{"$oid":"<ssid>"},"status":"success"}}`.
List sheets with ids and short codes:
`POST /ls/livespace.sslist/3111` with `X-Requested-With: XMLHttpRequest`.

## Workflows (Part B) — partly done

`MarketPlaceOnboard_SaveInformation`, Mongo id **`6aca3328fecb4fbd9c009c63`**,
short code `marketplaceonboardsaveinformation6aca3328c7c44`.

Its real graph:

```
Entry (datatransfer 2001_3)
 └─ CheckAction 5001_4  {Entry.action}==add_vendor
      yes → VendorID 1700_11  (setvariable Value={viz-uuid})
             └─ InsertVendor 1800_8 → Out 1700_12
      no  → CheckAction 5001_6  {Entry.action}==update_api_info
              yes → UpdateVendorDetails 2000_9 → Out 1700_14
              no  → CheckAction 5001_7  {Entry.action}==update_vendor_feature
                      yes → UpdateVendorDetails 2000_10 → Out 1700_15
                      no  → CO 2049_13 (clearoutput)
```

### Fixed and verified

1. **`InsertVendor` (1800_8)** now points at `VendorsV2` and has a field
   mapping. A live `create_vendor` call writes a real row — confirmed:
   `bf29b90a-… | Molaris Dental Imaging Ltd.` in `VendorsV2`.
2. **Conditions 5001_6 and 5001_7** compared the literal string `action`
   against their value (`action==update_api_info`), so they could never be
   true — only `add_vendor` was reachable. Both now read `{Entry.action}`.

The HTML error noise that used to precede the JSON
(`Invalid SpreadsheetId` … `SpreadsheetOperationsBlock.php Line: 285`) is gone
for the `add_vendor` path.

### Still to do

- **`2000_9` (update_api_info) and `2000_10` (update_vendor_feature)** still
  point at no sheet. Before wiring them, settle a design question: the tool
  passes `vendor_api_info` as a **JSON string**, which cannot map onto the
  discrete `BaseUrl` / `AuthMethod` / `Environment` columns. Either give
  `create_vendor` discrete parameters, or parse the JSON inside the workflow.
- Both are `updatessdata`, which **no-ops when no row matches** — a silent
  failure. Convert them to `insertorupdatessdata` (palette id 1900) via
  `objectInsert` + `connectionInsert`/`connectionDelete` + `objectDelete`.
- The tool has **no `session_id` parameter**, so nothing can write
  `VendorOnboardingSessionsV2`. Add it to `skill_workflow_config` on the agent
  block (`4211_4`), or pass it through `static_inputs`.
- `GetApplication`, `StartSession`, `SubmitApplication` (PLAN.md B2–B4) are not
  built.
- Indexed columns are not set on any sheet.

## The save protocol, as actually verified

Session cookie only. `/sys/api.v1` is **not** usable here — it answers
`401 Invalid API Authentication Credentials` even with a valid session, because
it wants API credentials. Everything below is same-origin `fetch` from a
signed-in page, with `X-Requested-With: XMLHttpRequest`.

**Bootstrap first.** `GET /workflow.debugger/<idOrShortCode>` re-seeds the PHP
`workflow` session. Posting to the session before that silently creates a
partial entry.

| Need | Call |
|---|---|
| Read a workflow's blocks | `GET /workflow.settings/<shortCode>/json` — the JSON is embedded in `Body` inside a `JSONView( … )` call; brace-match it out |
| Read one block's settings form | `GET /workflow.customblockpopup/<wfId>/<blockId>` |
| Write block properties | `POST /workflow.savesession`, `eventType=customblockPropInsert` |
| Write a connection's field mapping | `POST /workflow.savesession`, `eventType=connectionPropInsert` |
| Commit to Mongo | `POST /workflow.save` with `workflow_id`, `name`, `ajaxwrkflwIds` → "Stencil saved successfully" |

### Block properties

`customblockPropInsert` **replaces** `block_properties` — echo every key you
want to keep. Everything you post lands inside `block_properties`, so do not
try to write the sibling `properties` key this way.

```
eventType=customblockPropInsert & workflow_id=<wfId> & sourceId=<blockId>
& blockType=insertssdata & label=InsertVendor & description= & test=
& d_master_ssid=3111 & ssid=<sheet ssid> & ss_short_code=
& sstabaction_source-1[]=app list & dynamic_flag=false & debug_mode=0
```

### Field mapping — the part that is easy to get wrong

A spreadsheet write block's column mapping is **not** a block property. It is a
property of the **connection feeding it**, stored on the target block as
`properties: { action, "field-mapping": [{ keyvalue, insertcolumn }] }`.

The parameters are `mapleft[]` (the value or `{expression}`) and `mapright[]`
(the column **label**), repeated in pairs and posted to the **session**:

```
eventType=connectionPropInsert & workflow_id=<wfId> & workflowId=<wfId>
& sourceId=<the block BEFORE it> & targetId=<the spreadsheet block>
& connection_action=READ
& mapleft[]={VendorID.Value}      & mapright[]=VendorId
& mapleft[]={Entry.vendor_name}   & mapright[]=LegalEntity
& mapleft[]=draft                 & mapright[]=Status
```

Dead ends, so you do not repeat them: `field-mapping[0][insertcolumn]`,
`fieldmapping[…]`, `field_mapping[…]`, `properties[field-mapping][…]`,
parallel `insertcolumn[]`/`keyvalue[]`, and indexed `insertcolumn[0]` are all
silently dropped. `POST /workflow/connection.properties` with
`action=READ` is the tab's **loader**, not a writer.

`mapright[]` only offers columns the sheet really has — a quick way to confirm
a sheet's shape is to read that select's options after setting the block's
`ssid`.
