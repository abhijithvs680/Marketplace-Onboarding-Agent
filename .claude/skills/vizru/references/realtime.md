# Realtime

Two Node services sit beside the PHP platform:

| Service | Port | Source | Role |
|---|---|---|---|
| `receiver-chatsystem` | 8000 | `receiver/volumes/chatSystem/` | socket.io 2.x — the realtime bus for agent streams, spreadsheet change pushes and chat |
| `receiver-chatsystem-v2` | 8001 | `receiver/volumes/chatsystem-v2/` | newer chat app |

Both are published through haproxy. Platform constants:

```php
define('InternalSocketServer', 'https://receiver-chatsystem:8000');  // PHP → socket, server side
define('ExternalSocketServer', 'https://localhost:8000');            // what a browser connects to
define('InternalSocketServerCA', '');                                // empty ⇒ skip verification on that hop
```

`ExternalSocketServer` is also returned to clients in the
`user.jwt.externalauth` response, so a browser client should read it from there
rather than hard-coding it.

## Connecting from a browser

socket.io **2.x** (`socket.io-client@2`), **websocket transport only** — the
server does `io.set("transports", ["websocket"])` and `io.set("upgrade", false)`,
so a polling-first client will not connect.

Auth is the **same JWT the platform issues** (`socketio-jwt` with
`handshake: true`, secret = the tenant private key), so one token covers both the
API and the socket.

```js
import io from 'socket.io-client';          // v2.x

const socket = io(EXTERNAL_SOCKET_SERVER, {
  transports: ['websocket'],
  upgrade: false,
  query: { token: jwt },                    // socketio-jwt handshake
});
```

A Redis adapter (`socket.io-redis`, `receiver-redis`) backs the room registry, so
the server scales horizontally and cross-process lookups go through
`adapter.customRequest`.

## Identity and rooms

There are two kinds of connection and they are addressed differently.

**Guest / workflow sessions** — emit `set_user`:

```js
socket.emit('set_user', {
  user: 'Guest',            // required — the handler only runs for 'Guest'
  guid: '<your guid>',      // how the platform will address you
  tid: 11,
  workflowId, connectedWorkflow, domain, logdomain,
  saveLogs, device, apiUserId, hashtoken, refresh_token,
  auth_token, userEmail, toUserEmail, vizuserName, Agent, headerToken,
});
```

The socket joins the rooms `tid` and `guid`, and the fields are stashed on the
socket for later server-side calls.

**Authenticated platform users** come in through the JWT and carry
`viz_userId`, `viz_tid`, `viz_email`, `viz_username`. They join
`<tid>general` and `<userId>user`, and app rooms on demand.

App rooms are `` `${tid}_viz_${appId}` ``, with `` `_viz_${dnaFilter}` ``
appended when a filter is active. `app_switch` joins one, but only after the
server calls back into `/sys/api.v1` with `op=liveapps.permissioncheck` using the
socket's own bearer token — **room membership is permission-checked server side**,
not client-asserted.

## PHP → socket

`Sys\Livespaces\Liveapps\Realtime\Realtime::realTimePush($payload, $chatRoute)`
POSTs JSON to `InternalSocketServer/<chatRoute>`, 30 s timeout, TLS verification
off. When `MultiTenant` is on it adds `web_domain: Domain` so the Node side
knows which platform host to call back into.

**A push failure is swallowed** — `curl_error` is captured and discarded. Realtime
delivery is best-effort; never make correctness depend on it.

Four routes exist: `/emit_block`, `/ssUpdate`, `/background_service`,
`/viz_custom`.

## `POST /emit_block` — the general-purpose push

Used by the `realtimepush` block (guid path) and by **every Agent Node stream
frame**.

```json
{ "identifier": "guid_abc123",
  "identifier_value": "abc123",
  "tags": "new_message",
  "dataset": "<JSON string>" }
```

Routing: `identifier` is split on `_`; the prefix (`guid` or `job`) picks the
cross-process lookup (`getGuid` / `getUserId`) and `identifier_value` (falling
back to the part after the prefix) is matched against every connected socket.
`tags` becomes the **emitted event name**, so the browser listens on that:

```js
socket.on('new_message', (frame) => { … });
```

`dataset` is a JSON **string** the server parses; if `Body` inside it looks like
base64 it is decoded (`decodeBase64Body`). When `tags === 'new_message'` and the
socket has not disabled logging, the server additionally posts the message to
`/sys/api.v1` with `op=realtime.real` using the socket's stored `auth_token`, so
the conversation is logged.

### Agent Node stream frames

`AgentNodeBlock::emit()` sends:

```json
{ "Body": "<base64 of the text chunk>",
  "type": "agent_stream",
  "status": "streaming" | "complete",
  "workflow_log_id": "<the run's log id>",
  "is_sub_agent": true,            // only when the block is a sub-agent
  "sub_agent_id": "Task_0913",
  "sub_agent_label": "Research Agent",
  "parent_agent_id": "…" }
```

- **`Body` is base64.** Decode it.
- Chunks are coalesced before sending: flushed at 64 bytes or 120 ms, whichever
  comes first, and always on a **complete UTF-8 boundary**
  (`completeUtf8Length`) so a multi-byte character is never split across frames.
- Between tool calls the block emits a progress line as ordinary streamed text:
  `\n\n*Querying database...*\n`.
- A final frame with `status: "complete"` and an empty body ends the stream.
- Sub-agent frames carry the four extra fields, which is how a UI keeps several
  agents' output apart in one channel.

