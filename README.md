# Vizru · Partner Onboarding

React client for the Vizru workflow `marketplaceonboardagent6aca3281a3e51` — the
dental-marketplace vendor onboarding agent, presented as a corporate application
rather than a chat box. Built to the design canvas: a welcome screen, the
onboarding console (stage rail + conversation + live submission panel), and a
review page.

## The contract this app is built against

The workflow is two blocks:

```
Entry (genericpost, 4202, auth_required = "0")  ──▶  Agent Node (4211, gemini, stream = false)
```

* **Entry** is a trigger block with `auth_required = "0"`, so
  `POST /workflow.trigger/<shortcode>` is **fully public** — no bearer, no
  hashtoken, no session cookie. The run executes as the uid on the entry block.
* `genericpost` merges the JSON body into the entry block's output, so the Agent
  Node's `prompt = {Entry.message}` and `thread_id = {Entry.session_id}` are fed
  by exactly two fields:

  ```json
  { "message": "…", "session_id": "…" }
  ```

* `memory = "true"` plus a `thread_id` puts the agent in full-transcript mode, so
  **`session_id` must stay the same for the whole conversation.** The app keeps
  it in `localStorage`; "Start a new application" mints a fresh one.
* The Agent Node is the last block that runs, so the response is the raw `output`
  array with `jsCodes` / `workflow_log_id` merged into row 0:

  ```json
  [{ "response": "…", "provider": "gemini", "model": "gemini-3.5-flash",
     "workflow_log_id": 81066764 }]
  ```

Four details that bite, all handled in [src/vizru.ts](src/vizru.ts):

1. **A 200 does not mean success.** A workflow that throws returns 200 with the
   body `Internal Server Error`.
2. **A failing block prints HTML into the response before the JSON.** Live
   example from this workflow:

   ```
   <div class="alert">Workflow Error</div><div class="alert">Invalid SpreadsheetId </div>…[{"response":"…"}]
   ```

   The client finds the JSON after the noise, renders the reply, and logs the
   server's complaint with `console.warn` so a developer still sees it.
3. **The CORS allow-list is hard-coded** in `Trigger.php::initialize()` to
   `http://localhost:3000`, `https://baines.healthcare` and `*.vizru-ras.com`.
   A non-matching origin gets *no* CORS headers and the browser drops the reply —
   which is why the dev server is pinned to port 3000 with `strictPort`.
4. **Only `hashtoken, auth_token, bearer, Authorization, Content-Type` pass the
   preflight.** Sending `X-Requested-With` (correct for `sys/api.v1`) fails it
   here, so this client sends `Content-Type` and nothing else.

## Run it

```bash
npm install
npm run dev
```

Opens on <http://localhost:3000> — keep that port.

| Variable in `.env` | Meaning |
|---|---|
| `VITE_VIZRU_BASE_URL` | Platform origin the **browser** calls. Currently `https://innov-dev.beta.injomo.com/`, which is where this workflow lives. Set it empty to route through the dev proxy instead. |
| `VIZRU_PLATFORM_URL` | Target of the **dev proxy** (`/workflow.trigger/*`). Only used when `VITE_VIZRU_BASE_URL` is empty; useful against a local stack with a self-signed cert. |
| `VITE_VIZRU_WORKFLOW` | Workflow short code. |
| `VITE_VIZRU_TIMEOUT_MS` | Client ceiling for one turn (default 180 000). The Agent Node allows 120 s per provider call and up to 100 tool round trips. |

## Turning the submission panel on

The stage rail and the "Your submission" checklist read a record the **agent**
reports. The workflow returns prose only, so until the agent says what it
captured every field honestly reads "Needed".

To light it up, add this to the Agent Node's `system_prompt`:

```
When you have confirmed a value, end your reply with this block:
[[vizru]]
legal_entity: <registered company name>
primary_contact: <name or role>
feature_summary: <one line>
api_base_url: <url>
auth_method: <scheme>
sandbox_access: <what you were told>
submitted: true
[[/vizru]]
Include only the lines you confirmed in that reply. Never mention the block.
```

The format is deliberately **brace-free**. The workflow engine interpolates
`{…}` inside `system_prompt` and deletes anything it cannot resolve, so a JSON
example there would reach the model mangled. The client strips the block before
displaying the reply and renders the values as the "Added to your submission"
card. Aliases (`company_name`, `api_url`, `auth`, …) are accepted — see
[src/submission.ts](src/submission.ts).

## Known server-side problem

Every turn that calls the `create_vendor` tool logs this twice, on the live
platform:

```
Workflow Error / Invalid SpreadsheetId
Internal Server Error File: …/sys/workflow/block/SpreadsheetOperationsBlock.php Line: 285
```

The agent still answers, but the child workflow
`marketplaceonboardsaveinformation6aca3328c7c44` is **not saving the vendor** —
its spreadsheet block has no valid `ssid`. Fix that in the workflow; nothing in
this client can.

## Layout

| File | Role |
|---|---|
| [src/vizru.ts](src/vizru.ts) | The platform contract: one `POST`, response salvage, error mapping. |
| [src/submission.ts](src/submission.ts) | Stages, fields, the marker protocol, progress, the text summary. |
| [src/session.ts](src/session.ts) | `session_id` (= `thread_id`), transcript, record — all in `localStorage`. |
| [src/App.tsx](src/App.tsx) | Welcome / console / review, send loop, abort handling. |
| [src/components/](src/components) | Header, stage bar, conversation, composer, submission panel, review, markdown. |
| [src/styles.css](src/styles.css) | Design tokens: IBM Plex, deep teal `#0D5B52`, light corporate surfaces. |

## Deploying

`npm run build` emits `dist/`. Serve it from an origin in `Trigger.php`'s
`$allowedOrigins` (e.g. a `*.vizru-ras.com` subdomain) and set
`VITE_VIZRU_BASE_URL` to the platform origin at build time. Any other origin
needs that PHP array edited — there is no runtime CORS config.

### Not wired, deliberately

* **Attachments.** `genericpost` takes JSON; file upload needs a
  `chatfileupload` (4205) entry block.
* **Streaming.** `stream = "false"`. With streaming on, tokens go to socket.io
  on :8000 and this client would need a matching `guid`.
