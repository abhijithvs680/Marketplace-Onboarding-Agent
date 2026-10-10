# Agent Node

`agentnode`, palette id **4211**. `$APP/sys/workflow/block/AgentNodeBlock.php`
(1.5k lines) plus two traits: `AgentNodeSkills.php` (881 lines, the packaged
integrations) and `AgentNodeLive.php` (327 lines, voice/multimodal sessions).
Supporting classes: `McpClient`, `ToolResultRouter`, `AgentMemory`.

It calls an LLM and runs a real agentic loop: the model may call tools, the
block executes them and feeds the results back, up to `MAX_ITERATIONS` round
trips.

## Output

```php
$activityResult['output'] = [[
  'response' => '<the model's final text>',
  'provider' => 'gemini',
  'model'    => 'gemini-3.5-flash',
]];
```

Downstream blocks read `{AgentLabel.response}`. The debug log additionally
carries `prompt`, `skill_actions` and a bounded `trace` (last
`TRACE_LIMIT` = 40 events).

## Limits (class constants)

| Constant | Value | Meaning |
|---|---|---|
| `MAX_ITERATIONS` | 100 | tool-call round trips before tools are withdrawn and the model must answer in prose |
| `RUN_TOKEN_BUDGET` | 250 000 | estimated **input** tokens one run may spend; on exceeding it, tools are withdrawn and a `budget_exhausted` trace is written |
| `REQUEST_TIMEOUT` | 120 s | per provider call |
| `DB_QUERY_TIMEOUT` | 15 s | `query_database` |
| `HTTP_TOOL_TIMEOUT` | 30 s | external tools and messaging skills |
| `READ_RESULT_LIMIT` | 50 | rows per `read_result` page |
| `MAX_WORKFLOW_SKILL_CALLS` | 12 | child workflows one execution may start (recursion guard, static across the run) |
| `STREAM_FLUSH_BYTES` / `STREAM_FLUSH_SECONDS` | 64 / 0.12 | stream coalescing |
| `MODEL_LIMIT_TTL` | 86 400 s | cache for a model's output-token ceiling |
| `FALLBACK_MAX_TOKENS` | 4096 | sent to Anthropic when the lookup fails (its API requires `max_tokens`) |
| `DEFAULT_RAG_TOP_K` / `RAG_CONTEXT_WINDOW` | 10 / 2 | retrieval defaults |

## Providers

`provider` selects the wire format. `api_key` doubles as the **base URL** for
`on-premises`.

| `provider` | Endpoint | Auth | Notes |
|---|---|---|---|
| `gemini` | `…/v1beta/models/{model}:generateContent?key=` (or `:streamGenerateContent?alt=sse&key=`) | key in the query string | system prompt goes in `systemInstruction`; messages use `parts`; tool schemas are converted by `convertParamsToGemini` |
| `openai` | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer` | uses `max_completion_tokens`; sets `parallel_tool_calls`; a model matching `/(o1\|o3\|gpt-5\|-sol)/i` also gets `reasoning_effort: none` |
| `anthropic` | `https://api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` | `max_tokens` is mandatory; system prompt is top-level `system` |
| `on-premises` | `<api_key>/v1/chat/completions` | none added | any OpenAI-compatible endpoint |

Initial messages differ: OpenAI-shaped providers get a `system` message,
Gemini and Anthropic carry the system prompt outside the message array.

## Properties

Grouped as the dialog's steps. Field names are the stored keys.

### Model
`provider` (req) · `model` (req) · `api_key` (req, secret — or the base URL) ·
`temperature` (default `0.7`) · `max_tokens` (default `4096`)

`resolveMaxTokens()` looks up the model's real output ceiling and caches it for
a day; `MODEL_LOOKUP_TIMEOUT` is 5 s.

### Instructions
- `system_prompt` — spreadsheet schemas, skill guidance, RAG context and the
  memory preamble are **appended to this automatically**
- `prompt` (req) — `{variable}` / `{Label.field}` supported
- `thread_id` — enables the tool-result store's thread scoping and, when set,
  memory
- `memory` — `"true"`/`"false"`. True ⇒ `AgentMemory::MODE_FULL` (whole
  transcript stored, searchable); false with a `thread_id` ⇒ `MODE_FACTS` (only
  keyed facts carried forward). **Memory needs a `thread_id`; without one it is
  off regardless of this flag.**

