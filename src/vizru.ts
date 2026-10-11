/**
 * Vizru client — one transport, several workflows.
 *
 *   POST /workflow.trigger/<shortCode>
 *
 * Because every workflow this app calls has a trigger entry block in the
 * 4200-4205 range with auth_required = "0", the calls are fully public: no
 * bearer, no hashtoken, no session cookie. Each run executes as the uid stored
 * on its entry block.
 *
 * Three workflows are in play:
 *
 *   VITE_VIZRU_WORKFLOW       the agent — Entry (genericpost) -> Agent Node.
 *                             Reads prompt = {Entry.message} and
 *                             thread_id = {Entry.session_id}, so the body must
 *                             carry exactly those two fields. memory = "true"
 *                             plus a thread_id is what turns on the agent's
 *                             transcript, which is why the session id has to be
 *                             stable across turns.
 *   VITE_VIZRU_WORKFLOW_START MarketPlaceOnboard_StartSession — mints the row in
 *                             VendorOnboardingSessions and the reference.
 *   VITE_VIZRU_WORKFLOW_GET   MarketPlaceOnboard_GetApplication — the read model
 *                             behind the stage rail, the submission panel and
 *                             the review page.
 *
 * The two new ones end in a `customoutput` block with outputDataType = json, so
 * the trigger returns `outData` verbatim — an object, not the engine's row
 * array. `callWorkflow` accepts either shape.
 */

const BASE = (import.meta.env.VITE_VIZRU_BASE_URL ?? '').replace(/\/+$/, '');

export const WORKFLOW_SHORTCODE =
  import.meta.env.VITE_VIZRU_WORKFLOW ?? 'marketplaceonboardagent6aca3281a3e51';

/** Part B workflows. Empty until the short code is recorded in `.env`. */
export const START_SHORTCODE = (import.meta.env.VITE_VIZRU_WORKFLOW_START ?? '').trim();
export const GET_SHORTCODE = (import.meta.env.VITE_VIZRU_WORKFLOW_GET ?? '').trim();
export const MESSAGES_SHORTCODE = (import.meta.env.VITE_VIZRU_WORKFLOW_MESSAGES ?? '').trim();

const TIMEOUT_MS = Number(import.meta.env.VITE_VIZRU_TIMEOUT_MS ?? 180_000);

/** The read and write workflows are a round trip to Mongo, not a provider call. */
const QUICK_TIMEOUT_MS = 20_000;

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

interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The shared transport. Everything the app knows about the platform lives here:
 * the single header, the salvage around server noise, the status-code mapping,
 * and the rule that a 200 is not a success.
 */
export async function callWorkflow(
  shortCode: string,
  body: Record<string, unknown>,
  { signal, timeoutMs = TIMEOUT_MS }: CallOptions = {},
): Promise<unknown> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const abort = signal ? anyOf([signal, timeout.signal]) : timeout.signal;

  let res: Response;
  try {
    res = await fetch(`${BASE}/workflow.trigger/${shortCode}`, {
      method: 'POST',
      // Content-Type: application/json already forces a preflight, and
      // Trigger.php answers OPTIONS with
      //   Access-Control-Allow-Headers: hashtoken, auth_token, bearer,
      //                                 Authorization, Content-Type
      // Adding anything outside that list (X-Requested-With, for instance)
      // fails the preflight, so this is the complete header set.
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort,
    });
  } catch (err) {
    clearTimeout(timer);
    if (signal?.aborted) throw err;
    if (timeout.signal.aborted) {
      throw new VizruError(
        `The platform did not answer within ${Math.round(timeoutMs / 1000)}s. It may still be working — try again, or check the workflow log.`,
      );
    }
    throw new VizruError(
      'Could not reach the Vizru platform. Is it running, and is this origin in the trigger CORS allow-list?',
    );
  }
  clearTimeout(timer);

  const text = await res.text();

  if (!res.ok) {
    throw new VizruError(describeStatus(res.status, shortCode), {
      status: res.status,
      body: text,
    });
  }

  // A 200 only means the engine ran the graph. A workflow that threw comes back
  // 200 with the literal body "Internal Server Error", so parse before trusting.
  const { payload, noise } = extractPayload(text);

  // A block that fails mid-run echoes its error straight into the output stream,
  // so the body arrives as `<div class="alert">…</div>[{…}]`. The vendor sees the
  // agent's answer; the developer gets the server's complaint in the console.
  if (noise) {
    console.warn(`[vizru] ${shortCode} emitted an error before its JSON:
${noise}`);
  }

  if (payload === undefined) {
    throw new VizruError(
      /internal server error/i.test(text)
        ? 'The workflow threw while running. Check VizWorkflowLog for the failing block.'
        : 'The platform returned something that was not JSON.',
      { status: res.status, body: text },
    );
  }

  return payload;
}

