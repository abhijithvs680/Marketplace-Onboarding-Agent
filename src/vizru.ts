/**
 * Vizru client — one endpoint, one workflow.
 *
 *   POST /workflow.trigger/marketplaceonboardagent6aca3281a3e51
 *
 * The workflow is two blocks:
 *
 *   Entry (genericpost, auth_required = "0")  ->  Agent Node (gemini, stream=false)
 *
 * Because the entry block is a trigger block in the 4200-4205 range and
 * auth_required is "0", the call is fully public: no bearer, no hashtoken, no
 * session cookie. The run executes as the uid stored on the entry block.
 *
 * The Agent Node reads prompt = {Entry.message} and thread_id =
 * {Entry.session_id}, so the JSON body must carry exactly those two fields.
 * thread_id is what turns on the agent's memory (memory = "true" => full
 * transcript), which is why the session id has to be stable across turns.
 */

const BASE = (import.meta.env.VITE_VIZRU_BASE_URL ?? '').replace(/\/+$/, '');

export const WORKFLOW_SHORTCODE =
  import.meta.env.VITE_VIZRU_WORKFLOW ?? 'marketplaceonboardagent6aca3281a3e51';

const TIMEOUT_MS = Number(import.meta.env.VITE_VIZRU_TIMEOUT_MS ?? 180_000);

export class VizruError extends Error {
  constructor(
    message: string,
    readonly detail?: { status?: number; body?: string },
  ) {
    super(message);
    this.name = 'VizruError';
  }
}

/** One row of the workflow's `output` array, as the Agent Node leaves it. */
interface AgentRow {
  response?: string;
  provider?: string;
  model?: string;
  workflow_log_id?: string;
  [key: string]: unknown;
}

export interface AgentReply {
  text: string;
  provider?: string;
  model?: string;
  workflowLogId?: string;
}

export interface RunOptions {
  message: string;
  sessionId: string;
  signal?: AbortSignal;
}

export async function runOnboardingAgent({
  message,
  sessionId,
  signal,
}: RunOptions): Promise<AgentReply> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const abort = signal
    ? anyOf([signal, timeout.signal])
    : timeout.signal;

  let res: Response;
  try {
    res = await fetch(`${BASE}/workflow.trigger/${WORKFLOW_SHORTCODE}`, {
      method: 'POST',
      // Content-Type: application/json already forces a preflight, and
      // Trigger.php answers OPTIONS with
      //   Access-Control-Allow-Headers: hashtoken, auth_token, bearer,
      //                                 Authorization, Content-Type
      // Adding anything outside that list (X-Requested-With, for instance)
      // fails the preflight, so this is the complete header set.
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, session_id: sessionId }),
      signal: abort,
    });
  } catch (err) {
    clearTimeout(timer);
    if (signal?.aborted) throw err;
    if (timeout.signal.aborted) {
      throw new VizruError(
        `The agent did not answer within ${Math.round(TIMEOUT_MS / 1000)}s. It may still be working — try again, or check the workflow log.`,
      );
    }
    throw new VizruError(
      'Could not reach the Vizru platform. Is it running, and is this origin in the trigger CORS allow-list?',
    );
  }
  clearTimeout(timer);

  const body = await res.text();

  if (!res.ok) throw new VizruError(describeStatus(res.status), { status: res.status, body });

  // A 200 only means the engine ran the graph. A workflow that threw comes back
  // 200 with the literal body "Internal Server Error", so parse before trusting.
  const { payload, noise } = extractPayload(body);

  // A block that fails mid-run echoes its error straight into the output stream,
  // so the body arrives as `<div class="alert">…</div>[{…}]`. The vendor sees the
  // agent's answer; the developer gets the server's complaint in the console.
  if (noise) console.warn(`[vizru] the workflow emitted an error before its JSON:
${noise}`);

  if (payload === undefined) {
    throw new VizruError(
      /internal server error/i.test(body)
        ? 'The workflow threw while running. Check VizWorkflowLog for the failing block.'
        : 'The platform returned something that was not JSON.',
      { status: res.status, body },
    );
  }

  const row = firstRow(payload);
  if (!row) {
    throw new VizruError('The workflow returned no rows.', { status: res.status, body });
  }

  const text = typeof row.response === 'string' ? row.response.trim() : '';
  if (!text) {
    throw new VizruError(
      'The Agent Node returned an empty response. The provider call most likely failed — the error text lands inside `response`.',
      { status: res.status, body },
    );
  }

  return {
    text,
    provider: row.provider,
    model: row.model,
    workflowLogId: row.workflow_log_id,
  };
}

/**
 * Pull the workflow's JSON out of a response body that may have server noise in
 * front of it. Returns `payload: undefined` when there is no JSON at all.
 */
function extractPayload(body: string): { payload?: unknown; noise?: string } {
  const trimmed = body.trim();
  try {
    return { payload: JSON.parse(trimmed) };
  } catch {
    /* fall through to the salvage below */
  }

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch !== '[' && ch !== '{') continue;
    try {
      const payload: unknown = JSON.parse(trimmed.slice(i));
      return { payload, noise: trimmed.slice(0, i).trim() || undefined };
    } catch {
      /* not the start of the payload — keep looking */
    }
  }

  return {};
}

/**
 * The engine returns `output` as a list of rows, and the trigger merges
 * `jsCodes` / `workflow_log_id` into row 0. Some blocks hand back a bare
 * object, so accept both shapes.
 */
function firstRow(payload: unknown): AgentRow | null {
  if (Array.isArray(payload)) {
    return (payload.find((r) => r && typeof r === 'object') as AgentRow) ?? null;
  }
  if (payload && typeof payload === 'object') return payload as AgentRow;
  return null;
}

function describeStatus(status: number): string {
  switch (status) {
    case 404:
      return `No workflow with short code "${WORKFLOW_SHORTCODE}". Check the code, and that the workflow is not soft-deleted.`;
    case 401:
      return 'The trigger block is asking for credentials — auth_required is not "0" on this workflow.';
    case 417:
    case 498:
      return 'The trigger rejected the credential on this request.';
    case 302:
      return 'The platform redirected instead of running the workflow — usually an unknown short code with a live session.';
    default:
      return `The platform answered ${status}.`;
  }
}

/** AbortSignal.any, without relying on it being present. */
function anyOf(signals: AbortSignal[]): AbortSignal {
  const withAny = AbortSignal as typeof AbortSignal & {
    any?: (s: AbortSignal[]) => AbortSignal;
  };
  if (typeof withAny.any === 'function') return withAny.any(signals);

  const merged = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      merged.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => merged.abort(s.reason), { once: true });
  }
  return merged.signal;
}