### Data access
- `d_master_ssid` — app id, or a `{variable}` expression when
  `_d_master_ssid_dynamic` is on
- `ss_shortcodes` — comma-separated spreadsheet short codes the agent may query,
  or a `{variable}` resolving to that CSV

`buildDataAccessPrompt()` then:

1. filters the codes through `ownedShortCodes()` — a direct
   `viz_livespace_files` query on `tid` + `mime_type = 'spreadsheet'`, so a code
   from another tenant is dropped before anything else happens;
2. fetches each schema via `McpClient::schemas()`;
3. appends the schemas plus the **CRITICAL SQL RULES** block to the system
   prompt — Postgres, case-sensitive double-quoted column names, unquoted
   lower-case tables, the explicit readable-table list, read-only single SELECT,
   and the instruction to match the user's words against `label` but write
   `name` into the SQL;
4. records `allowedTables`, which is sent as `allowed_tables` on every query so
   the server enforces the same restriction.

No configured sheets ⇒ no `query_database` tool at all.

### Streaming & orchestration
- `stream` — `"true"` pushes tokens over the realtime socket as they arrive
- `identifier` / `identifier_value` — the socket target (`guid_<value>`)
- `tags` — socket event name, default `new_message`
- `is_sub_agent` — `"true"` when a parent agent in another workflow invokes this
  one; every frame is then tagged so the UI can separate the agents
- `sub_agent_id` — defaults to the value the parent passed
(`{sub_agent_id}`), falling back to the block label, then `sub_agent`
- `sub_agent_label` — display name, defaults to the id

When `is_sub_agent` is true and `identifier`/`identifier_value` are blank, they
are resolved from the incoming workflow row — that is how a parent hands its
stream target down.

### Live session (`mode: live`)
Same provider, model, prompt, tools and sheets, but a conversation rather than
one answer. **The block does not wait** — it returns a session handle and the
workflow carries on; the call runs in a session runner process
(`$APP/sys/realtime/SessionRunner.php`). Google Gemini and OpenAI only.

| Key | Meaning |
|---|---|
| `mode` | `request` (default) \| `live` |
| `live_modalities` | `audio` \| `audio+video` \| `text` |
| `live_voice` | e.g. `marin` (OpenAI), `Puck` (Gemini) |
| `live_context_field` | Appended to the system prompt **verbatim**. A bare field name (`agentPrompt`) or a template (`{Entry.agentPrompt}`). Substituted *inside the block*, so large JSON-bearing context survives — the platform's own engine deletes braces it cannot resolve. |
| `live_client_tools` | JSON array of tools the **browser** executes (filling a form, opening a picker). The platform declares them to the model and routes each call to the app, which reports back. The app cannot add to this list. |
| `live_silence_ms` | End-of-speech silence; clamped 200–800. The largest single lever on perceived latency. |
| `live_transport` | `relay` (media through the platform — governable) \| `sideband` (browser↔provider — lower latency, better echo cancellation, no byte-level control) |
| `live_stream_policy` | `passthrough` (lowest latency; a policy stop cuts an utterance rather than preventing it) \| `gate` (check before the user hears it) \| `text_first` |
| `max_session_seconds` | default 900 |
| `max_session_usd` | default 1.00 — realtime audio tokens are expensive |
| `idle_timeout_seconds` | default 60 |
| `record_audio` | **off by default.** Transcripts are always kept; audio is not, because recording a voice conversation creates consent obligations in most jurisdictions. |
| `on_end_workflow` | runs with the session summary when the call ends |

Related constants: `LIVE_FUNCTION = 'realtimefn'`,
`MaxLiveSessionsPerTenant` (25), `RealtimeQueue` (`realtime`). Supporting
classes live in `$APP/sys/realtime/`: `Session`, `SessionRunner`, `Transport`,
`Frame`, `Gate`, `Verdict`, `Meter`, `Recorder`, `ToolBridge`,
`ProviderFactory`, `WebSocketClient`.

### RAG
- `rag_type` — `none` | `embedding` | `retrieval` | `both`
- `project_id`, `rag_api_key` (secret), `rag_embedding_model`
  (`text-embedding-3-large`, read-only), `top_k` (default 2 in the form, 10 in
  the block when unset), `rag_file_path`, `all_files`, `document_ids`