export async function runOnboardingAgent({
  message,
  sessionId,
  signal,
}: RunOptions): Promise<AgentReply> {
  const payload = await callWorkflow(
    WORKFLOW_SHORTCODE,
    { message, session_id: sessionId },
    { signal },
  );

  const row = firstRow(payload) as AgentRow | null;
  if (!row) throw new VizruError('The workflow returned no rows.');

  const text = typeof row.response === 'string' ? row.response.trim() : '';
  if (!text) {
    throw new VizruError(
      'The Agent Node returned an empty response. The provider call most likely failed — the error text lands inside `response`.',
    );
  }

  return {
    text,
    provider: row.provider,
    model: row.model,
    workflowLogId: row.workflow_log_id,
  };
}

/* ---------------------------------------------------------------- read model */

export interface ApplicationVendor {
  vendor_id?: string;
  legal_entity?: string;
  primary_contact?: string;
}

export interface ApplicationFeature {
  feature?: string;
  description?: string;
}

export interface ApplicationApi {
  environment?: string;
  base_url?: string;
  auth_method?: string;
  docs_url?: string;
  technical_contact?: string;
  notes?: string;
}

/** The documented response of MarketPlaceOnboard_GetApplication. */
export interface ApplicationState {
  ok: boolean;
  /** `new` for a session the platform has never seen. */
  status?: 'new' | 'draft' | 'submitted' | string;
  stage?: string;
  reference?: string;
  vendor?: ApplicationVendor;
  features?: ApplicationFeature[];
  api?: ApplicationApi[];
}

/**
 * Register the session on the platform and mint its reference.
 *
 * Returns `null` when VITE_VIZRU_WORKFLOW_START is not configured, so the app
 * still runs against the agent alone while Part B of the build plan is in
 * flight. The caller treats that as "no reference yet", never as an error.
 */
export async function startSession(
  sessionId: string,
  options: CallOptions = {},
): Promise<{ reference?: string } | null> {
  if (!START_SHORTCODE) return null;

  const payload = await callWorkflow(
    START_SHORTCODE,
    { session_id: sessionId },
    { timeoutMs: QUICK_TIMEOUT_MS, ...options },
  );
  const row = asRecord(firstRow(payload));
  if (!row) throw new VizruError('StartSession returned no rows.');
  if (row.ok === false) {
    throw new VizruError(str(row.error) ?? 'StartSession declined to open the session.');
  }

  return { reference: str(row.reference) };
}

/**
 * Ask the platform what the state of this application is.
 *
 * Returns `null` when VITE_VIZRU_WORKFLOW_GET is not configured. An unknown
 * session is not an error: the workflow answers 200 with
 * `{"ok": true, "status": "new"}`, which maps to an empty application.
 */
