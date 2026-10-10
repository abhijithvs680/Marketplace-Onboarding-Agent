/**
 * The application record behind the console's progress bar and "Your
 * submission" panel.
 *
 * The workflow hands back prose and nothing else — `output[0].response` — so
 * the only honest way to light up the checklist is for the agent to say what it
 * captured. It does that with a marker block at the end of a reply:
 *
 *   [[vizru]]
 *   legal_entity: Molaris Dental Imaging Ltd
 *   primary_contact: Integration lead
 *   [[/vizru]]
 *
 * Deliberately brace-free. The workflow engine interpolates `{…}` inside
 * `system_prompt` and DELETES anything it cannot resolve, so a JSON example in
 * the system prompt would reach the model mangled. Square brackets and
 * `key: value` lines survive intact. A fenced JSON block tagged `vizru` is
 * accepted too, in case a model emits one anyway.
 *
 * Until the agent emits markers every field simply reads "Needed", which is
 * accurate — the client has not been told otherwise. See the README for the
 * system-prompt snippet that turns this on.
 */

export type StageId = 'company' | 'product' | 'integration' | 'review';

export interface Stage {
  id: StageId;
  label: string;
}

export const STAGES: Stage[] = [
  { id: 'company', label: 'Company profile' },
  { id: 'product', label: 'Product & features' },
  { id: 'integration', label: 'API & integration' },
  { id: 'review', label: 'Review & submit' },
];

export type FieldId =
  | 'legal_entity'
  | 'primary_contact'
  | 'feature_summary'
  | 'api_base_url'
  | 'auth_method'
  | 'sandbox_access';

export interface Field {
  id: FieldId;
  label: string;
  stage: StageId;
}

export const FIELDS: Field[] = [
  { id: 'legal_entity', label: 'Legal entity name', stage: 'company' },
  { id: 'primary_contact', label: 'Primary contact', stage: 'company' },
  { id: 'feature_summary', label: 'Feature summary', stage: 'product' },
  { id: 'api_base_url', label: 'API base URL', stage: 'integration' },
  { id: 'auth_method', label: 'Authentication method', stage: 'integration' },
  { id: 'sandbox_access', label: 'Sandbox access', stage: 'integration' },
];

/** Names a model might reasonably use instead of the canonical field id. */
const ALIASES: Record<string, FieldId> = {
  company: 'legal_entity',
  company_name: 'legal_entity',
  vendor_name: 'legal_entity',
  legal_name: 'legal_entity',
  entity: 'legal_entity',
  contact: 'primary_contact',
  primary_contact_name: 'primary_contact',
  technical_contact: 'primary_contact',
  features: 'feature_summary',
  feature_list: 'feature_summary',
  product_summary: 'feature_summary',
  api_url: 'api_base_url',
  base_url: 'api_base_url',
  api: 'api_base_url',
  auth: 'auth_method',
  authentication: 'auth_method',
  sandbox: 'sandbox_access',
  sandbox_credentials: 'sandbox_access',
};

export type Captured = Partial<Record<FieldId, string>>;

export interface SubmissionRecord {
  captured: Captured;
  submitted: boolean;
}

export const EMPTY_RECORD: SubmissionRecord = { captured: {}, submitted: false };

export interface ParsedReply {
  /** The reply with any marker block removed — what the viewer reads. */
  text: string;
  /** Fields this reply reported, in FIELDS order. */
  captured: Array<{ field: Field; value: string }>;
  submitted: boolean;
}

const BLOCK = /\[\[vizru\]\]([\s\S]*?)\[\[\/vizru\]\]/gi;
const FENCE = /```(?:vizru|json:vizru)\s*([\s\S]*?)```/gi;

