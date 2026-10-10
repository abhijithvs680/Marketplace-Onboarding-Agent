# Templating: `{variable}`, `{%function%}`, `{fn…}`

Every block property that a user can type into is passed through this engine
before the block runs. It is implemented entirely in
`$APP/sys/workflow/block/Block.php` and is the mechanism by which blocks see
each other's output. Understanding it is non-optional.

## Where data comes from

The engine carries two things forward between blocks:

```php
$prevOutput['output']        // rows from the block that just ran
$prevOutput['prev_outputs']  // { 'BlockLabel' => rows, … } for every labelled block so far
$prevOutput['prev_labels']   // the labels, in execution order
```

A block is added to `prev_outputs` **only if it has a non-empty `label`**. An
unlabelled block's output is readable only as the immediately-previous
`{field}`. If you need a value two blocks later, label the producer.

## Reference forms

| Form | Resolves to |
|---|---|
| `{field}` | `output[0][field]` — the immediately preceding block's first row |
| `{Label.field}` | `prev_outputs['Label'][0]['field']` |
| `{Label}` | the whole of `prev_outputs['Label']`, JSON-encoded |
| `{Label.field[]}` | column-wise: `[ row['field'] for row in prev_outputs['Label'] ]` returned as a real array, not a string |
| `{Label.0}` | when `prev_outputs['Label'][0]` is not an array, indexes the list directly |
| `[ut]{field}` | same lookup, **untrimmed** — whitespace in the value is preserved |
| `[l]…` | a literal marker: a value starting `[l]` has the prefix stripped and is not substituted again (emitted by `b64decode`) |

Order of operations in `processParameters()`:

1. `handleBuiltIns()` — the `{…}` constants below
2. `handleCustomFunctions()` — tenant `{fn…}` calls
3. `handleFunctions()` — `{%…%}` calls
4. `handleTemplate()` — plain `{variable}` substitution
5. `handleNewLine()` — `%0A` → `\n`, `%0D` → `\r`

Steps 3–5 run only if step 1 or 2 changed something — a property containing
*only* `{%fn%}` and no braces-with-builtins still works because `{%…%}` itself
contains braces.

**A `{name}` the engine cannot resolve is replaced with nothing.** There is no
error and no passthrough. This is why JSON literals inside prompts get mangled,
and why the Agent Node grew `live_context_field` (substituted inside the block,
after the engine has run).

## Built-in constants

Resolved by `processDefaultFilterValue()`. Usable in any templated property.

| Token | Value |
|---|---|
| `{loginuserid}` | current `uid` |
| `{loginuseremail}` | current user's email |
| `{loginusername}` | `fname lname` |
| `{user-token}` | a freshly generated JWT for the current user |
| `{tenantid}` | tenant id |
| `{livespaceid}` | session `active_ls` |
| `{livespaceshortcode}` | session `myActivels.short_code` |
| `{user-customer}` / `{user-group}` | the user's group name |
| `{viz-domain}` | the `Domain` constant |
| `{current-domain}` | `HTTP_HOST` (falls back to `HTTP_X_FORWARDED_HOST` when the host is a bare IP) |
| `{viz-uuid}` | a fresh UUID v4 |
| `{viz-timestamp}` | `time()` |
| `{current-date}` | `Y-m-d` |
| `{logid}` | this run's `viz_workflow_exec_log` id |
| `{httpcode}` | HTTP status of the most recent `livecloudfunction` block |
| `{filter-count}` | `resultCount` of the most recent `ssdatafilter` |
| `{extracted-array-count}` | `resultCount` of the most recent `arrayextract` |
| `{lappid}`, `{viz_default}` | recognised, no value assigned |

## `{%function args%}`

Whitespace-separated arguments; quote to include spaces. A bare argument is
first looked up as a variable (`replaceFunctionParameters`) and falls back to
its literal text — so `{%upper name%}` uppercases the *value* of `name` if it
exists, otherwise the string `"name"`.

**Strings**
| Call | Effect |
|---|---|
| `{%lower v%}` `{%upper v%}` | case |
| `{%strlen v%}` | length |
| `{%substr v start [len]%}` | substring |
| `{%substrcount haystack needle [offset] [len]%}` | count (`\s` means a space) |
| `{%stringreplace find replace subject%}` | replace (`\s` means a space, on either arg) |
| `{%ltrim v chars%}` `{%rtrim v chars%}` | trim |
| `{%strpad v len [pad] [type]%}` | pad |
| `{%explode subject sep [limit]%}` | rows of `{data: piece}` |
| `{%implode sep var%}` | joins `var` across **every** row of the source |
| `{%compareString a b mode%}` | `simple` / `levenshtein` / default `similar_text` |

