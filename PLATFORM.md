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
| `VendorOnboardingMessages` | `6acb4a8910fd15c7f900cf64` | `vendoronboardingmessages6acb4a8961591` |
| `VendorIntake` | `6acb4fa1c9d9be519608d71e` | `vendorintake6acb4fa1eb7eb` |

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

## Workflows (Part B) — done

| Workflow | Short code | Role |
|---|---|---|
| `MarketPlaceOnboardAgent` | `marketplaceonboardagent6aca3281a3e51` | The conversation. Two tools: `create_vendor`, `submit_application` |
| `MarketPlaceOnboard_SaveInformation` | `marketplaceonboardsaveinformation6aca3328c7c44` | `create_vendor` — four actions, writes every sheet |
| `MarketPlaceOnboard_StartSession` | `marketplaceonboardstartsession6acb1116386db` | Mints the reference, creates the session row, reuses it on a return visit |
| `MarketPlaceOnboard_GetApplication` | `marketplaceonboardgetapplication6acb104b64b60` | The read model behind the stage rail, the panel and the review page |
| `MarketPlaceOnboard_SubmitApplication` | `marketplaceonboardsubmitapplication6acb12e31996b` | `submit_application` — stamps `submitted` on the session and the vendor |
| `MarketPlaceOnboard_GetMessages` | `marketplaceonboardgetmessages6acb4aee8f79a` | Returns the stored transcript for a session |

### Verified end to end

A clean run through the live stack — start, three conversational turns, confirm —
produces all six panel fields and a submitted application:

```
status: submitted · stage: review · reference: b0e0de2c-…
legal_entity: Northgate Dental Systems Ltd · primary_contact: J. Whitfield
feature: Practice management sync · environment: sandbox
base_url: https://api.northgate.example.com/v2 · auth_method: OAuth 2.0 client credentials
```

### `create_vendor` actions

| `action` | Writes |
|---|---|
| `add_vendor` | Inserts into `VendorsV2`, then stamps `VendorId` + `Stage=product` onto the session row |
| `update_vendor_profile` | Updates `VendorsV2` with contact name, email, trading address |
| `update_vendor_feature` | Inserts one row per capability into `VendorFeaturesV2` |
| `update_api_info` | Insert-or-update into `VendorApiInfoV2`, keyed on `VendorId` + `Environment` |

## How it was built

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

### Fixed along the way

1. **`InsertVendor` (1800_8)** now points at `VendorsV2` and has a field
   mapping. A live `create_vendor` call writes a real row — confirmed:
   `bf29b90a-… | Molaris Dental Imaging Ltd.` in `VendorsV2`.
2. **Conditions 5001_6 and 5001_7** compared the literal string `action`
   against their value (`action==update_api_info`), so they could never be
   true — only `add_vendor` was reachable. Both now read `{Entry.action}`.

The HTML error noise that used to precede the JSON
(`Invalid SpreadsheetId` … `SpreadsheetOperationsBlock.php Line: 285`) is gone
for the `add_vendor` path.

### Still open

- **No timestamps.** (`CreatedAt` on the messages sheet is unmapped too; the
  transcript relies on insertion order.)
- Original item: `CreatedAt`, `UpdatedAt`, `LastTurnAt` and `SubmittedAt`
  are never written — a `date` block (2056) feeding `{Date.value}` would do it,
  the way `Plugin_Integration_ConsultationInsert` does.
- **No confirmation email.** PLAN.md B5/B6 (notify partnerships, reminder
  sweep) are not built.
- **Indexed columns are not set** on any sheet. Filters work without them;
  they matter for performance and for SQL mirrors.
- **The four mis-shaped sheets** (`Vendors`, `VendorOnboardingSessions`,
  `VendorFeatures`, `VendorApiInfo` — no `V2`) are empty and unused. Delete
  them, then rename the `V2` sheets.

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


## Creating a workflow from scratch

1. Open `/workflow.html` and set `location.hash = '#workflow.new'`. The page
   gives you a **temporary numeric `workflow_id`** — build against that.
2. `objectInsert` one event per block: `blockId` (`<paletteId>_<n>`), `id`
   (the palette id), `function_type` (the palette's `objType`), `iconPath`,
   `xPos`, `yPos`. **`xPos` is CSS top and `yPos` is CSS left** — they are
   transposed.
3. `connectionInsert` per edge, `con_id` = `` `${source}-${target}` ``, and
   `condition_type` `yes`/`no` out of a `condition` block.
4. `customblockPropInsert` per block, then `connectionPropInsert` for any
   spreadsheet write mapping.
5. `POST /workflow.save` with the temp id and the name. The reply redirects to
   `workflow.debugger/<new Mongo id>`; find the generated short code with
   `POST /workflow.search`.

`window.w_leftBlockArray` on any canvas page holds the palette — each item has
`id`, `objType` and `iconPath`, which is where the `objectInsert` values come
from.

### Why no block returns JSON through `customoutput`

The obvious way to shape a JSON response is a `customoutput` block with
`outputDataType: json`. It does not work here: `outData` is template-rewritten
before it is decoded, and the engine strips `{...}` it cannot resolve —
including the JSON's own braces. The response came back as `null`.

What works is ending the workflow on **`clearoutput` → `setvariable`**: the
`setvariable` merges named values into one empty row and the engine encodes the
response itself. That is why `GetApplication` answers a flat row rather than
the nested object PLAN.md first imagined, and why `src/vizru.ts` accepts both.


## The transcript is stored, not just cached

The agent workflow writes **both sides of every turn** to
`VendorOnboardingMessages`, so a vendor who returns on another machine still
sees the conversation — `localStorage` only ever covered one browser.

```
Entry → Agent → LogUser (1800_30) → LogAgent (1800_31) → Reset (2049_32) → Reply (1700_33)
```

Two things make that safe:

- The agent block is labelled **`Agent`**, not `Agent Node`. A label with a
  space cannot be referenced as `{Agent Node.response}`.
- Appending blocks after the Agent Node changes which block ends the run, and
  the trigger shapes its response from the **last block**. `Reply` re-emits
  `response={Agent.response}` after a `clearoutput`, so the HTTP body the
  client sees is unchanged.

`MarketPlaceOnboard_GetMessages` reads it back, aliasing the columns to
`role` / `message` with `alias_column`. The client hydrates from it on load and
falls back to its local copy.


## The corporate intake, and why it is split across actions

`VendorIntake` holds the wider intake: trading name, country, website, contact
phone, product name and category, regulatory status, patient-data handling,
pricing model, list price, trial, contract term, support hours, uptime and
implementation support. One row per vendor, keyed on `VendorId`.

It is written by **three** separate `create_vendor` actions, not one:

| Action | Writes |
|---|---|
| `update_vendor_details` | trading name, country, website, telephone |
| `update_product_details` | product name, category, regulatory status, patient data |
| `update_commercial_terms` | pricing, price, trial, term, support hours, uptime, implementation |

That split is not cosmetic. A spreadsheet write block maps a **fixed** column
list, so a single wide action re-writes every mapped column on every call —
and the commercial turn blanked the company and product answers that earlier
turns had saved. Narrow actions each touch only their own columns.

The same rule applies to anything added later: give it its own action rather
than widening an existing one.

### Fields deliberately not collected

Company number, VAT number, certifications, GDPR role, data residency and
insurance cover were in the first draft of the intake and were cut as too much
for now. `VendorOnboardingDetails` (`6acb4eb4cbeac2277702acf3`) is the empty
sheet from that draft; it is superseded by `VendorIntake` and can be deleted.