`embedding` alone **short-circuits the block**: it ingests the file and returns
the ingestion record as output, without calling the model.
`retrieval`/`both` retrieve first and append the chunks to the system prompt as
`=== Retrieved Data ===`, each block headed `[n] <file name> (pages 3, 4)` and
carrying `context_window` neighbours inline. Scores and document records are
stripped — prompt text only.

### Capabilities
- `skills` — comma-separated enabled skill ids
- `skill_<id>_config` — one JSON blob per skill (see below)
- `tools` — JSON array of external HTTP tools:

```json
[{ "name": "get_weather",
   "description": "Get current weather for a city",
   "url": "https://api.weather.com/v1/current",
   "method": "GET",
   "parameters": { "type": "object",
                   "properties": { "city": { "type": "string", "description": "City name" } },
                   "required": ["city"] },
   "auth": { "type": "bearer", "token": "…" },
   "headers": {} }]
```

`auth.type` is `bearer` | `basic` | `api_key`. Names are sanitised
(`sanitizeToolName`); a nameless entry is skipped; a missing `parameters`
becomes an empty object schema; `method` defaults to `POST`.

## The tool registry

Assembled in order by `buildToolRegistry()`; earlier entries win on a name clash.

1. `query_database` — only when spreadsheets are configured
2. external HTTP tools from `tools`
3. skill tools from every enabled skill
4. memory tools, when memory is on
5. `read_result` — appended automatically whenever the registry is non-empty

Every entry has `{name, description, parameters, handler, progress_label}`;
`handler` is `db` | `http` | `workflow` | a skill id | `memory`.

## The loop

```
for iteration in 1 … MAX_ITERATIONS + 1:
    spent += estimateTokens(messages + systemPrompt)
    exhausted = spent >= RUN_TOKEN_BUDGET
    tools_this_turn = [] if (iteration > MAX_ITERATIONS or exhausted) else tools
    turn = streaming ? readStreamedTurn() : readFullTurn()
    finalText += turn.text
    trace(iteration, tool count, call names, chars)
    memory?.record('assistant', turn.text)
    break if turn.fatal or no tool calls or last iteration or exhausted
    results = dispatchToolCalls(turn.tool_calls)
    messages += assistant tool calls, then tool results
```

- One reused cURL handle for the whole loop (`curl_reset` per turn).
- A transport error raises `WorkflowError`. An HTTP ≥ 400 becomes a **fatal
  turn**: the first 2000 bytes of the body are appended to the answer text and
  the loop stops — the run does not abort, so the workflow continues with an
  explanatory response.
