/**
 * The application record behind the console's stage rail and "Your submission"
 * panel.
 *
 * The record is **server-driven**: `MarketPlaceOnboard_GetApplication` reads
 * VendorOnboardingSessions, Vendors, VendorFeatures and VendorApiInfo and
 * answers with the shape in `ApplicationState`. `recordOf` maps that answer
 * onto the fields the UI shows, and `capturedSince` is the per-turn diff the
 * conversation renders as "Added to your submission".
 *
 * Nothing here parses the agent's prose. The agent writes through its tools
 * (`create_vendor`, `submit_application`) and the client reads the result back,
 * so the checklist reflects what the platform actually stored rather than what
 * a reply claimed.
 */

import type { ApplicationState } from './vizru';

export type StageId = 'company' | 'product' | 'regulatory' | 'commercial' | 'integration' | 'review';

export interface Stage {
  id: StageId;
  label: string;
}

export const STAGES: Stage[] = [
  { id: 'company', label: 'Company & contact' },
  { id: 'product', label: 'Product & capabilities' },
  { id: 'regulatory', label: 'Regulatory & patient data' },
  { id: 'commercial', label: 'Commercial terms' },
  { id: 'integration', label: 'Integration' },
  { id: 'review', label: 'Review & submit' },
];

export type FieldId =
  | 'legal_entity'
  | 'primary_contact'
  | 'country'
  | 'product_name'
  | 'product_category'
  | 'feature_summary'
  | 'regulatory_status'
  | 'patient_data'
  | 'pricing_model'
  | 'contract_term'
  | 'support_hours'
  | 'api_base_url'
  | 'auth_method';

export interface Field {
  id: FieldId;
  label: string;
  stage: StageId;
}

export const FIELDS: Field[] = [
  { id: 'legal_entity', label: 'Legal entity', stage: 'company' },
  { id: 'primary_contact', label: 'Primary contact', stage: 'company' },
  { id: 'country', label: 'Country of registration', stage: 'company' },
  { id: 'product_name', label: 'Product name', stage: 'product' },
  { id: 'product_category', label: 'Product category', stage: 'product' },
  { id: 'feature_summary', label: 'Capabilities', stage: 'product' },
  { id: 'regulatory_status', label: 'Regulatory status', stage: 'regulatory' },
  { id: 'patient_data', label: 'Patient data handling', stage: 'regulatory' },
  { id: 'pricing_model', label: 'Pricing model', stage: 'commercial' },
  { id: 'contract_term', label: 'Contract term', stage: 'commercial' },
  { id: 'support_hours', label: 'Support hours', stage: 'commercial' },
  { id: 'api_base_url', label: 'API base URL', stage: 'integration' },
  { id: 'auth_method', label: 'Authentication method', stage: 'integration' },
];

export type Captured = Partial<Record<FieldId, string>>;

export interface SubmissionRecord {
  captured: Captured;
  submitted: boolean;
  /** The human reference from the platform, once StartSession has minted it. */
  reference?: string;
  /** The vendor row's id, once `create_vendor` has run. */
  vendorId?: string;
}

export const EMPTY_RECORD: SubmissionRecord = { captured: {}, submitted: false };

/* ------------------------------------------------- the platform's read model */

/** Map a GetApplication response onto the record the UI renders. */
export function recordOf(state: ApplicationState, previous?: SubmissionRecord): SubmissionRecord {
  if (state.status === 'new') {
    // The platform has never seen this session. Keep the reference we were
    // given at startSession; there is nothing else to show yet.
    return { captured: {}, submitted: false, reference: previous?.reference };
  }

  const captured: Captured = {};
  const set = (id: FieldId, value?: string) => {
    const trimmed = value?.trim();
    if (trimmed) captured[id] = trimmed;
  };

  set('legal_entity', state.vendor?.legal_entity);
  set('primary_contact', state.vendor?.primary_contact);
  set('country', state.intake?.country);
  set('product_name', state.intake?.product_name);
  set('product_category', state.intake?.product_category);
  set('regulatory_status', state.intake?.regulatory_status);
  set('patient_data', state.intake?.patient_data_handled);
  set('pricing_model', state.intake?.pricing_model);
  set('contract_term', state.intake?.contract_term);
  set('support_hours', state.intake?.support_hours);

  const features = (state.features ?? [])
    .map((f) => f.feature?.trim())
    .filter((f): f is string => Boolean(f));
  set('feature_summary', features.join(', '));

  // Sandbox is the environment the integration stage asks about; fall back to
  // whatever single environment the vendor gave.
  const api = state.api ?? [];
  const sandbox = api.find((row) => row.environment?.trim().toLowerCase() === 'sandbox');
  const environment = sandbox ?? api[0];

  set('api_base_url', environment?.base_url);
  set('auth_method', environment?.auth_method);

  return {
    captured,
    submitted: state.status === 'submitted',
    reference: state.reference ?? previous?.reference,
    vendorId: state.vendor?.vendor_id ?? previous?.vendorId,
  };
}

/**
 * What this turn added, as the difference between two reads of the application.
 * Returned in FIELDS order so the card reads in the order the panel lists.
 */
export function capturedSince(
  before: SubmissionRecord,
  after: SubmissionRecord,
): Array<{ field: Field; value: string }> {
  return FIELDS.filter((f) => {
    const value = after.captured[f.id];
    return Boolean(value) && value !== before.captured[f.id];
  }).map((field) => ({ field, value: after.captured[field.id] as string }));
}

/* -------------------------------------------------------------- progress, io */

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
    regulatory: complete('regulatory'),
    commercial: complete('commercial'),
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
  const lines = ['Dental Marketplace — vendor application summary', ''];
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