Minimal consumer:

```js
let text = '';
socket.on('new_message', (frame) => {
  if (frame.type !== 'agent_stream') return;
  if (frame.status === 'complete') { done(text); return; }
  text += atob(frame.Body);        // base64 → chunk
  render(text, frame.sub_agent_id);
});
```

The `identifier_value` you pass to `set_user` as `guid` must match what the Agent
Node block has in `identifier_value` — usually threaded through the workflow's
input from the client.

## `POST /ssUpdate` — spreadsheet change fan-out

Sent by `Realtime::updateRealtimeData($ssid, $dataset, $action, $lid)` when a
sheet changes **and** a realtime-enabled app object is bound to it. It only fires
for these actions:

`rowInsert` · `rowUpdate` · `row_remove` · `copyPaste` · `multiRowsUpdate` ·
`column_remove`

and only when a `VizLiveappsContent` document has `source = "SS##<ssid>"` and
`realTime ∈ {1, 2, 3}`.

```json
{ "tid": 11, "lid": 2, "ssid": "…", "row_id": "…",
  "app_object_ids": ["<cnt-id>", …], "action": "rowUpdate",
  "user_id": 188, "tag_name": "ss_dataChange",
  "jwt_token": "<the acting user's JWT>" }
```

The Node handler then, per app room that matches:

1. collects the connected users in that room,
2. calls back into `/sys/api.v1` with `op=liveapps.realtime.userRowData` and the
   supplied JWT, passing `active-user-ids` and the `dnaFilter` from the room name,
3. emits `ss_dataChange` **per socket**, with only that user's permitted rows:

```js
socket.on('ss_dataChange', ({ dnaFilter, data }) => { … });
```

Two consequences worth internalising:

- **Row-level permissions are honoured** — every client gets a different payload,
  computed server-side.
- **A plain spreadsheet write publishes nothing.** No realtime-enabled app object
  bound to the sheet means no event. This is not the same mechanism as the
  Postgres sync pipeline, which is driven by `general-settings.Autosync` and goes
  to Redis, not the socket. Both can be off independently.

Spreadsheet write methods take an `eventSource` (`'ss'`, `'workflow'`, …) which
feeds this decision; the spreadsheet write blocks expose it as
`disable_realtime`.

## `POST /background_service` — job progress

The `job_id` path of the `realtimepush` block. Payload is the block's
`variables` map plus `userId`, `tag`, `jobId`, `icon`, `type:
"background_wf"`, `data`, and `_id` when a `VizNotification` row was written.
`USER_ID` may be a comma-separated list, and an entry that is not numeric is
resolved from an email. The block also writes a `VizJobStatus` row
(`status`, `message` from the variables).

Pattern: `backgroundworkflow` returns a `jobID` immediately; the background run
ends with a `realtimepush` on that `job_id`; the browser, holding the `jobID`
from the first response, receives the completion. With `notification_log = 1` an
offline user finds it in the Inbox instead.

## `POST /viz_custom`

Custom emit keyed by `uid`; answers `{"error": "uid not found in request"}` when
the payload has none.

## Client-emitted events

`chatController.js`: `set_user` · `set_admin` · `vizru_user` ·
`get_flowmessages` · plus the chat message events.

`realtimeController.js`: `app_switch` · `htmlcard_app_switch` ·
`lsEdit-lock` / `lsEdit-unlock` · `wf-lock` / `wf-unlock` ·
`DashboardEdit-lock` / `-lock-request` / `-unlock`.

The `*-lock` family is collaborative editing: a lock request goes to
`<tid>general`, the server resolves who holds it via the Redis adapter
(`wfLockUser`, `dashLockUser`, `lsLockUser` and their unlock counterparts, which
read `socket.wf_edit` / `dash_edit` / `ls_edit_<type>`), and the answer comes back
on `<userId>user`. The classic workflow canvas uses `wf-lock` so two people
cannot edit one workflow at once — **a custom studio should honour it too.**

Server-emitted: `online_users`, `handlerObj`, `broadcast_handlerRemove`,
`invalid_token` (sent with the offending `auth_token` when the JWT is rejected),
`ss_dataChange`, `get_flowmessages`, and whatever `tags` names.

## Celery / RabbitMQ

Async work that is not realtime: `receiver-rabbitmq` plus
`receiver-celery`, `receiver-celery-realtime`, `receiver-celery-beat`,
`receiver-celery-beat-worker`. Registered in `env-docker.php` as the `worker`
factory (exchange `vizru`, vhost `vizru_vhost`, connector `php-amqplib`).
Beat drives `VizWorkflowSchedule` by fetching each entry's `command` URL
(`workflow.startcrontask/<id>/user_id/<uid>`). `RealtimeQueue` (`realtime`) is
the live-agent-session queue.

## Checklist for a realtime client

1. Get a JWT (`user.jwt.externalauth`) and read `ExternalSocketServer` from the
   same response.
2. Connect with socket.io **2.x**, `transports: ['websocket']`, token in the
   handshake query.
3. `emit('set_user', { user: 'Guest', guid, tid, … })` — the `guid` is your
   address.
4. Listen on the event name the pushing block's `tags` specifies (default
   `new_message`).
5. Pass that same `guid` into the workflow so the Agent Node's
   `identifier_value` resolves to it.
6. Decode `Body` from base64 and treat `status: "complete"` as end-of-stream.
7. Assume frames can be lost — pushes are best-effort and errors are swallowed.