export async function getApplication(
  sessionId: string,
  options: CallOptions = {},
): Promise<ApplicationState | null> {
  if (!GET_SHORTCODE) return null;

  const payload = await callWorkflow(
    GET_SHORTCODE,
    { session_id: sessionId },
    { timeoutMs: QUICK_TIMEOUT_MS, ...options },
  );
  const row = asRecord(firstRow(payload));
  if (!row) throw new VizruError('GetApplication returned no rows.');
  if (row.ok === false) {
    throw new VizruError(str(row.error) ?? 'GetApplication could not read the application.');
  }

  return {
    ok: true,
    status: str(row.status) ?? 'draft',
    stage: str(row.stage),
    reference: str(row.reference),
    ...flatten(row),
  };
}

/**
 * GetApplication answers one flat row, not a nested object.
 *
 * That is deliberate: a `customoutput` block has to build its JSON as a
 * template, and the engine strips `{...}` it cannot resolve — which eats the
 * braces of the JSON itself and returns `null`. Ending the workflow on a
 * `setvariable` instead lets the engine encode the response, so the shape is
 * flat and reliable. A nested `vendor` / `features` / `api` is still accepted,
 * for when the workflow grows a real composer.
 */
function flatten(row: Record<string, unknown>): Pick<ApplicationState, 'vendor' | 'features' | 'api'> {
  const vendor = (asRecord(row.vendor) as ApplicationVendor | undefined) ?? {
    vendor_id: str(row.vendor_id),
    legal_entity: str(row.legal_entity),
    primary_contact: str(row.primary_contact),
  };

  const features = asRows(row.features) as ApplicationFeature[];
  const api = asRows(row.api) as ApplicationApi[];

  const feature = str(row.feature);
  const environment = str(row.environment);
  const baseUrl = str(row.base_url);
  const authMethod = str(row.auth_method);

  return {
    vendor,
    features: features.length ? features : feature ? [{ feature }] : [],
    api:
      api.length
        ? api
        : environment || baseUrl || authMethod
          ? [{ environment, base_url: baseUrl, auth_method: authMethod }]
          : [],
  };
}

/** One stored turn of the conversation, as MarketPlaceOnboard_GetMessages returns it. */
export interface TranscriptTurn {
  role: 'user' | 'agent' | string;
  message: string;
}

/**
 * The conversation as the platform holds it.
 *
 * The agent workflow writes both sides of every turn to
 * VendorOnboardingMessages, so a vendor who returns on another machine still
 * sees the history — `localStorage` only ever covered the same browser.
 * Returns `null` when the workflow is not configured.
 */
export async function getMessages(
  sessionId: string,
  options: CallOptions = {},
): Promise<TranscriptTurn[] | null> {
  if (!MESSAGES_SHORTCODE) return null;

  const payload = await callWorkflow(
    MESSAGES_SHORTCODE,
    { session_id: sessionId },
    { timeoutMs: QUICK_TIMEOUT_MS, ...options },
  );

  return asRows(payload)
    .map((row) => ({ role: str(row.role) ?? '', message: str(row.message) ?? '' }))
    .filter((turn) => turn.message && (turn.role === 'user' || turn.role === 'agent'));
}

/* -------------------------------------------------------------------- shapes */

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
 * A `customoutput` block returns its `outData` verbatim, so the payload is a
 * bare object. Without one the engine returns `output` as a list of rows, and
 * the trigger merges `jsCodes` / `workflow_log_id` into row 0. Accept both.
 */
function firstRow(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) {
    return (payload.find((r) => r && typeof r === 'object') as Record<string, unknown>) ?? null;
  }
  return asRecord(payload) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A spreadsheet filter that matched nothing can come back as `null`, `""` or a
 * single object rather than an empty array. Normalise all four.
 */
function asRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((row): row is Record<string, unknown> => Boolean(asRecord(row)));
  }
  const row = asRecord(value);
  return row ? [row] : [];
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed && !/^(null|undefined)$/i.test(trimmed) ? trimmed : undefined;
  }
  if (typeof value === 'number') return String(value);
  return undefined;
}

function describeStatus(status: number, shortCode: string): string {
  switch (status) {
    case 404:
      return `No workflow with short code "${shortCode}". Check the code, and that the workflow is not soft-deleted.`;
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