export function parseAgentReply(raw: string): ParsedReply {
  const found: Captured = {};
  let submitted = false;
  let text = raw;

  text = text.replace(BLOCK, (_match, body: string) => {
    for (const line of body.split('\n')) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      const key = line.slice(0, at);
      const value = line.slice(at + 1);
      apply(found, key, value);
      if (isSubmittedKey(key, value)) submitted = true;
    }
    return '';
  });

  text = text.replace(FENCE, (match, body: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return match; // not ours — leave it for the viewer to see
    }
    if (!parsed || typeof parsed !== 'object') return '';
    const obj = parsed as Record<string, unknown>;
    const bag = (
      obj.captured && typeof obj.captured === 'object' ? obj.captured : obj
    ) as Record<string, unknown>;
    for (const [key, value] of Object.entries(bag)) {
      if (typeof value === 'string') apply(found, key, value);
    }
    if (obj.submitted === true) submitted = true;
    return '';
  });

  const captured = FIELDS.filter((f) => found[f.id]).map((f) => ({
    field: f,
    value: found[f.id] as string,
  }));

  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), captured, submitted };
}

function apply(bag: Captured, rawKey: string, rawValue: string): void {
  const key = rawKey.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const value = rawValue.trim().replace(/^["']|["']$/g, '');
  if (!value || value.toLowerCase() === 'null' || value.toLowerCase() === 'none') return;

  const id = (FIELDS.find((f) => f.id === key)?.id ?? ALIASES[key]) as FieldId | undefined;
  if (id) bag[id] = value;
}

function isSubmittedKey(rawKey: string, rawValue: string): boolean {
  return (
    rawKey.trim().toLowerCase() === 'submitted' &&
    /^(true|yes|1)$/i.test(rawValue.trim().replace(/^["']|["']$/g, ''))
  );
}

export function mergeRecord(prev: SubmissionRecord, reply: ParsedReply): SubmissionRecord {
  if (!reply.captured.length && !reply.submitted) return prev;
  const captured = { ...prev.captured };
  for (const { field, value } of reply.captured) captured[field.id] = value;
  return { captured, submitted: prev.submitted || reply.submitted };
}

export interface Progress {
  /** 1-based index into STAGES. */
  step: number;
  stage: Stage;
  done: number;
  total: number;
  stages: Array<{ stage: Stage; state: 'done' | 'current' | 'todo' }>;
}

export function progressOf(record: SubmissionRecord): Progress {
  const complete = (id: StageId) =>
    FIELDS.filter((f) => f.stage === id).every((f) => Boolean(record.captured[f.id]));

  const stageDone: Record<StageId, boolean> = {
    company: complete('company'),
    product: complete('product'),
    integration: complete('integration'),
    review: record.submitted,
  };

  const currentIndex = STAGES.findIndex((s) => !stageDone[s.id]);
  const step = currentIndex === -1 ? STAGES.length : currentIndex + 1;

  return {
    step,
    stage: STAGES[step - 1],
    done: FIELDS.filter((f) => record.captured[f.id]).length,
    total: FIELDS.length,
    stages: STAGES.map((stage, i) => ({
      stage,
      state: stageDone[stage.id] ? 'done' : i === step - 1 ? 'current' : 'todo',
    })),
  };
}

export function isComplete(record: SubmissionRecord): boolean {
  return FIELDS.every((f) => Boolean(record.captured[f.id]));
}

/** Plain-text copy of the application, for download and for a mailto body. */
export function summaryText(record: SubmissionRecord): string {
  const lines = ['Vizru Partner Onboarding — application summary', ''];
  for (const stage of STAGES) {
    const fields = FIELDS.filter((f) => f.stage === stage.id);
    if (!fields.length) continue;
    lines.push(stage.label.toUpperCase());
    for (const field of fields) {
      lines.push(`  ${field.label}: ${record.captured[field.id] ?? '[not yet provided]'}`);
    }
    lines.push('');
  }
  lines.push(record.submitted ? 'Status: submitted' : 'Status: draft — not yet submitted');
  return lines.join('\n');
}