- Streaming parses SSE per provider (`consumeSseLine`, `extractFromStreamJson`,
  `mergeToolCallDeltas` for OpenAI's incremental tool-call deltas).
- `parallel_tool_calls` is enabled for OpenAI only when **more than one**
  workflow tool is registered.

### Tool results: sent or referenced

`ToolResultRouter` decides per result. A table-shaped result goes to
`POST /api/tool-result/query` (stored in full, streamed straight into
`tool_result_row`), and the model receives a reference, the exact row count and a
5-row preview. Non-table results go to `POST /api/tool-result` whole. Either way
the model reaches the rest through `read_result(result_id, offset, limit,
columns)`, 50 rows at a time. Nothing is truncated — that is the point.

## Skills

`skills` holds the enabled ids; each has a flat JSON config under
`skill_<id>_config`. The React catalog
(`Workflow-UI/src/components/settings/skills.ts`) mirrors the PHP field names
one for one.

### `workflow` — call other Vizru workflows
Config `{"workflows":[ … ]}`, one entry per exposed tool:

| Field | Meaning |
|---|---|
| `shortcode` | the workflow to run (required) |
| `name` | display name |
| `tool_name` | the tool name given to the model (sanitised; falls back to `run_<shortcode>`) |
| `purpose` | `action` \| `fetch` \| `agent` \| `notify` \| `validate` \| `transform` \| `other` — expands into the intent sentence that opens the tool description |
| `description` | appended to the intent |
| `params` | `[{name, type: string\|number\|integer\|boolean, description, required}]`. **With no params declared, a single `input_json` string parameter is generated instead** ("Pass {} when no inputs are needed"). |
| `static_inputs` | JSON merged in first, then `input_json`, then the model's named args |
| `result_mode` | `full` (all rows) \| `first_row` \| `count` (`{row_count: n}`) \| `none` (`{status: "completed"}`) |
| `is_sub_agent` | passes `sub_agent_id`, `parent_agent_id`, `identifier`, `identifier_value`, `tags` into the child so its own Agent Node streams to the same client |
| `sub_agent_id` | defaults to the tool name |

Children run **in-process** as `mode = 'child'`. `runWorkflowsInParallel()`
handles concurrent calls (180 s default). Capped at `MAX_WORKFLOW_SKILL_CALLS`
per execution; exceeding it returns
`{"error": "Workflow skill call limit reached for this execution. Possible recursion."}`.

### `slack`
`bot_token` (req, `xoxb-`) · `default_channel` · `allow_channel_override`
(default on) · `username` · `icon_emoji` · `unfurl_links` (default on) ·
`enable_read` (adds `slack_read_messages`, needs `channels:history`) ·
`enable_list_channels` (adds `slack_list_channels`, needs `channels:read`).
Base tool: `slack_send_message`.

### `telegram`
`bot_token` (req) · `chat_id` (req) · `allow_chat_override` ·
`parse_mode` (`HTML` default / `MarkdownV2` / `none`) ·
`disable_notification` · `enable_send_document` (adds
`telegram_send_document`). Base tool: `telegram_send_message`.

### `discord`
Webhooks, no bot or OAuth app. `webhook_url` (req) · `username` ·
`avatar_url` · `default_color` (`#5865F2`) · `mention` · `thread_id`.
Tool: `discord_send_card` (rich embeds; field names clipped to 256 chars).

### `whatsapp`
WhatsApp Cloud API. `phone_number_id` (req) · `access_token` (req, use a
permanent system-user token) · `api_version` (`v23.0`) · `default_to`
(digits only, no `+`) · `allow_recipient_override` · `enable_template` ·
`template_name` · `template_language` (`en_US`). Tools:
`whatsapp_send_message`, `whatsapp_send_template`. Free-form replies are only
allowed within 24 hours of the customer's last message — templates are how you
reach outside that window.

### `email`
`provider` (`sendgrid` | `smtp`) · SendGrid: `api_key` (needs Mail Send) ·
SMTP: `smtp_host`, `smtp_port` (587), `smtp_secure` (`tls`/`ssl`/`none`),
`smtp_user`, `smtp_pass` · `from_email` (req), `from_name`, `reply_to` ·
`default_to` / `default_cc` / `default_bcc` (comma separated) ·
`allow_recipient_override` · `subject_prefix`. Tool: `email_send`.

`buildSkillGuidance()` appends per-skill usage notes to the system prompt, and
every skill action is recorded in `skill_actions` in the debug log.

## Memory (`AgentMemory`)

Opened only with a `thread_id`. `open()` does one `POST /api/memory/open` for
counters and facts; `prompt()` returns the preamble appended to the system
prompt; `record()` buffers turns; `flush()` writes them. `tools()` exposes
recall/fact tools to the model. Nothing stored is replayed into the prompt — a
thread with 500 exchanges costs the same standing tokens as one with five.

`MODE_FULL` keeps the whole transcript (searchable via `/api/memory/recall`);
`MODE_FACTS` carries only keyed facts forward.

## Interpolated properties

Only these get `{variable}` substitution (`$interpolatedProps`):

`prompt` `system_prompt` `identifier` `identifier_value` `tags`
`sub_agent_id` `sub_agent_label` `model` `thread_id` `memory`
`ss_shortcodes` `d_master_ssid` `rag_type` `project_id` `rag_api_key`
`rag_file_path` `all_files` `document_ids` `top_k`

Each runs through the platform engine first, then `interpolateDeep()`. Anything
not listed — including `tools` and the skill configs — is used verbatim.

## Practical notes

- **`api_key` is stored in `block_properties` in Mongo, in clear.** Treat a
  workflow document as a secret. The React dialog marks the field `secret`, which
  only affects display.
- Streaming tokens go to the socket, **not** to the HTTP response. A browser
  needs a socket.io connection with a matching `guid` — see
  [realtime.md](realtime.md).
- The block always returns `status: 'yes'`. Provider errors surface as text
  inside `response`, so check the content, not the status.
- Give the block a `label`. Without one, `{…response}` is only readable by the
  immediately next block.
- A model that keeps calling tools burns the token budget before the iteration
  cap; `budget_exhausted` in the trace tells you which limit bit.