**Regex**
| Call | Effect |
|---|---|
| `{%regexM pattern subject%}` | 1/0 match |
| `{%regexR pattern replacement subject%}` | replace |
| `{%regexE pattern subject [offset]%}` | `preg_match_all`; `offset=count` returns the count, a dotted offset (`1.0`) walks into the match array |

**Encoding**
`{%urlencode v%}` · `{%urldecode v%}` · `{%b64encode v%}` ·
`{%b64decode v%}` (returns `[l]`-prefixed) · `{%unicodeEscape v%}` ·
`{%unicodeUnescape v%}` · `{%sign url%}` (appends a 60-second signature for the
current user — see [auth.md](auth.md))

**Data**
| Call | Effect |
|---|---|
| `{%dataRow [Label]%}` | JSON of `prev_outputs[Label]`, or of `output[0]` |
| `{%clean_json v%}` | strips backslashes, returns raw-urlencoded |
| `{%format_json v%}` | runs the LiveCloud REST formatter, returns a decoded array |
| `{%chart id=<fid>-<cid>-<lid>%}` | renders a Highcharts container `<div>` and pushes the init JS into the run's `jsCodes` |

**Math** — `{%math <expression>%}`

`{variable}` substitution runs inside first, then the expression is lower-cased
and handed to the jlawrence EOS parser. `avg(a,b,c)` and `round(x, n)` are
pre-processed. **Any remaining letter, or any of `"';<>?^`~\#=&_`, makes the
result `0`.** An unresolved variable therefore yields `0` rather than an error.

**Dates** — `{%strtotime v%}` and `{%date fmt ts [tz]%}`

With ≤4 arguments `strtotime` parses directly and `date` emits ISO-8601 (`c`).
With more, `strtotime` takes an explicit input format as arg 0 and normalises
`m/d/Y`, `d/m/Y`, `Y/m/d` (± ` H:i:s`); `date` takes `fmt`, `timestamp`,
`timezone`.

**Global run variables** — `{%global name op value [glue]%}`

Backed by `$GLOBALS['wf']`, scoped to one run (including child workflows, which
share the process). Ops: no op = read · `eq` set · `inc` add · `concat` append
with `glue` (default none) · `push` append to a list · `fetch` read index ·
`pop` remove last. This is the only way to accumulate across a
`executeworkflow` loop.

## `{fnName(a, b)}` — tenant custom functions

Any public method named `fn*` on `Sys\Workflow\Functionlib\Block`
(`$APP/sys/workflow/functionlib/Block.php`) is callable. Resolution:

1. `preg_match_all('/fn(.*)\(/')` finds the name
2. the name must exist in `get_class_methods()`
3. the **argument count must match the method's parameter count exactly** —
   reflection checks it, and a mismatch silently leaves the text unchanged
4. arguments are split on `,`, variable-substituted, then passed positionally

Failures are swallowed by a bare `catch`. The whole call is replaced by the
return value. Also usable as the left side of a `condition` expression, where a
dedicated regex (`/{fn(.*)}([!<>=|]=?)(.*?)$/`) handles it.

The React studio's list of available custom functions is
`Workflow-UI/src/lib/customFunctions.ts`.

## Connection mapping vs. block properties

Two rewrite entry points with different semantics:

- **`reWriteBlockProperties($prev, $props)`** — for `block_properties`. Values
  are treated as templates; a value that does not resolve keeps its literal text
  (`replaceParameters` returns `$value` unchanged for a single-segment key).
- **`reWriteParameters($prev, $fieldMapping)`** — for
  `properties['field-mapping']`. Each entry is `{insertcolumn, keyvalue, keytype}`.
  `keytype = 'fieldkey'` treats `keyvalue` as a field reference (and the literal
  `output` means the whole row); otherwise `keyvalue` is a literal. A quoted
  `"value"` is forced literal. An empty `insertcolumn` drops the entry.

## Practical rules

1. **Label everything you will read later.** No label, no `prev_outputs` entry.
2. **Braces vanish when they don't resolve.** Verify against the debug log
   (`debugLogData`), which records the resolved values.
3. **`.` becomes `*` in log keys.** Debug output only; the real keys are intact.
4. `{%math%}` returning `0` almost always means a typo'd variable name.
5. `{%implode%}` and `{Label.field[]}` are the only forms that see more than
   `[0]` — everything else reads the first row.
